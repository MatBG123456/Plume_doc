//! Agent de chat (Claude Code local, UNIQUE provider).
//!
//! La command [`chat_send`] délègue **exclusivement** au binaire `claude` que
//! l'utilisateur a installé/authentifié (`claude -p --output-format stream-json`).
//! Le modèle répond par une brève prose **puis** un bloc ```json {"ops":[…]}``` ;
//! chaque op est validée et appliquée par le **même** pipeline pur
//! `plume_core::apply` que l'édition directe. Aucune voie API/clé n'est exposée.
//!
//! Events émis vers le front : `assistant_text` (prose au fil du flux),
//! `op_applied` (op appliquée + nouveau document, preview live),
//! `assistant_done`, `chat_error`.

use std::process::Stdio;

use plume_core::{apply, Document, Node, Op};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::Shared;

/// Un message de conversation : `role` + `content` = tableau de blocs `text`
/// (`{"type":"text","text":…}`). Seul le texte est conservé.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Value,
}

/// Document fourni en contexte au chat (joint par l'utilisateur).
#[derive(Debug, Clone, Deserialize)]
pub struct Attachment {
    pub name: String,
    pub text: String,
}

// ---------------------------------------------------------------------------
// Application d'un outil via le pipeline pur (mutation du document partagé)
// ---------------------------------------------------------------------------

/// Applique une `Op` validée (émise par l'agent) au document partagé et émet
/// `op_applied` (preview live côté front).
fn apply_validated_op(app: &AppHandle, state: &Shared, op: Op, label: &str) -> Result<(), String> {
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    match apply(&mut s.doc, op) {
        Ok(inverse) => {
            s.undo.push(inverse);
            s.redo.clear();
            s.last_edit = None; // op agent discrète : pas de coalescing avec la frappe
            let doc = s.doc.clone();
            drop(s); // ne jamais tenir le verrou pendant l'émission/await
            let _ = app.emit("op_applied", json!({ "doc": doc, "op": label }));
            Ok(())
        }
        Err(e) => {
            drop(s);
            Err(e.reason)
        }
    }
}

fn emit_error(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit("chat_error", json!({ "message": message.into() }));
}

// ---------------------------------------------------------------------------
// Agent : Claude Code local (UNIQUE provider)
// ---------------------------------------------------------------------------
//
// Le chat délègue **exclusivement** au binaire `claude` que l'utilisateur a
// lui-même installé et authentifié : la consommation passe par SON auth
// (abonnement ou sa propre clé). Il n'y a aucune autre voie (pas de clé API ni de
// sélecteur). ⚠️ Conformité : router des requêtes via un abonnement Pro/Max est
// encadré par les CGU d'Anthropic (usage interactif) — à chacun de vérifier la
// conformité de son usage.

/// Disponibilité de l'agent (le binaire `claude` est-il présent ?).
#[derive(Debug, Serialize)]
pub struct ChatProviders {
    pub claude_cli: bool,
}

/// Noms de binaire à essayer. Sous Windows, une install npm de Claude Code crée
/// des shims `claude.cmd` / `claude.ps1` (pas de `.exe`).
fn claude_candidates() -> &'static [&'static str] {
    if cfg!(windows) {
        &[
            "claude.exe",
            "claude.cmd",
            "claude.bat",
            "claude.ps1",
            "claude",
        ]
    } else {
        &["claude"]
    }
}

/// Localise le binaire `claude` : override `PLUME_CLAUDE_BIN`, puis `~/.local/bin`,
/// puis le `PATH` (en essayant chaque nom candidat).
fn find_claude() -> Option<std::path::PathBuf> {
    if let Ok(p) = std::env::var("PLUME_CLAUDE_BIN") {
        let pb = std::path::PathBuf::from(p);
        if pb.is_file() {
            return Some(pb);
        }
    }
    if let Some(home) = std::env::var_os("HOME").or_else(|| std::env::var_os("USERPROFILE")) {
        let bin = std::path::Path::new(&home).join(".local").join("bin");
        for name in claude_candidates() {
            let pb = bin.join(name);
            if pb.is_file() {
                return Some(pb);
            }
        }
    }
    if let Some(path) = std::env::var_os("PATH") {
        for dir in std::env::split_paths(&path) {
            for name in claude_candidates() {
                let pb = dir.join(name);
                if pb.is_file() {
                    return Some(pb);
                }
            }
        }
    }
    None
}

