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

use futures_util::StreamExt;
use plume_core::{apply, Document, Op};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{AppHandle, Emitter};

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

/// Applique un `tool_use`. Renvoie `(contenu du tool_result, is_error)`.
fn apply_tool(app: &AppHandle, state: &Shared, name: &str, input: &Value) -> (String, bool) {
    let op = match tool_use_to_op(name, input) {
        Ok(op) => op,
        Err(reason) => return (json!({ "ok": false, "reason": reason }).to_string(), true),
    };

    let mut s = match state.lock() {
        Ok(s) => s,
        Err(e) => {
            return (
                json!({ "ok": false, "reason": e.to_string() }).to_string(),
                true,
            )
        }
    };
    match apply(&mut s.doc, op) {
        Ok(inverse) => {
            s.undo.push(inverse);
            s.redo.clear();
            s.last_edit = None; // op agent discrète : pas de coalescing avec la frappe
            let doc = s.doc.clone();
            drop(s); // ne jamais tenir le verrou pendant l'émission/await
            let _ = app.emit("op_applied", json!({ "doc": doc, "op": name }));
            (json!({ "ok": true }).to_string(), false)
        }
        Err(e) => {
            drop(s);
            (json!({ "ok": false, "reason": e.reason }).to_string(), true)
        }
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

/// Command : envoie l'historique au modèle, exécute la boucle agent (streaming +
/// application des ops), et renvoie l'historique mis à jour (toujours cohérent
/// avec le document, même si un tour a échoué).
#[tauri::command]
pub async fn chat_send(
    messages: Vec<ChatMessage>,
    app: AppHandle,
    state: tauri::State<'_, Shared>,
) -> Result<Vec<ChatMessage>, String> {
    let api_key = match std::env::var("ANTHROPIC_API_KEY") {
        Ok(k) => k,
        Err(_) => {
            let msg =
                "ANTHROPIC_API_KEY manquante : définis-la dans l'environnement avant de lancer l'app."
                    .to_string();
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
}
