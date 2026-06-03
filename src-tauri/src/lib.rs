//! Shell Tauri de Plume. Expose les commands invoquées par le webview.
//!
//! Le shell ne contient **aucune** logique métier : il détient l'état d'édition
//! (le document, source de vérité) et délègue **toute** mutation au pipeline pur
//! `plume_core::apply` (validate → apply → inverse). C'est la même surface que
//! la boucle agent utilisera en Wave 5 : l'UI et Claude muteront le document par
//! les *mêmes* opérations validées.

use std::sync::Mutex;

use plume_core::{apply, Block, Document, Meta, Node, Op, Run};

/// État d'édition partagé entre toutes les commands.
///
/// `undo` / `redo` empilent les opérations **inverses** renvoyées par `apply`
/// (chaque op a son inverse) ; l'UI d'undo/redo (Cmd+Z) sera câblée en Wave 8,
/// mais la machinerie vit ici dès maintenant.
struct EditorState {
    doc: Document,
    undo: Vec<Op>,
    redo: Vec<Op>,
}

impl EditorState {
    fn new() -> Self {
        EditorState {
            doc: starter_document(),
            undo: Vec::new(),
            redo: Vec::new(),
        }
    }
}

type Shared = Mutex<EditorState>;

/// Command `ping` (Wave 0) : prouve l'aller-retour webview → Tauri → cœur Rust.
#[tauri::command]
fn ping() -> String {
    plume_core::ping()
}

/// Renvoie le document courant (chargé au démarrage du front).
#[tauri::command]
fn get_document(state: tauri::State<'_, Shared>) -> Result<Document, String> {
    let s = state.lock().map_err(|e| e.to_string())?;
    Ok(s.doc.clone())
}

/// Applique une opération au document via `plume_core::apply`.
///
/// Succès → empile l'inverse pour l'undo, vide la pile de redo, renvoie le
/// nouveau document. Échec de validation → renvoie la raison (`Err`) **sans**
/// modifier l'état (l'UI, comme Claude, peut alors se corriger).
#[tauri::command]
fn apply_op(op: Op, state: tauri::State<'_, Shared>) -> Result<Document, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    let inverse = apply(&mut s.doc, op).map_err(|e| e.reason)?;
    s.undo.push(inverse);
    s.redo.clear();
    Ok(s.doc.clone())
}

/// Annule la dernière opération (rejoue son inverse) et renvoie le document.
///
/// On ne dépile qu'**après** le succès d'`apply` : un échec laisse les piles et
/// le document intacts (pas de désynchronisation silencieuse de l'historique).
#[tauri::command]
fn undo(state: tauri::State<'_, Shared>) -> Result<Document, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    if let Some(op) = s.undo.last().cloned() {
        let redo_op = apply(&mut s.doc, op).map_err(|e| e.reason)?;
        s.undo.pop();
        s.redo.push(redo_op);
    }
    Ok(s.doc.clone())
}

/// Rétablit la dernière opération annulée et renvoie le document.
#[tauri::command]
fn redo(state: tauri::State<'_, Shared>) -> Result<Document, String> {
    let mut s = state.lock().map_err(|e| e.to_string())?;
    if let Some(op) = s.redo.last().cloned() {
        let undo_op = apply(&mut s.doc, op).map_err(|e| e.reason)?;
        s.redo.pop();
        s.undo.push(undo_op);
    }
    Ok(s.doc.clone())
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
        .manage(Shared::new(EditorState::new()))
        .invoke_handler(tauri::generate_handler![
            ping,
            get_document,
            apply_op,
            undo,
            redo
        ])
        .run(tauri::generate_context!())
        .expect("erreur au lancement de l'application Plume");
}