/// Commande pour lancer `claude`, en passant par `cmd.exe` / `powershell` pour les
/// shims `.cmd`/`.bat`/`.ps1` (que `CreateProcess` ne lance pas directement).
fn claude_command(path: &std::path::Path) -> tokio::process::Command {
    let ext = path
        .extension()
        .and_then(|e| e.to_str())
        .map(|e| e.to_ascii_lowercase());
    match ext.as_deref() {
        Some("cmd") | Some("bat") => {
            let mut c = tokio::process::Command::new("cmd");
            c.arg("/C").arg(path);
            c
        }
        Some("ps1") => {
            let mut c = tokio::process::Command::new("powershell");
            c.arg("-NoProfile")
                .arg("-ExecutionPolicy")
                .arg("Bypass")
                .arg("-File")
                .arg(path);
            c
        }
        _ => tokio::process::Command::new(path),
    }
}

/// Détecte si l'agent est disponible (binaire `claude` installé ?).
#[tauri::command]
pub fn detect_chat_providers() -> ChatProviders {
    ChatProviders {
        claude_cli: find_claude().is_some(),
    }
}

/// Description concise des ops pour le prompt CLI (le modèle répond en JSON brut).
const OPS_HELP: &str = r##"Chaque op est un objet JSON avec un champ "op" :
- {"op":"InsertBlock","at":<int>,"block":{"id":"<id unique nouveau>","node":<Node>}}
- {"op":"DeleteBlock","id":"<id>"}
- {"op":"MoveBlock","id":"<id>","to":<int>}
- {"op":"SetNode","id":"<id>","node":<Node>}
- {"op":"SetRuns","id":"<id>","runs":[<Run>]}
- {"op":"ApplyMark","id":"<id>","range":[<début>,<fin>],"mark":<MarkPatch>}
- {"op":"SetTableCell","id":"<id>","row":<int>,"col":<int>,"runs":[<Run>]}
- {"op":"SetMeta","title":<string|null>,"lang":<string|null>}
Node (clé "type") : Paragraph{runs} | Heading{level 1..6, runs} | ListItem{ordered, level 0..5, runs} | Quote{runs} | CodeBlock{lang(string|null), text} | Table{rows:[[Cell]]} | Image{src, alt, width_pct(int|null)} | PageBreak.
Run : {"text":string,"marks":{"bold":bool,"italic":bool,"underline":bool,"strike":bool,"code":bool,"link":string|null,"color":"#RRGGBB"|null}}.
Cell : {"runs":[Run]}. MarkPatch : champs optionnels bold/italic/underline/strike/code (bool), link/color (string ou null=effacer).
range d'ApplyMark = [début, fin) en caractères du texte concaténé des runs du bloc."##;

/// Texte d'un message (blocs `text`), préfixé par le rôle ; `None` si vide.
/// Seuls les blocs `text` comptent : le **document courant** (injecté dans le
/// prompt) reste la source de vérité du contexte.
fn message_text(m: &ChatMessage) -> Option<String> {
    let text: String = m
        .content
        .as_array()?
        .iter()
        .filter(|b| b["type"] == "text")
        .filter_map(|b| b["text"].as_str())
        .collect::<Vec<_>>()
        .join("");
    if text.trim().is_empty() {
        return None;
    }
    let who = if m.role == "assistant" {
        "Assistant"
    } else {
        "Utilisateur"
    };
    Some(format!("{who}: {text}"))
}

/// Texte brut d'un bloc (pour l'aperçu du focus), ou un libellé pour les blocs non textuels.
fn node_plain_text(node: &Node) -> String {
    match node {
        Node::Paragraph { runs }
        | Node::Heading { runs, .. }
        | Node::ListItem { runs, .. }
        | Node::Quote { runs } => runs.iter().map(|r| r.text.as_str()).collect(),
        Node::CodeBlock { text, .. } => text.clone(),
        Node::Table { .. } => "[tableau]".to_string(),
        Node::Image { alt, .. } => format!("[image : {alt}]"),
        Node::PageBreak => "[saut de page]".to_string(),
    }
}

