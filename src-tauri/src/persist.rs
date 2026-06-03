//! Persistance `.plume.json` (Wave 6).
//!
//! L'I/O fichier vit **côté Rust** : le document (sérialisé en JSON natif via
//! `serde`) reste la source de vérité. Le front fournit le chemin (obtenu d'un
//! sélecteur natif) ; ces commands lisent/écrivent et, à l'ouverture, remplacent
//! l'état d'édition partagé.

use std::fs;
use std::io::Write;

use plume_core::Document;

use crate::Shared;

/// Sérialise un document en `.plume.json` (JSON indenté, lisible/diffable).
///
/// Écriture **atomique et durable** : on écrit dans un fichier temporaire (même
/// dossier), on le `sync` sur disque, puis on `rename` (basculement atomique sur
/// le même système de fichiers). Une écriture interrompue ne peut donc jamais
/// laisser la cible tronquée : soit l'ancien contenu, soit le nouveau, intact.
fn write_doc(doc: &Document, path: &str) -> Result<(), String> {
    let json = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?;
    let tmp = format!("{path}.tmp");
    {
        let mut f = fs::File::create(&tmp).map_err(|e| e.to_string())?;
        f.write_all(json.as_bytes()).map_err(|e| e.to_string())?;
        f.sync_all().map_err(|e| e.to_string())?;
    }
    fs::rename(&tmp, path).map_err(|e| {
        let _ = fs::remove_file(&tmp); // nettoie le tmp si le rename échoue
        e.to_string()
    })
}

/// Lit et désérialise un `.plume.json`.
fn read_doc(path: &str) -> Result<Document, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("fichier .plume.json invalide : {e}"))
}

/// Enregistre le document **fourni** (snapshot capturé côté front) à `path`.
///
/// Le document est passé en argument plutôt que lu dans l'état partagé : (1) le
/// contenu écrit est lié au chemin demandé (pas de course « autosave de A pendant
/// l'ouverture de B » qui écrirait B dans le fichier A) ; (2) aucun verrou n'est
/// tenu pendant l'I/O disque (l'édition et l'agent ne sont jamais gelés).
#[tauri::command]
pub fn save_document(path: String, doc: Document) -> Result<(), String> {
    write_doc(&doc, &path)
}

/// Ouvre un document : **remplace** l'état d'édition (doc + piles undo/redo —
/// l'historique d'un autre document n'a pas de sens) et renvoie le document.
///
/// Récupère un éventuel Mutex empoisonné (`into_inner`) : un panic isolé d'une
/// autre command ne doit jamais empêcher d'ouvrir/enregistrer.
#[tauri::command]
pub fn open_document(path: String, state: tauri::State<'_, Shared>) -> Result<Document, String> {
    let doc = read_doc(&path)?;
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    s.doc = doc.clone();
    s.undo.clear();
    s.redo.clear();
    Ok(doc)
}

#[cfg(test)]
mod tests {
    use super::*;
    use plume_core::{Block, Meta, Node, Run};

    fn temp(name: &str) -> String {
        let mut p = std::env::temp_dir();
        p.push(name);
        p.to_string_lossy().into_owned()
    }

    #[test]
    fn round_trip_fichier_preserve_tout() {
        let doc = Document {
            meta: Meta {
                title: "Démo accentuée é à ü ©".into(),
                lang: "fr".into(),
            },
            blocks: vec![
                Block::new(Node::Heading {
                    level: 1,
                    runs: vec![Run::plain("Titre élaboré")],
                }),
                Block::new(Node::Paragraph {
                    runs: vec![Run::plain("Un paragraphe très accentué : déjà vu où ?")],
                }),
            ],
        };
        let path = temp("plume_test_roundtrip.plume.json");
        write_doc(&doc, &path).expect("écriture");
        let back = read_doc(&path).expect("lecture");
        assert_eq!(doc, back, "le round-trip fichier doit tout préserver");
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn ecriture_atomique_ne_laisse_pas_de_tmp() {
        let doc = Document::empty();
        let path = temp("plume_test_atomic.plume.json");
        write_doc(&doc, &path).expect("écriture");
        assert!(
            !std::path::Path::new(&format!("{path}.tmp")).exists(),
            "le tmp doit être renommé"
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn fichier_invalide_rejete() {
        let path = temp("plume_test_invalide.plume.json");
        fs::write(&path, "ceci n'est pas du json").unwrap();
        assert!(read_doc(&path).is_err());
        let _ = fs::remove_file(&path);
    }
}
