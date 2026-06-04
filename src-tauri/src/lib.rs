//! Shell Tauri de Plume. Expose les commands invoquées par le webview.
//!
//! Le shell ne contient **aucune** logique métier : il détient l'état d'édition
//! (le document, source de vérité) et délègue **toute** mutation au pipeline pur
//! `plume_core::apply` (validate → apply → inverse). C'est la même surface que
//! la boucle agent utilisera en Wave 5 : l'UI et Claude muteront le document par
//! les *mêmes* opérations validées.

use std::sync::Mutex;

use plume_core::{apply, Block, Document, Meta, Node, Op, Run};

mod chat;
mod export;
mod import;
mod persist;

/// État d'édition partagé entre toutes les commands.
///
/// `undo` / `redo` empilent les opérations **inverses** renvoyées par `apply`
/// (chaque op a son inverse) ; l'UI d'undo/redo (Cmd+Z) sera câblée en Wave 8,
/// mais la machinerie vit ici dès maintenant. La boucle agent (Wave 5, `chat`)
/// mute **le même** état via le **même** pipeline.
pub(crate) struct EditorState {
    pub(crate) doc: Document,
    pub(crate) undo: Vec<Op>,
    pub(crate) redo: Vec<Op>,
    /// Bloc de la dernière saisie, pour coalescer une rafale de frappe en une
    /// seule étape d'undo (`None` après undo/redo/agent/ouverture).
    pub(crate) last_edit: Option<String>,
    /// `true` pendant qu'un tour d'assistant applique des ops : `set_document`
    /// (bascule d'onglet) est alors refusé pour ne pas muter le document sous les
    /// pieds de l'agent (sinon ops appliquées au mauvais document / perdues).
    pub(crate) agent_busy: bool,
}

impl EditorState {
    fn new() -> Self {
        EditorState {
            doc: starter_document(),
            undo: Vec::new(),
            redo: Vec::new(),
            last_edit: None,
            agent_busy: false,
        }
    }
}

pub(crate) type Shared = Mutex<EditorState>;

/// Command `ping` (Wave 0) : prouve l'aller-retour webview → Tauri → cœur Rust.
#[tauri::command]
fn ping() -> String {
    plume_core::ping()
}

/// Renvoie le document courant (chargé au démarrage du front).
#[tauri::command]
fn get_document(state: tauri::State<'_, Shared>) -> Result<Document, String> {
    let s = state.lock().unwrap_or_else(|e| e.into_inner());
    Ok(s.doc.clone())
}

/// Applique une opération au document via `plume_core::apply`.
///
/// Succès → empile l'inverse pour l'undo, vide la pile de redo, renvoie le
/// nouveau document. Échec de validation → renvoie la raison (`Err`) **sans**
/// modifier l'état (l'UI, comme Claude, peut alors se corriger).
#[tauri::command]
fn apply_op(op: Op, state: tauri::State<'_, Shared>) -> Result<Document, String> {
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    apply_op_to_state(&mut s, op)?;
    Ok(s.doc.clone())
}

/// Cœur testable d'`apply_op` : applique `op` et gère le coalescing d'undo.
///
/// Des `SetRuns` consécutifs sur le même bloc (rafale de frappe) forment UNE
/// étape d'undo : on garde le 1er inverse (qui restaure l'état d'avant la rafale)
/// et on n'en empile pas de nouveau.
pub(crate) fn apply_op_to_state(s: &mut EditorState, op: Op) -> Result<(), String> {
    let coalesce =
        matches!(&op, Op::SetRuns { id, .. } if s.last_edit.as_deref() == Some(id.0.as_str()));
    let this_edit = match &op {
        Op::SetRuns { id, .. } => Some(id.0.clone()),
        _ => None,
    };
    let inverse = apply(&mut s.doc, op).map_err(|e| e.reason)?;
    if !coalesce {
        s.undo.push(inverse);
    }
    s.redo.clear();
    s.last_edit = this_edit;
    Ok(())
}

/// Annule la dernière opération (rejoue son inverse) et renvoie le document.
///
/// On ne dépile qu'**après** le succès d'`apply` : un échec laisse les piles et
/// le document intacts (pas de désynchronisation silencieuse de l'historique).
#[tauri::command]
fn undo(state: tauri::State<'_, Shared>) -> Result<Option<Document>, String> {
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    let changed = if let Some(op) = s.undo.last().cloned() {
        let redo_op = apply(&mut s.doc, op).map_err(|e| e.reason)?;
        s.undo.pop();
        s.redo.push(redo_op);
        true
    } else {
        false
    };
    s.last_edit = None;
    // `None` si la pile était vide : le front n'a alors rien à resynchroniser.
    Ok(changed.then(|| s.doc.clone()))
}

/// Rétablit la dernière opération annulée et renvoie le document.
#[tauri::command]
fn redo(state: tauri::State<'_, Shared>) -> Result<Option<Document>, String> {
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    let changed = if let Some(op) = s.redo.last().cloned() {
        let undo_op = apply(&mut s.doc, op).map_err(|e| e.reason)?;
        s.redo.pop();
        s.undo.push(undo_op);
        true
    } else {
        false
    };
    s.last_edit = None;
    Ok(changed.then(|| s.doc.clone()))
}

/// Document de démarrage : un point de départ éditable au lancement.
fn starter_document() -> Document {
    Document {
        meta: Meta {
            title: "Document sans titre".into(),
            lang: "fr".into(),
        },
        blocks: vec![
            Block::new(Node::Heading {
                level: 1,
                runs: vec![Run::plain("Bienvenue dans Plume")],
            }),
            Block::new(Node::Paragraph {
                runs: vec![Run::plain(
                    "Cliquez dans le texte et tapez pour éditer. Sélectionnez un \
                     passage puis utilisez la barre d'outils pour le mettre en gras, \
                     en italique, etc.",
                )],
            }),
            Block::new(Node::Paragraph {
                runs: vec![Run::plain("Appuyez sur Entrée pour créer un nouveau bloc.")],
            }),
        ],
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
        .manage(Shared::new(EditorState::new()))
        .invoke_handler(tauri::generate_handler![
            ping,
            get_document,
            apply_op,
            undo,
            redo,
            chat::chat_send,
            chat::detect_chat_providers,
            persist::save_document,
            persist::open_document,
            persist::set_document,
            import::import_document,
            import::read_context,
            export::export_markdown,
            export::export_docx
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Plume");
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn coalesce_rafale_de_frappe_en_une_etape_undo() {
        let mut s = EditorState::new();
        let para = s.doc.blocks[1].id.clone(); // un paragraphe (porte des runs)

        // Trois saisies consécutives sur le même bloc.
        for txt in ["a", "ab", "abc"] {
            apply_op_to_state(
                &mut s,
                Op::SetRuns {
                    id: para.clone(),
                    runs: vec![Run::plain(txt)],
                },
            )
            .unwrap();
        }
        assert_eq!(s.undo.len(), 1, "une rafale = une seule étape d'undo");

        // Une op sur un AUTRE bloc rompt la rafale → nouvelle étape.
        let titre = s.doc.blocks[0].id.clone();
        apply_op_to_state(
            &mut s,
            Op::SetRuns {
                id: titre,
                runs: vec![Run::plain("x")],
            },
        )
        .unwrap();
        assert_eq!(s.undo.len(), 2, "un autre bloc démarre une nouvelle étape");
    }
}
