//! Boucle agent (Wave 5).
//!
//! La command [`chat_send`] appelle l'API **Anthropic Messages** en streaming
//! (SSE), expose **8 outils = 8 opérations** (un outil par variante d'`Op`), et
//! applique chaque `tool_use` via le **même** pipeline pur `plume_core::apply`
//! que l'édition directe (Wave 4). Une op invalide est renvoyée en `tool_result`
//! d'erreur → Claude se corrige seul. La clé `ANTHROPIC_API_KEY` reste **côté
//! Rust** (jamais exposée au webview).
//!
//! Events émis vers le front : `assistant_text` (texte au fil du stream),
//! `op_applied` (op appliquée + nouveau document, pour la preview live),
//! `assistant_done`, `chat_error`.

use std::process::Stdio;

use futures_util::StreamExt;
use plume_core::{apply, Document, Node, Op};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

use crate::Shared;

const API_URL: &str = "https://api.anthropic.com/v1/messages";
/// Modèle par défaut (cf. README ; confirmer la dernière version Sonnet).
const MODEL: &str = "claude-sonnet-4-6";
const ANTHROPIC_VERSION: &str = "2023-06-01";
const MAX_TOKENS: u32 = 4096;
/// Garde-fou anti-boucle : nombre maximal d'allers-retours avec le modèle.
const MAX_TURNS: usize = 16;

/// Un message de conversation, au format de l'API Anthropic (`content` = tableau
/// de blocs `text` / `tool_use` / `tool_result`).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChatMessage {
    pub role: String,
    pub content: Value,
}

// ---------------------------------------------------------------------------
// Surface d'outils : 1 op ⇒ 1 outil (input_schema = champs de la variante)
// ---------------------------------------------------------------------------

/// Sous-schémas réutilisés (source DRY interne). **Inlinés** dans chaque outil
/// avant émission : l'API Anthropic ne déréférence pas `$ref`/`$defs`.
fn defs() -> Value {
    json!({
        "Marks": {
            "type": "object",
            "required": ["bold", "italic", "underline", "strike", "code", "link", "color"],
            "properties": {
                "bold": { "type": "boolean" },
                "italic": { "type": "boolean" },
                "underline": { "type": "boolean" },
                "strike": { "type": "boolean" },
                "code": { "type": "boolean" },
                "link": { "type": ["string", "null"], "description": "URL absolue ou null" },
                "color": { "type": ["string", "null"], "description": "couleur hex #RRGGBB ou null" }
            }
        },
        "Run": {
            "type": "object",
            "required": ["text", "marks"],
            "properties": { "text": { "type": "string" }, "marks": { "$ref": "#/$defs/Marks" } }
        },
        "Cell": {
            "type": "object",
            "required": ["runs"],
            "properties": { "runs": { "type": "array", "items": { "$ref": "#/$defs/Run" } } }
        },
        "Node": {
            "description": "Contenu typé d'un bloc (discriminé par `type`).",
            "oneOf": [
                { "type": "object", "required": ["type", "runs"], "properties": {
                    "type": { "const": "Paragraph" }, "runs": { "type": "array", "items": { "$ref": "#/$defs/Run" } } } },
                { "type": "object", "required": ["type", "level", "runs"], "properties": {
                    "type": { "const": "Heading" }, "level": { "type": "integer", "minimum": 1, "maximum": 6 },
                    "runs": { "type": "array", "items": { "$ref": "#/$defs/Run" } } } },
                { "type": "object", "required": ["type", "ordered", "level", "runs"], "properties": {
                    "type": { "const": "ListItem" }, "ordered": { "type": "boolean" },
                    "level": { "type": "integer", "minimum": 0, "maximum": 5 },
                    "runs": { "type": "array", "items": { "$ref": "#/$defs/Run" } } } },
                { "type": "object", "required": ["type", "runs"], "properties": {
                    "type": { "const": "Quote" }, "runs": { "type": "array", "items": { "$ref": "#/$defs/Run" } } } },
                { "type": "object", "required": ["type", "lang", "text"], "properties": {
                    "type": { "const": "CodeBlock" }, "lang": { "type": ["string", "null"] }, "text": { "type": "string" } } },
                { "type": "object", "required": ["type", "rows"], "properties": {
                    "type": { "const": "Table" },
                    "rows": { "type": "array", "items": { "type": "array", "items": { "$ref": "#/$defs/Cell" } } } } },
                { "type": "object", "required": ["type", "src", "alt", "width_pct"], "properties": {
                    "type": { "const": "Image" }, "src": { "type": "string" }, "alt": { "type": "string" },
                    "width_pct": { "type": ["integer", "null"], "minimum": 0, "maximum": 100 } } },
                { "type": "object", "required": ["type"], "properties": { "type": { "const": "PageBreak" } } }
            ]
        },
        "Block": {
            "type": "object",
            "required": ["id", "node"],
            "properties": {
                "id": { "type": "string", "description": "identifiant unique NOUVEAU (ex. chaîne aléatoire)" },
                "node": { "$ref": "#/$defs/Node" }
            }
        },
        "MarkPatch": {
            "type": "object",
            "description": "Champs omis = inchangés. Pour link/color : valeur = poser, null = effacer.",
            "properties": {
                "bold": { "type": "boolean" }, "italic": { "type": "boolean" },
                "underline": { "type": "boolean" }, "strike": { "type": "boolean" }, "code": { "type": "boolean" },
                "link": { "type": ["string", "null"] }, "color": { "type": ["string", "null"] }
            }
        }
    })
}