/// Indice de focus : « id=\"…\" (« aperçu… ») » si le bloc ciblé existe.
fn focus_hint(doc: &Document, id: &str) -> Option<String> {
    let block = doc.blocks.iter().find(|b| b.id.0.as_str() == id)?;
    let text = node_plain_text(&block.node);
    let preview: String = text.chars().take(120).collect();
    let ell = if text.chars().count() > 120 {
        "…"
    } else {
        ""
    };
    Some(format!("id=\"{id}\" (« {preview}{ell} »)"))
}

/// Construit le prompt unique envoyé à `claude -p`. `focus` = id de bloc ciblé
/// par l'utilisateur (priorité) ; `attachments` = documents fournis en contexte.
fn build_cli_prompt(
    doc: &Document,
    messages: &[ChatMessage],
    focus: Option<&str>,
    attachments: &[Attachment],
) -> String {
    let doc_json = serde_json::to_string_pretty(doc).unwrap_or_default();
    let transcript = messages
        .iter()
        .filter_map(message_text)
        .collect::<Vec<_>>()
        .join("\n");
    let focus_section = focus
        .and_then(|id| focus_hint(doc, id))
        .map(|h| {
            format!(
                "\n\nPRIORITÉ — l'utilisateur cible ce bloc : {h}\n\
Concentre tes modifications sur ce bloc en priorité (sauf si la demande implique clairement d'autres blocs)."
            )
        })
        .unwrap_or_default();
    let context_section = if attachments.is_empty() {
        String::new()
    } else {
        let mut s = String::from(
            "\n\nDOCUMENTS FOURNIS EN CONTEXTE par l'utilisateur (référence ; n'édite le document \
courant que si la demande l'implique) :",
        );
        for a in attachments {
            s.push_str(&format!("\n\n--- {} ---\n{}", a.name, a.text));
        }
        s
    };
    format!(
        "Tu es l'assistant d'édition de Plume, un éditeur de documents. Tu modifies le document \
UNIQUEMENT en émettant des opérations. Cible les blocs existants par leur `id` ; pour InsertBlock, \
génère un id unique nouveau.\n\n\
Réponds EXACTEMENT dans cet ordre :\n\
1) une phrase brève en français décrivant ce que tu fais (ou ta réponse à la demande) ;\n\
2) puis, sur une NOUVELLE ligne, un bloc de code ```json contenant {{\"ops\": [<op>, ...]}} \
(liste vide si aucune édition). N'écris RIEN après ce bloc.\n\n\
{OPS_HELP}\n\n\
Document actuel (JSON) :\n{doc_json}{focus_section}{context_section}\n\n\
Conversation :\n{transcript}"
    )
}

/// Extrait le premier objet JSON équilibré d'une chaîne (tolère prose/fences autour).
fn extract_json_object(s: &str) -> Option<&str> {
    let start = s.find('{')?;
    let mut depth = 0i32;
    let mut in_str = false;
    let mut esc = false;
    for (i, c) in s[start..].char_indices() {
        if in_str {
            if esc {
                esc = false;
            } else if c == '\\' {
                esc = true;
            } else if c == '"' {
                in_str = false;
            }
        } else {
            match c {
                '"' => in_str = true,
                '{' => depth += 1,
                '}' => {
                    depth -= 1;
                    if depth == 0 {
                        return Some(&s[start..start + i + c.len_utf8()]);
                    }
                }
                _ => {}
            }
        }
    }
    None
}

/// Extrait le texte d'un delta du flux `stream-json` (formes tolérées).
fn delta_text(v: &Value) -> Option<&str> {
    v.get("event")
        .and_then(|e| e.get("delta"))
        .and_then(|d| d.get("text"))
        .and_then(|t| t.as_str())
        .or_else(|| {
            v.get("delta")
                .and_then(|d| d.get("text"))
                .and_then(|t| t.as_str())
        })
}

