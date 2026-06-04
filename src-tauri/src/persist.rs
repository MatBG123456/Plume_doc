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

/// Version du schéma écrite dans les fichiers `.plume.json`. À incrémenter lors
/// d'un changement de modèle, en ajoutant la migration correspondante dans
/// [`migrate`]. Le versionnement est porté **par le fichier** (clé
/// `schema_version`), pas par le modèle : la désérialisation ignore les clés
/// inconnues, donc aucun champ n'est ajouté à `Document`/`Meta`.
pub(crate) const SCHEMA_VERSION: u64 = 1;

/// Sérialise un document en `.plume.json` (JSON indenté, lisible/diffable),
/// estampillé de la version de schéma courante.
///
/// Écriture **atomique et durable** : on écrit dans un fichier temporaire (même
/// dossier), on le `sync` sur disque, puis on `rename` (basculement atomique sur
/// le même système de fichiers). Une écriture interrompue ne peut donc jamais
/// laisser la cible tronquée : soit l'ancien contenu, soit le nouveau, intact.
fn write_doc(doc: &Document, path: &str) -> Result<(), String> {
    let mut value = serde_json::to_value(doc).map_err(|e| e.to_string())?;
    if let Some(obj) = value.as_object_mut() {
        obj.insert(
            "schema_version".to_string(),
            serde_json::json!(SCHEMA_VERSION),
        );
    }
    let json = serde_json::to_string_pretty(&value).map_err(|e| e.to_string())?;
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

/// Lit, **migre** puis désérialise un `.plume.json`.
fn read_doc(path: &str) -> Result<Document, String> {
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let mut value: serde_json::Value =
        serde_json::from_str(&text).map_err(|e| format!("fichier .plume.json invalide : {e}"))?;
    // Fichiers antérieurs au versionnement : pas de clé → v0 (même schéma que v1).
    let version = value
        .get("schema_version")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);
    migrate(&mut value, version)?;
    serde_json::from_value(value).map_err(|e| format!("fichier .plume.json invalide : {e}"))
}

/// Migre la valeur JSON d'un document vers la version de schéma courante. Refuse
/// une version plus récente que celle supportée par ce binaire.
fn migrate(_value: &mut serde_json::Value, version: u64) -> Result<(), String> {
    if version > SCHEMA_VERSION {
        return Err(format!(
            "fichier créé par une version plus récente de Plume (schéma v{version} > v{SCHEMA_VERSION}) : mets Plume à jour."
        ));
    }
    // v0 (non versionné) et v1 partagent le même schéma : rien à migrer.
    // Futures migrations : `if version < 2 { /* transformer value */ }` etc.
    Ok(())
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
    s.last_edit = None;
    Ok(doc)
}

/// Remplace le document courant par celui fourni (sans I/O fichier) : utilisé
/// pour restaurer un cache de session au démarrage. Vide undo/redo.
#[tauri::command]
pub fn set_document(doc: Document, state: tauri::State<'_, Shared>) -> Result<(), String> {
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    if s.agent_busy {
        // Un tour d'assistant applique des ops : ne pas muter le document sous lui.
        return Err("Un tour de l'assistant est en cours ; réessaie dans un instant.".into());
    }
    s.doc = doc;
    s.undo.clear();
    s.redo.clear();
    s.last_edit = None;
    Ok(())
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

    #[test]
    fn schema_version_ecrite_et_ignoree_au_relire() {
        let doc = Document::empty();
        let path = temp("plume_test_schema.plume.json");
        write_doc(&doc, &path).expect("écriture");
        let text = fs::read_to_string(&path).unwrap();
        assert!(
            text.contains("\"schema_version\""),
            "le fichier porte la version"
        );
        assert_eq!(
            read_doc(&path).expect("lecture"),
            doc,
            "la clé de version est ignorée"
        );
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn fichier_non_versionne_se_lit() {
        // Ancien format : Document brut, sans `schema_version`.
        let doc = Document::empty();
        let raw = serde_json::to_string_pretty(&doc).unwrap();
        let path = temp("plume_test_legacy.plume.json");
        fs::write(&path, raw).unwrap();
        assert_eq!(read_doc(&path).expect("lecture legacy"), doc);
        let _ = fs::remove_file(&path);
    }

    #[test]
    fn version_future_rejetee() {
        let doc = Document::empty();
        let mut v = serde_json::to_value(&doc).unwrap();
        v.as_object_mut()
            .unwrap()
            .insert("schema_version".into(), serde_json::json!(999));
        let path = temp("plume_test_future.plume.json");
        fs::write(&path, serde_json::to_string(&v).unwrap()).unwrap();
        assert!(
            read_doc(&path).is_err(),
            "une version future doit être refusée"
        );
        let _ = fs::remove_file(&path);
    }
}