/// Inline récursivement tout `{"$ref":"#/$defs/X"}` par le contenu de `defs[X]`.
/// (Le graphe des types est acyclique : Block→Node→Run→Marks, Node→Cell→Run.)
fn resolve_refs(v: &Value, defs: &Value) -> Value {
    match v {
        Value::Object(map) => {
            if let Some(Value::String(r)) = map.get("$ref") {
                if let Some(name) = r.strip_prefix("#/$defs/") {
                    if let Some(target) = defs.get(name) {
                        return resolve_refs(target, defs);
                    }
                }
            }
            let mut out = serde_json::Map::new();
            for (k, val) in map {
                out.insert(k.clone(), resolve_refs(val, defs));
            }
            Value::Object(out)
        }
        Value::Array(arr) => Value::Array(arr.iter().map(|x| resolve_refs(x, defs)).collect()),
        other => other.clone(),
    }
}

fn tool(name: &str, description: &str, properties: Value, required: Value) -> Value {
    let d = defs();
    json!({
        "name": name,
        "description": description,
        // Schéma auto-contenu : aucun $ref/$defs résiduel.
        "input_schema": { "type": "object", "required": required, "properties": resolve_refs(&properties, &d) }
    })
}

/// Les 8 outils exposés à Claude (un par variante d'`Op`).
fn tools() -> Value {
    json!([
        tool("InsertBlock", "Insère un bloc à l'index `at` (0 = début).",
            json!({ "at": { "type": "integer", "minimum": 0 }, "block": { "$ref": "#/$defs/Block" } }),
            json!(["at", "block"])),
        tool("DeleteBlock", "Supprime le bloc d'identifiant `id`.",
            json!({ "id": { "type": "string" } }), json!(["id"])),
        tool("MoveBlock", "Déplace le bloc `id` vers l'index `to`.",
            json!({ "id": { "type": "string" }, "to": { "type": "integer", "minimum": 0 } }),
            json!(["id", "to"])),
        tool("SetNode", "Remplace le contenu ET le type du bloc `id`.",
            json!({ "id": { "type": "string" }, "node": { "$ref": "#/$defs/Node" } }),
            json!(["id", "node"])),
        tool("SetRuns", "Remplace le texte et les marques (runs) du bloc `id`.",
            json!({ "id": { "type": "string" }, "runs": { "type": "array", "items": { "$ref": "#/$defs/Run" } } }),
            json!(["id", "runs"])),
        tool("ApplyMark", "Applique une marque sur un range de caractères du texte concaténé du bloc `id`. `range` = [début, fin) en caractères.",
            json!({
                "id": { "type": "string" },
                "range": { "type": "array", "items": { "type": "integer", "minimum": 0 }, "minItems": 2, "maxItems": 2 },
                "mark": { "$ref": "#/$defs/MarkPatch" }
            }),
            json!(["id", "range", "mark"])),
        tool("SetTableCell", "Remplace les runs d'une cellule (row, col) d'une table.",
            json!({
                "id": { "type": "string" }, "row": { "type": "integer", "minimum": 0 },
                "col": { "type": "integer", "minimum": 0 }, "runs": { "type": "array", "items": { "$ref": "#/$defs/Run" } }
            }),
            json!(["id", "row", "col", "runs"])),
        tool("SetMeta", "Met à jour le titre et/ou la langue du document (champs omis = inchangés).",
            json!({ "title": { "type": ["string", "null"] }, "lang": { "type": ["string", "null"] } }),
            json!([]))
    ])
}

