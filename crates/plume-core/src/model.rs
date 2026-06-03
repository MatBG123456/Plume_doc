//! Modèle de document de Plume — **source de vérité**.
//!
//! Un document est un `Vec<Block>` ordonné : l'ordre du vecteur = l'ordre du
//! document. Chaque bloc porte un [`BlockId`] (ULID) stable, jamais réutilisé,
//! qui sert de cible aux opérations (Wave 2) plutôt qu'un offset global fragile.
//!
//! Tous les types dérivent :
//! - `serde` → sérialisation JSON natif (`.plume.json`) ;
//! - `ts-rs` → types TypeScript générés pour le front (cf. `src/bindings/`).
//!
//! Les énumérations utilisent `#[serde(tag = "type")]` : le JSON est
//! *internally tagged* (`{"type":"Paragraph","runs":[...]}`), lisible et
//! stable pour un LLM.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

/// Identifiant stable d'un bloc (ULID). Jamais réutilisé après suppression.
#[derive(Debug, Clone, PartialEq, Eq, Hash, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/bindings/")]
pub struct BlockId(pub String);

impl BlockId {
    /// Génère un nouvel identifiant unique et croissant (ULID).
    pub fn new() -> Self {
        BlockId(ulid::Ulid::new().to_string())
    }
}

impl Default for BlockId {
    fn default() -> Self {
        Self::new()
    }
}

/// Document complet : métadonnées + suite ordonnée de blocs.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/bindings/")]
pub struct Document {
    pub meta: Meta,
    pub blocks: Vec<Block>,
}

impl Document {
    /// Document vide : métadonnées par défaut, aucun bloc.
    pub fn empty() -> Self {
        Document::default()
    }
}

/// Métadonnées du document.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/bindings/")]
pub struct Meta {
    pub title: String,
    /// Code langue ISO : `"fr"`, `"en"`...
    pub lang: String,
}

impl Default for Meta {
    fn default() -> Self {
        Meta {
            title: String::new(),
            lang: "fr".to_string(),
        }
    }
}

/// Un bloc = un identifiant stable + un nœud (son contenu typé).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/bindings/")]
pub struct Block {
    pub id: BlockId,
    pub node: Node,
}

impl Block {
    /// Construit un bloc avec un nouvel identifiant.
    pub fn new(node: Node) -> Self {
        Block {
            id: BlockId::new(),
            node,
        }
    }
}

/// Contenu typé d'un bloc.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "type")]
#[ts(export, export_to = "../../../src/bindings/")]
pub enum Node {
    Paragraph {
        runs: Vec<Run>,
    },
    Heading {
        /// `1..=6`
        level: u8,
        runs: Vec<Run>,
    },
    ListItem {
        ordered: bool,
        /// `0..=5`
        level: u8,
        runs: Vec<Run>,
    },
    Quote {
        runs: Vec<Run>,
    },
    CodeBlock {
        lang: Option<String>,
        text: String,
    },
    /// Table rectangulaire : toutes les lignes ont la même largeur.
    Table {
        rows: Vec<Vec<Cell>>,
    },
    Image {
        src: String,
        alt: String,
        /// Largeur en pourcentage de la colonne, optionnelle.
        width_pct: Option<u8>,
    },
    PageBreak,
}

/// Segment de texte inline + ses styles.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/bindings/")]
pub struct Run {
    pub text: String,
    pub marks: Marks,
}

impl Run {
    /// Run de texte brut, sans aucune marque.
    pub fn plain(text: impl Into<String>) -> Self {
        Run {
            text: text.into(),
            marks: Marks::default(),
        }
    }
}

/// Styles applicables à un [`Run`].
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/bindings/")]
pub struct Marks {
    pub bold: bool,
    pub italic: bool,
    pub underline: bool,
    pub strike: bool,
    pub code: bool,
    /// URL absolue, ou `None`.
    pub link: Option<String>,
    /// Couleur hex `#RRGGBB`, ou `None`.
    pub color: Option<String>,
}

/// Cellule de table : une suite de runs.
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/bindings/")]
pub struct Cell {
    pub runs: Vec<Run>,
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Construit un document de démonstration couvrant chaque variante de `Node`.
    fn fixture() -> Document {
        Document {
            meta: Meta {
                title: "Démo".into(),
                lang: "fr".into(),
            },
            blocks: vec![
                Block::new(Node::Heading {
                    level: 1,
                    runs: vec![Run::plain("Titre")],
                }),
                Block::new(Node::Paragraph {
                    runs: vec![
                        Run::plain("Un "),
                        Run {
                            text: "mot".into(),
                            marks: Marks {
                                bold: true,
                                color: Some("#2563EB".into()),
                                ..Marks::default()
                            },
                        },
                    ],
                }),
                Block::new(Node::ListItem {
                    ordered: false,
                    level: 0,
                    runs: vec![Run::plain("élément")],
                }),
                Block::new(Node::Quote {
                    runs: vec![Run::plain("citation")],
                }),
                Block::new(Node::CodeBlock {
                    lang: Some("rust".into()),
                    text: "fn main() {}".into(),
                }),
                Block::new(Node::Table {
                    rows: vec![vec![
                        Cell {
                            runs: vec![Run::plain("a")],
                        },
                        Cell {
                            runs: vec![Run::plain("b")],
                        },
                    ]],
                }),
                Block::new(Node::Image {
                    src: "img.png".into(),
                    alt: "alt".into(),
                    width_pct: Some(50),
                }),
                Block::new(Node::PageBreak),
            ],
        }
    }

    #[test]
    fn document_vide_par_defaut() {
        let doc = Document::empty();
        assert!(doc.blocks.is_empty());
        assert_eq!(doc.meta.lang, "fr");
        assert_eq!(doc.meta.title, "");
    }

    #[test]
    fn round_trip_json() {
        let doc = fixture();
        let json = serde_json::to_string(&doc).expect("sérialisation");
        let back: Document = serde_json::from_str(&json).expect("désérialisation");
        assert_eq!(doc, back, "le round-trip JSON doit préserver le document");
    }

    #[test]
    fn enum_node_internally_tagged() {
        let json = serde_json::to_value(Node::PageBreak).unwrap();
        assert_eq!(json, serde_json::json!({ "type": "PageBreak" }));
    }

    #[test]
    fn block_id_unique() {
        assert_ne!(BlockId::new(), BlockId::new());
    }
}