/// Provider CLI : appelle `claude` en **streaming** (NDJSON), émet le texte au fil
/// de l'eau et applique les ops du bloc JSON final. `model` (alias `sonnet`/…) et
/// `effort` (low/medium/high/xhigh/max) sont passés au CLI s'ils sont fournis.
async fn run_cli_agent(
    app: AppHandle,
    state: &Shared,
    mut messages: Vec<ChatMessage>,
    model: String,
    effort: String,
    focus: Option<String>,
    attachments: Vec<Attachment>,
) -> Vec<ChatMessage> {
    let claude = match find_claude() {
        Some(p) => p,
        None => {
            emit_error(
                &app,
                "Claude Code (`claude`) introuvable. Installe-le et relance.",
            );
            return messages;
        }
    };

    let doc = {
        let s = state.lock().unwrap_or_else(|e| e.into_inner());
        s.doc.clone()
    };
    let prompt = build_cli_prompt(&doc, &messages, focus.as_deref(), &attachments);

    // Streaming : sortie NDJSON lue ligne par ligne. `claude -p` lit le prompt sur
    // stdin (évite les limites de longueur d'argument).
    let mut cmd = claude_command(&claude);
    cmd.arg("-p")
        .arg("--output-format")
        .arg("stream-json")
        .arg("--verbose")
        .arg("--include-partial-messages");
    if !model.trim().is_empty() {
        cmd.arg("--model").arg(model.trim());
    }
    if !effort.trim().is_empty() {
        cmd.arg("--effort").arg(effort.trim());
    }
    cmd.stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            emit_error(&app, format!("échec du lancement de claude : {e}"));
            return messages;
        }
    };

    // stdin écrit dans une tâche dédiée (anti inter-blocage avec le drain stdout).
    if let Some(mut stdin) = child.stdin.take() {
        tokio::spawn(async move {
            let _ = stdin.write_all(prompt.as_bytes()).await;
            let _ = stdin.shutdown().await; // EOF
        });
    }
    // stderr drainé en tâche (pour le pipe + un message d'erreur éventuel).
    let stderr_task = tokio::spawn({
        let stderr = child.stderr.take();
        async move {
            let mut s = String::new();
            if let Some(mut se) = stderr {
                let _ = se.read_to_string(&mut s).await;
            }
            s
        }
    });

    let stdout = match child.stdout.take() {
        Some(o) => o,
        None => {
            emit_error(&app, "claude : sortie indisponible.");
            return messages;
        }
    };

    // Lit le flux : émet la PROSE en direct (jusqu'au bloc ```), accumule tout,
    // et capture le `result` final (texte complet fiable).
    let mut lines = BufReader::new(stdout).lines();
    let mut streamed = String::new();
    let mut emitted = 0usize;
    let mut prose_emitted = false;
    let mut fence_hit = false;
    let mut result_text = String::new();
    while let Ok(Some(line)) = lines.next_line().await {
        let v: Value = match serde_json::from_str(&line) {
            Ok(v) => v,
            Err(_) => continue,
        };
        if let Some(delta) = delta_text(&v) {
            streamed.push_str(delta);
            if !fence_hit {
                if let Some(i) = streamed.find("```") {
                    if i > emitted {
                        let _ =
                            app.emit("assistant_text", json!({ "text": &streamed[emitted..i] }));
                        prose_emitted = true;
                    }
                    fence_hit = true;
                    emitted = streamed.len();
                } else {
                    let _ = app.emit("assistant_text", json!({ "text": &streamed[emitted..] }));
                    prose_emitted = true;
                    emitted = streamed.len();
                }
            }
        }
        if let Some(r) = v.get("result").and_then(|r| r.as_str()) {
            result_text = r.to_string();
        }
    }

    let status = child.wait().await;
    let stderr_out = stderr_task.await.unwrap_or_default();

    if !matches!(&status, Ok(s) if s.success()) {
        let code = status.ok().and_then(|s| s.code());
        let detail = if !stderr_out.trim().is_empty() {
            stderr_out.trim().chars().take(400).collect::<String>()
        } else {
            streamed.chars().take(400).collect::<String>()
        };
        emit_error(
            &app,
            format!("claude a renvoyé une erreur (code {code:?}) : {detail}"),
        );
        return messages;
    }

    // Texte canonique : le `result` final s'il existe, sinon le flux accumulé.
    let full = if result_text.is_empty() {
        streamed.clone()
    } else {
        result_text
    };

    // Prose = texte avant le bloc ```json (ou avant le 1er objet JSON).
    let prose: String = if let Some(i) = full.find("```") {
        full[..i].trim().to_string()
    } else if let Some(j) = full.find('{') {
        full[..j].trim().to_string()
    } else {
        full.trim().to_string()
    };

    // Ops : le bloc {"ops":[...]} (1er objet JSON équilibré). Best-effort.
    let mut applied = 0usize;
    let mut errors: Vec<String> = Vec::new();
    if let Some(ops) = extract_json_object(&full)
        .and_then(|j| serde_json::from_str::<Value>(j).ok())
        .and_then(|v| v.get("ops").cloned())
        .and_then(|o| o.as_array().cloned())
    {
        for op_val in &ops {
            match serde_json::from_value::<Op>(op_val.clone()) {
                Ok(op) => match apply_validated_op(&app, state, op, "cli") {
                    Ok(()) => applied += 1,
                    Err(reason) => errors.push(reason),
                },
                Err(e) => errors.push(format!("op illisible : {e}")),
            }
        }
    }
    if !errors.is_empty() {
        emit_error(
            &app,
            format!(
                "{applied} op(s) appliquée(s), {} refusée(s) : {}",
                errors.len(),
                errors.join(" ; ")
            ),
        );
    }

    // Message affiché : la prose, sinon un libellé si des ops, sinon rien.
    let final_text = if !prose.is_empty() {
        prose
    } else if applied > 0 {
        "Modifications appliquées.".to_string()
    } else {
        String::new()
    };
    // Si rien n'a été streamé en direct, on émet le texte final pour l'affichage.
    if !prose_emitted && !final_text.is_empty() {
        let _ = app.emit("assistant_text", json!({ "text": &final_text }));
    }
    let _ = app.emit("assistant_done", json!({}));
    if !final_text.is_empty() {
        messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: json!([{ "type": "text", "text": final_text }]),
        });
    }
    messages
}