/// Reconstruit une `Op` depuis un `tool_use` : le nom d'outil = le tag `op`.
fn tool_use_to_op(name: &str, input: &Value) -> Result<Op, String> {
    // Entrée marquée illisible (JSON tronqué côté stream) → erreur explicite,
    // pour que Claude réémette l'outil plutôt qu'appliquer une op dégénérée.
    if input.get("__parse_error__").is_some() {
        return Err(format!("entrée de l'outil {name} tronquée ou illisible"));
    }
    let mut obj = input.as_object().cloned().unwrap_or_default();
    obj.insert("op".to_string(), json!(name));
    serde_json::from_value::<Op>(Value::Object(obj))
        .map_err(|e| format!("entrée invalide pour l'outil {name} : {e}"))
}

// ---------------------------------------------------------------------------
// Application d'un outil via le pipeline pur (mutation du document partagé)
// ---------------------------------------------------------------------------

/// Applique une `Op` validée au document partagé et émet `op_applied`. Cœur
/// **partagé** par les providers API et CLI.
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

/// Applique un `tool_use` (chemin API). Renvoie `(contenu du tool_result, is_error)`.
fn apply_tool(app: &AppHandle, state: &Shared, name: &str, input: &Value) -> (String, bool) {
    let op = match tool_use_to_op(name, input) {
        Ok(op) => op,
        Err(reason) => return (json!({ "ok": false, "reason": reason }).to_string(), true),
    };
    match apply_validated_op(app, state, op, name) {
        Ok(()) => (json!({ "ok": true }).to_string(), false),
        Err(reason) => (json!({ "ok": false, "reason": reason }).to_string(), true),
    }
}

// ---------------------------------------------------------------------------
// Streaming SSE
// ---------------------------------------------------------------------------

/// Bloc de contenu en cours d'accumulation depuis le stream.
enum Acc {
    None,
    Text(String),
    Tool {
        id: String,
        name: String,
        json: String,
    },
}

/// Résultat d'un tour : blocs assistant + tool_use + métadonnées de fin.
struct Turn {
    blocks: Vec<Value>,
    tool_uses: Vec<(String, String, Value)>,
    stop_reason: Option<String>,
    stream_error: Option<String>,
    saw_stop: bool,
}

/// Finalise le bloc en cours d'accumulation dans `turn`.
fn flush(acc: &mut Acc, turn: &mut Turn) {
    match std::mem::replace(acc, Acc::None) {
        Acc::Text(t) => {
            if !t.is_empty() {
                turn.blocks.push(json!({ "type": "text", "text": t }));
            }
        }
        Acc::Tool { id, name, json } => {
            let input: Value = if json.trim().is_empty() {
                json!({})
            } else {
                // JSON présent mais illisible (ex. tronqué) → sentinelle d'erreur,
                // PAS `{}` silencieux (qui masquerait la perte d'information).
                serde_json::from_str(&json).unwrap_or_else(|_| json!({ "__parse_error__": true }))
            };
            turn.blocks.push(json!({
                "type": "tool_use", "id": id.clone(), "name": name.clone(), "input": input.clone()
            }));
            turn.tool_uses.push((id, name, input));
        }
        Acc::None => {}
    }
}

fn handle_event(app: &AppHandle, v: &Value, acc: &mut Acc, turn: &mut Turn) {
    match v["type"].as_str() {
        Some("content_block_start") => {
            let cb = &v["content_block"];
            *acc = match cb["type"].as_str() {
                Some("text") => Acc::Text(cb["text"].as_str().unwrap_or("").to_string()),
                Some("tool_use") => Acc::Tool {
                    id: cb["id"].as_str().unwrap_or("").to_string(),
                    name: cb["name"].as_str().unwrap_or("").to_string(),
                    json: String::new(),
                },
                _ => Acc::None,
            };
        }
        Some("content_block_delta") => {
            let d = &v["delta"];
            match d["type"].as_str() {
                Some("text_delta") => {
                    if let Acc::Text(t) = acc {
                        let piece = d["text"].as_str().unwrap_or("");
                        t.push_str(piece);
                        let _ = app.emit("assistant_text", json!({ "text": piece }));
                    }
                }
                Some("input_json_delta") => {
                    if let Acc::Tool { json, .. } = acc {
                        json.push_str(d["partial_json"].as_str().unwrap_or(""));
                    }
                }
                _ => {}
            }
        }
        Some("content_block_stop") => flush(acc, turn),
        Some("message_delta") => {
            if let Some(sr) = v["delta"]["stop_reason"].as_str() {
                turn.stop_reason = Some(sr.to_string());
            }
        }
        Some("message_stop") => turn.saw_stop = true,
        Some("error") => {
            turn.stream_error = Some(
                v["error"]["message"]
                    .as_str()
                    .unwrap_or("erreur de l'API Anthropic")
                    .to_string(),
            );
        }
        _ => {}
    }
}

/// Lit le stream SSE jusqu'au bout et renvoie le tour reconstruit.
///
/// Bufferise des **octets** : on ne décode que des lignes complètes (le
/// délimiteur `\n` est ASCII), ce qui évite de couper un caractère UTF-8
/// multi-octets entre deux chunks réseau (corruption des accents).
async fn parse_stream(app: &AppHandle, resp: reqwest::Response) -> Result<Turn, String> {
    let mut stream = resp.bytes_stream();
    let mut buffer: Vec<u8> = Vec::new();
    let mut acc = Acc::None;
    let mut turn = Turn {
        blocks: Vec::new(),
        tool_uses: Vec::new(),
        stop_reason: None,
        stream_error: None,
        saw_stop: false,
    };

    while let Some(chunk) = stream.next().await {
        let chunk = chunk.map_err(|e| e.to_string())?;
        buffer.extend_from_slice(&chunk);

        while let Some(nl) = buffer.iter().position(|&b| b == b'\n') {
            let line_bytes: Vec<u8> = buffer.drain(..=nl).collect();
            let line = String::from_utf8_lossy(&line_bytes);
            let line = line.trim();
            let data = match line.strip_prefix("data:") {
                Some(d) => d.trim(),
                None => continue, // ignore `event:` et lignes vides
            };
            if data.is_empty() {
                continue;
            }
            if let Ok(v) = serde_json::from_str::<Value>(data) {
                handle_event(app, &v, &mut acc, &mut turn);
            }
        }
    }
    flush(&mut acc, &mut turn); // résidu éventuel en fin de flux
    Ok(turn)
}

// ---------------------------------------------------------------------------
// Boucle agent
// ---------------------------------------------------------------------------

fn build_system(doc: &Document) -> String {
    let doc_json = serde_json::to_string_pretty(doc).unwrap_or_default();
    format!(
        "Tu es l'assistant d'édition de Plume, un éditeur de documents riches. Tu modifies le \
document UNIQUEMENT via les outils fournis (une opération par outil) — tu n'écris jamais de \
fichier. Cible les blocs existants par leur `id`. Pour `InsertBlock`, génère un `id` unique \
nouveau. Le `range` d'`ApplyMark` est exprimé en caractères sur le texte concaténé des runs du \
bloc, demi-ouvert [début, fin). Si une opération est refusée (tool_result d'erreur), corrige-la. \
Quand la demande est satisfaite, réponds brièvement en français.\n\n\
État actuel du document (JSON) :\n{doc_json}"
    )
}

fn emit_error(app: &AppHandle, message: impl Into<String>) {
    let _ = app.emit("chat_error", json!({ "message": message.into() }));
}