/// Pose `agent_busy=true` et le remet à `false` en sortie de portée — y compris
/// en cas d'erreur ou de panique d'un tour d'agent (sinon `set_document` resterait
/// bloqué indéfiniment et plus aucune bascule d'onglet ne serait possible).
struct BusyGuard<'a>(&'a Shared);

impl Drop for BusyGuard<'_> {
    fn drop(&mut self) {
        let mut s = self.0.lock().unwrap_or_else(|e| e.into_inner());
        s.agent_busy = false;
    }
}

/// Command : exécute un tour d'assistant via **Claude Code local** — le seul
/// provider — et renvoie l'historique mis à jour.
#[tauri::command]
pub async fn chat_send(
    messages: Vec<ChatMessage>,
    model: String,
    effort: String,
    focus: Option<String>,
    attachments: Option<Vec<Attachment>>,
    app: AppHandle,
    state: tauri::State<'_, Shared>,
) -> Result<Vec<ChatMessage>, String> {
    let shared = state.inner();
    // Verrou « tour en vol » : empêche `set_document` (bascule d'onglet) de muter
    // le document pendant que l'agent applique ses ops.
    {
        let mut s = shared.lock().unwrap_or_else(|e| e.into_inner());
        s.agent_busy = true;
    }
    let _busy = BusyGuard(shared);

    let attachments = attachments.unwrap_or_default();
    Ok(run_cli_agent(app, shared, messages, model, effort, focus, attachments).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn extrait_json_entoure_de_prose_et_de_fences() {
        let s = "Bien sûr !\n```json\n{\"message\":\"ok\",\"ops\":[]}\n```\nVoilà.";
        let j = extract_json_object(s).expect("doit trouver un objet JSON");
        let v: Value = serde_json::from_str(j).unwrap();
        assert_eq!(v["message"], "ok");
        assert!(v["ops"].as_array().unwrap().is_empty());
    }

    #[test]
    fn extrait_json_ignore_les_accolades_dans_les_strings() {
        let s = r#"{"message":"a {b} c","ops":[{"op":"SetMeta","title":null}]}"#;
        let j = extract_json_object(s).expect("doit trouver");
        assert_eq!(j, s, "l'objet entier malgré une accolade dans une chaîne");
    }

    #[test]
    fn prompt_cli_contient_doc_et_consignes() {
        let prompt = build_cli_prompt(&plume_core::Document::empty(), &[], None, &[]);
        assert!(prompt.contains("\"ops\""));
        assert!(prompt.contains("Document actuel"));
        assert!(prompt.contains("SetRuns"));
        assert!(
            !prompt.contains("PRIORITÉ"),
            "pas de section focus sans cible"
        );
        assert!(
            !prompt.contains("CONTEXTE"),
            "pas de section contexte sans pièce jointe"
        );
    }

    #[test]
    fn prompt_cli_attachments_ajoute_le_contexte() {
        let att = vec![Attachment {
            name: "notes.md".into(),
            text: "Contenu de référence".into(),
        }];
        let prompt = build_cli_prompt(&plume_core::Document::empty(), &[], None, &att);
        assert!(prompt.contains("CONTEXTE"), "section contexte présente");
        assert!(prompt.contains("notes.md"), "nom du document joint");
        assert!(
            prompt.contains("Contenu de référence"),
            "texte du document joint"
        );
    }

    #[test]
    fn prompt_cli_focus_ajoute_la_priorite() {
        use plume_core::{Block, Node, Run};
        let mut doc = plume_core::Document::empty();
        let block = Block::new(Node::Paragraph {
            runs: vec![Run::plain("Cible ce paragraphe")],
        });
        let id = block.id.0.clone();
        doc.blocks.push(block);
        let prompt = build_cli_prompt(&doc, &[], Some(&id), &[]);
        assert!(
            prompt.contains("PRIORITÉ"),
            "la section focus doit apparaître"
        );
        assert!(prompt.contains(&id), "l'id ciblé doit être mentionné");
        assert!(
            prompt.contains("Cible ce paragraphe"),
            "aperçu du bloc ciblé"
        );
        // Un id inconnu n'ajoute pas de section (pas de plantage).
        let p2 = build_cli_prompt(&doc, &[], Some("inconnu"), &[]);
        assert!(!p2.contains("PRIORITÉ"));
    }

    #[test]
    fn delta_text_formes_tolerees() {
        // Flux partiel enveloppé (`stream_event`) ET delta nu : les deux formes.
        let enveloppe = json!({ "event": { "delta": { "text": "Hé" } } });
        assert_eq!(delta_text(&enveloppe), Some("Hé"));
        let nu = json!({ "delta": { "text": "ok" } });
        assert_eq!(delta_text(&nu), Some("ok"));
        // Un event sans delta (ex. `result`) ne produit pas de texte.
        let resultat = json!({ "type": "result", "result": "fini" });
        assert_eq!(delta_text(&resultat), None);
    }

    #[test]
    fn claude_candidates_contient_claude() {
        assert!(claude_candidates().contains(&"claude"));
        if cfg!(windows) {
            // Une install npm crée des shims `.cmd`/`.ps1` (pas de `.exe`).
            assert!(claude_candidates().contains(&"claude.cmd"));
        }
    }

    #[test]
    fn claude_command_route_les_shims() {
        use std::ffi::OsStr;
        // `.cmd`/`.bat` → via `cmd /C`.
        let c = claude_command(std::path::Path::new("/x/claude.cmd"));
        let s = c.as_std();
        assert_eq!(s.get_program(), OsStr::new("cmd"));
        assert!(s
            .get_args()
            .any(|a| a.to_string_lossy().contains("claude.cmd")));
        // `.ps1` → via `powershell -File`.
        let c = claude_command(std::path::Path::new("/x/claude.ps1"));
        let s = c.as_std();
        assert_eq!(s.get_program(), OsStr::new("powershell"));
        assert!(s.get_args().any(|a| a == OsStr::new("-File")));
        // Sinon (`.exe`/sans extension) → le binaire lui-même, sans wrapper.
        let c = claude_command(std::path::Path::new("/x/claude.exe"));
        assert_eq!(c.as_std().get_program(), OsStr::new("/x/claude.exe"));
    }

    #[test]
    fn find_claude_respecte_l_override() {
        // L'override `PLUME_CLAUDE_BIN` pointant un fichier existant prime.
        let mut p = std::env::temp_dir();
        p.push("plume_fake_claude_bin_test");
        std::fs::write(&p, b"x").unwrap();
        std::env::set_var("PLUME_CLAUDE_BIN", &p);
        let found = find_claude();
        std::env::remove_var("PLUME_CLAUDE_BIN");
        let _ = std::fs::remove_file(&p);
        assert_eq!(found.as_deref(), Some(p.as_path()));
    }
}