/// Exécute la boucle agent. Renvoie **toujours** l'historique accumulé (même en
/// cas d'échec : les tours déjà appliqués ne sont jamais perdus) ; les erreurs
/// sont signalées via l'event `chat_error`.
async fn run_agent(
    app: AppHandle,
    state: &Shared,
    mut messages: Vec<ChatMessage>,
    api_key: String,
) -> Vec<ChatMessage> {
    let client = reqwest::Client::new();

    for _ in 0..MAX_TURNS {
        let doc = match state.lock() {
            Ok(s) => s.doc.clone(),
            Err(e) => {
                emit_error(&app, e.to_string());
                return messages;
            }
        };
        let body = json!({
            "model": MODEL,
            "max_tokens": MAX_TOKENS,
            "stream": true,
            "system": build_system(&doc),
            "tools": tools(),
            "messages": messages,
        });

        let resp = match client
            .post(API_URL)
            .header("x-api-key", &api_key)
            .header("anthropic-version", ANTHROPIC_VERSION)
            .header("content-type", "application/json")
            .json(&body)
            .send()
            .await
        {
            Ok(r) => r,
            Err(e) => {
                emit_error(&app, format!("requête échouée : {e}"));
                return messages;
            }
        };

        if !resp.status().is_success() {
            let status = resp.status();
            let text = resp.text().await.unwrap_or_default();
            emit_error(&app, format!("API Anthropic {status} : {text}"));
            return messages;
        }

        let turn = match parse_stream(&app, resp).await {
            Ok(t) => t,
            Err(e) => {
                emit_error(&app, format!("flux interrompu : {e}"));
                return messages;
            }
        };

        if let Some(err) = turn.stream_error {
            emit_error(&app, err);
            return messages;
        }
        if turn.stop_reason.as_deref() == Some("max_tokens") {
            emit_error(
                &app,
                "réponse tronquée (max_tokens atteint) — reformule plus court.",
            );
            return messages;
        }
        if turn.blocks.is_empty() {
            let why = if turn.saw_stop {
                "réponse vide du modèle."
            } else {
                "flux interrompu."
            };
            emit_error(&app, why);
            return messages;
        }

        let has_tools = !turn.tool_uses.is_empty();
        messages.push(ChatMessage {
            role: "assistant".to_string(),
            content: Value::Array(turn.blocks),
        });

        if !has_tools {
            let _ = app.emit("assistant_done", json!({}));
            return messages;
        }

        // Applique chaque op et renvoie les tool_results au modèle.
        let mut results = Vec::new();
        for (id, name, input) in &turn.tool_uses {
            let (content, is_error) = apply_tool(&app, state, name, input);
            results.push(json!({
                "type": "tool_result", "tool_use_id": id, "content": content, "is_error": is_error
            }));
        }
        messages.push(ChatMessage {
            role: "user".to_string(),
            content: Value::Array(results),
        });
    }

    emit_error(
        &app,
        "trop d'allers-retours avec l'agent (boucle interrompue).",
    );
    messages
}

// ---------------------------------------------------------------------------
// Provider « Claude Code (CLI local) »
// ---------------------------------------------------------------------------
//
// Délègue au binaire `claude` que l'utilisateur a lui-même installé et
// authentifié : la consommation passe par SON auth (abonnement ou sa propre
// clé). ⚠️ Conformité : router des requêtes via un abonnement Pro/Max est
// encadré par les CGU d'Anthropic (usage interactif). Ce provider est optionnel,
// désactivé par défaut, et chacun branche SON propre `claude` — à l'utilisateur
// de vérifier les CGU pour son usage.

/// Disponibilité des providers de chat (pour que le front propose le bon choix).
#[derive(Debug, Serialize)]
pub struct ChatProviders {
    pub api_key: bool,
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

/// Détecte les providers disponibles (clé API définie ? `claude` installé ?).
#[tauri::command]
pub fn detect_chat_providers() -> ChatProviders {
    ChatProviders {
        api_key: std::env::var("ANTHROPIC_API_KEY")
            .map(|k| !k.is_empty())
            .unwrap_or(false),
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
///
/// Les blocs `tool_use`/`tool_result` (issus du chemin API) sont ignorés : en
/// cas de bascule API→CLI, le fil textuel suffit car le **document courant**
/// (injecté dans le prompt) reste la source de vérité.
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
/// par l'utilisateur (priorité), s'il y en a un.
fn build_cli_prompt(doc: &Document, messages: &[ChatMessage], focus: Option<&str>) -> String {
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
    format!(
        "Tu es l'assistant d'édition de Plume, un éditeur de documents. Tu modifies le document \
UNIQUEMENT en émettant des opérations. Cible les blocs existants par leur `id` ; pour InsertBlock, \
génère un id unique nouveau.\n\n\
Réponds EXACTEMENT dans cet ordre :\n\
1) une phrase brève en français décrivant ce que tu fais (ou ta réponse à la demande) ;\n\
2) puis, sur une NOUVELLE ligne, un bloc de code ```json contenant {{\"ops\": [<op>, ...]}} \
(liste vide si aucune édition). N'écris RIEN après ce bloc.\n\n\
{OPS_HELP}\n\n\
Document actuel (JSON) :\n{doc_json}{focus_section}\n\n\
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
    let prompt = build_cli_prompt(&doc, &messages, focus.as_deref());

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

/// Command : envoie l'historique au provider choisi (`api` = API Anthropic via
/// clé ; `cli` = Claude Code local) et renvoie l'historique mis à jour.
#[tauri::command]
pub async fn chat_send(
    messages: Vec<ChatMessage>,
    provider: String,
    model: String,
    effort: String,
    focus: Option<String>,
    app: AppHandle,
    state: tauri::State<'_, Shared>,
) -> Result<Vec<ChatMessage>, String> {
    if provider == "cli" {
        return Ok(run_cli_agent(app, state.inner(), messages, model, effort, focus).await);
    }
    // Défaut : API Anthropic (clé).
    let api_key = match std::env::var("ANTHROPIC_API_KEY") {
        Ok(k) => k,
        Err(_) => {
            let msg =
                "ANTHROPIC_API_KEY manquante : définis-la, ou choisis « Claude Code ».".to_string();
            emit_error(&app, msg.clone());
            return Err(msg);
        }
    };
    Ok(run_agent(app, state.inner(), messages, api_key).await)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parcourt récursivement un JSON et vérifie l'absence d'une clé.
    fn contains_key(v: &Value, key: &str) -> bool {
        match v {
            Value::Object(m) => m.contains_key(key) || m.values().any(|x| contains_key(x, key)),
            Value::Array(a) => a.iter().any(|x| contains_key(x, key)),
            _ => false,
        }
    }

    #[test]
    fn huit_outils_un_par_op() {
        let t = tools();
        let arr = t.as_array().unwrap();
        assert_eq!(arr.len(), 8);
        let names: Vec<&str> = arr.iter().map(|x| x["name"].as_str().unwrap()).collect();
        for expected in [
            "InsertBlock",
            "DeleteBlock",
            "MoveBlock",
            "SetNode",
            "SetRuns",
            "ApplyMark",
            "SetTableCell",
            "SetMeta",
        ] {
            assert!(names.contains(&expected), "outil manquant : {expected}");
        }
    }

    #[test]
    fn schemas_inlines_sans_ref_ni_defs() {
        // L'API Anthropic ne déréférence pas $ref/$defs : les schémas doivent
        // être auto-contenus.
        let t = tools();
        assert!(
            !contains_key(&t, "$ref"),
            "un $ref subsiste dans les schémas"
        );
        assert!(
            !contains_key(&t, "$defs"),
            "un $defs subsiste dans les schémas"
        );
        // Et le schéma de InsertBlock contient bien la structure inlinée de Block→Node.
        let insert = &t.as_array().unwrap()[0];
        assert!(
            contains_key(insert, "oneOf"),
            "Node (oneOf) devrait être inliné dans InsertBlock"
        );
    }

    #[test]
    fn tool_use_setruns_devient_op() {
        let input = json!({
            "id": "abc",
            "runs": [{ "text": "hello", "marks": {
                "bold": true, "italic": false, "underline": false, "strike": false,
                "code": false, "link": null, "color": null
            }}]
        });
        let op = tool_use_to_op("SetRuns", &input).expect("doit parser");
        match op {
            Op::SetRuns { id, runs } => {
                assert_eq!(id.0, "abc");
                assert_eq!(runs.len(), 1);
                assert_eq!(runs[0].text, "hello");
                assert!(runs[0].marks.bold);
            }
            _ => panic!("variante inattendue"),
        }
    }

    #[test]
    fn tool_use_applymark_range_tuple() {
        let input = json!({ "id": "x", "range": [0, 5], "mark": { "bold": true } });
        let op = tool_use_to_op("ApplyMark", &input).expect("doit parser");
        match op {
            Op::ApplyMark { id, range, mark } => {
                assert_eq!(id.0, "x");
                assert_eq!(range, (0, 5));
                assert_eq!(mark.bold, Some(true));
            }
            _ => panic!("variante inattendue"),
        }
    }

    #[test]
    fn tool_use_invalide_renvoie_erreur() {
        assert!(tool_use_to_op("SetRuns", &json!({ "wrong": "field" })).is_err());
        // Sentinelle d'entrée tronquée → erreur même pour SetMeta (sinon no-op masqué).
        assert!(tool_use_to_op("SetMeta", &json!({ "__parse_error__": true })).is_err());
    }

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
        let prompt = build_cli_prompt(&plume_core::Document::empty(), &[], None);
        assert!(prompt.contains("\"ops\""));
        assert!(prompt.contains("Document actuel"));
        assert!(prompt.contains("SetRuns"));
        assert!(
            !prompt.contains("PRIORITÉ"),
            "pas de section focus sans cible"
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
        let prompt = build_cli_prompt(&doc, &[], Some(&id));
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
        let p2 = build_cli_prompt(&doc, &[], Some("inconnu"));
        assert!(!p2.contains("PRIORITÉ"));
    }
}
