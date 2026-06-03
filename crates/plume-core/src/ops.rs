//! Opérations sur le document — **surface d'outils exposée à Claude**.
//!
//! Une [`Op`] est l'unique façon de muter un [`Document`]. Le pipeline est :
//!
//! 1. [`validate`] : vérifie l'op contre l'état courant, sans rien modifier ;
//! 2. [`apply`] : (re)valide, applique le *reducer* **pur**, et **renvoie
//!    l'op inverse** à empiler sur la pile d'undo.
//!
//! L'inverse dépend de l'état *avant* application (p. ex. supprimer un bloc
//! exige de mémoriser son contenu et son index pour le réinsérer). C'est
//! pourquoi [`apply`] calcule et retourne l'inverse plutôt que de l'exposer
//! comme fonction pure isolée.
//!
//! Le ciblage se fait **par [`BlockId`]**, jamais par offset global. Le `range`
//! d'[`Op::ApplyMark`] est exprimé en **caractères** sur le texte concaténé des
//! runs du bloc.

use serde::{Deserialize, Serialize};
use ts_rs::TS;

use crate::model::{Block, BlockId, Document, Marks, Node, Run};

/// Erreur de validation : renvoyée telle quelle à Claude pour auto-correction
/// (`{ ok: false, reason }`). N'altère jamais l'état.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
pub struct OpError {
    pub reason: String,
}

impl OpError {
    fn new(reason: impl Into<String>) -> Self {
        OpError {
            reason: reason.into(),
        }
    }
}

impl std::fmt::Display for OpError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.reason)
    }
}

impl std::error::Error for OpError {}

/// Patch de marques : `None` = champ inchangé. Pour `link`/`color`, la
/// double-option distingue « inchangé » (`None`) de « effacé » (`Some(None)`).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize, TS)]
#[ts(export, export_to = "../../../src/bindings/")]
pub struct MarkPatch {
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub bold: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub italic: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub underline: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub strike: Option<bool>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    #[ts(optional)]
    pub code: Option<bool>,
    /// `None` = inchangé ; `Some(None)` = retirer le lien ; `Some(Some(url))` = poser.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_some"
    )]
    #[ts(optional)]
    pub link: Option<Option<String>>,
    /// Idem `link` pour la couleur hex `#RRGGBB`.
    #[serde(
        default,
        skip_serializing_if = "Option::is_none",
        deserialize_with = "deserialize_some"
    )]
    #[ts(optional)]
    pub color: Option<Option<String>>,
}

/// Désérialise en enveloppant dans `Some`, pour que `null` devienne `Some(None)`
/// (champ présent et explicitement vidé) et un champ absent reste `None`.
fn deserialize_some<'de, T, D>(deserializer: D) -> Result<Option<T>, D::Error>
where
    T: Deserialize<'de>,
    D: serde::Deserializer<'de>,
{
    T::deserialize(deserializer).map(Some)
}

impl MarkPatch {
    /// Applique le patch à des marques en place.
    fn apply_to(&self, m: &mut Marks) {
        if let Some(v) = self.bold {
            m.bold = v;
        }
        if let Some(v) = self.italic {
            m.italic = v;
        }
        if let Some(v) = self.underline {
            m.underline = v;
        }
        if let Some(v) = self.strike {
            m.strike = v;
        }
        if let Some(v) = self.code {
            m.code = v;
        }
        if let Some(v) = &self.link {
            m.link = v.clone();
        }
        if let Some(v) = &self.color {
            m.color = v.clone();
        }
    }
}

/// Opération atomique. **1 variante ⇒ 1 outil Anthropic** (le `input_schema`
/// de l'outil = les champs de la variante).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, TS)]
#[serde(tag = "op")]
#[ts(export, export_to = "../../../src/bindings/")]
pub enum Op {
    /// Insère `block` à l'index `at`.
    InsertBlock { at: usize, block: Block },
    /// Supprime le bloc `id`.
    DeleteBlock { id: BlockId },
    /// Déplace le bloc `id` vers l'index `to`.
    MoveBlock { id: BlockId, to: usize },
    /// Remplace contenu **et** type du bloc `id`.
    SetNode { id: BlockId, node: Node },
    /// Remplace les runs (texte + marks) du bloc `id`.
    SetRuns { id: BlockId, runs: Vec<Run> },
    /// Applique `mark` sur un range de caractères du texte concaténé du bloc.
    ApplyMark {
        id: BlockId,
        range: (usize, usize),
        mark: MarkPatch,
    },
    /// Remplace les runs d'une cellule de table.
    SetTableCell {
        id: BlockId,
        row: usize,
        col: usize,
        runs: Vec<Run>,
    },
    /// Met à jour les métadonnées (champs `None` = inchangés).
    SetMeta {
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        title: Option<String>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        #[ts(optional)]
        lang: Option<String>,
    },
}

// ---------------------------------------------------------------------------
// Helpers de lecture du modèle
// ---------------------------------------------------------------------------

/// Index du bloc `id`, ou erreur s'il n'existe pas.
fn index_of(doc: &Document, id: &BlockId) -> Result<usize, OpError> {
    doc.blocks
        .iter()
        .position(|b| &b.id == id)
        .ok_or_else(|| OpError::new(format!("bloc introuvable : {}", id.0)))
}

/// Runs d'un nœud porteur de texte inline (paragraphe, titre, item, citation).
fn node_runs(node: &Node) -> Option<&Vec<Run>> {
    match node {
        Node::Paragraph { runs }
        | Node::Heading { runs, .. }
        | Node::ListItem { runs, .. }
        | Node::Quote { runs } => Some(runs),
        _ => None,
    }
}

fn node_runs_mut(node: &mut Node) -> Option<&mut Vec<Run>> {
    match node {
        Node::Paragraph { runs }
        | Node::Heading { runs, .. }
        | Node::ListItem { runs, .. }
        | Node::Quote { runs } => Some(runs),
        _ => None,
    }
}

/// Longueur en caractères du texte concaténé d'une suite de runs.
fn runs_char_len(runs: &[Run]) -> usize {
    runs.iter().map(|r| r.text.chars().count()).sum()
}

// ---------------------------------------------------------------------------
// Validation (§5 de la spec)
// ---------------------------------------------------------------------------

fn is_hex_color(s: &str) -> bool {
    s.len() == 7 && s.starts_with('#') && s[1..].chars().all(|c| c.is_ascii_hexdigit())
}

/// Validation légère d'URL absolue : `scheme://reste`, schéma alphanumérique.
fn is_absolute_url(s: &str) -> bool {
    match s.find("://") {
        Some(pos) if pos > 0 && pos + 3 < s.len() => {
            let scheme = &s[..pos];
            scheme
                .chars()
                .next()
                .is_some_and(|c| c.is_ascii_alphabetic())
                && scheme
                    .chars()
                    .all(|c| c.is_ascii_alphanumeric() || matches!(c, '+' | '-' | '.'))
        }
        _ => false,
    }
}

fn validate_marks(m: &Marks) -> Result<(), OpError> {
    if let Some(c) = &m.color {
        if !is_hex_color(c) {
            return Err(OpError::new(format!(
                "couleur invalide : {c} (attendu #RRGGBB)"
            )));
        }
    }
    if let Some(l) = &m.link {
        if !is_absolute_url(l) {
            return Err(OpError::new(format!("lien non absolu : {l}")));
        }
    }
    Ok(())
}

fn validate_runs(runs: &[Run]) -> Result<(), OpError> {
    runs.iter().try_for_each(|r| validate_marks(&r.marks))
}

fn validate_mark_patch(p: &MarkPatch) -> Result<(), OpError> {
    if let Some(Some(c)) = &p.color {
        if !is_hex_color(c) {
            return Err(OpError::new(format!(
                "couleur invalide : {c} (attendu #RRGGBB)"
            )));
        }
    }
    if let Some(Some(l)) = &p.link {
        if !is_absolute_url(l) {
            return Err(OpError::new(format!("lien non absolu : {l}")));
        }
    }
    Ok(())
}

/// Valide un nœud isolé (bornes de niveau, table rectangulaire, marks, image).
fn validate_node(node: &Node) -> Result<(), OpError> {
    match node {
        Node::Heading { level, runs } => {
            if !(1..=6).contains(level) {
                return Err(OpError::new(format!(
                    "niveau de titre hors 1..=6 : {level}"
                )));
            }
            validate_runs(runs)
        }
        Node::ListItem { level, runs, .. } => {
            if *level > 5 {
                return Err(OpError::new(format!(
                    "niveau de liste hors 0..=5 : {level}"
                )));
            }
            validate_runs(runs)
        }
        Node::Paragraph { runs } | Node::Quote { runs } => validate_runs(runs),
        Node::CodeBlock { .. } | Node::PageBreak => Ok(()),
        Node::Image { width_pct, .. } => match width_pct {
            Some(w) if *w > 100 => Err(OpError::new(format!("largeur image hors 0..=100 : {w}"))),
            _ => Ok(()),
        },
        Node::Table { rows } => {
            let width = rows.first().map(|r| r.len()).unwrap_or(0);
            for row in rows {
                if row.len() != width {
                    return Err(OpError::new("table non rectangulaire"));
                }
                for cell in row {
                    validate_runs(&cell.runs)?;
                }
            }
            Ok(())
        }
    }
}

/// Vérifie qu'une op est applicable à `doc`, **sans rien modifier**.
pub fn validate(doc: &Document, op: &Op) -> Result<(), OpError> {
    match op {
        Op::InsertBlock { at, block } => {
            if *at > doc.blocks.len() {
                return Err(OpError::new(format!(
                    "index d'insertion hors bornes : {at} > {}",
                    doc.blocks.len()
                )));
            }
            if doc.blocks.iter().any(|b| b.id == block.id) {
                return Err(OpError::new(format!(
                    "identifiant déjà présent : {}",
                    block.id.0
                )));
            }
            validate_node(&block.node)
        }
        Op::DeleteBlock { id } => index_of(doc, id).map(|_| ()),
        Op::MoveBlock { id, to } => {
            let _ = index_of(doc, id)?;
            if *to >= doc.blocks.len() {
                return Err(OpError::new(format!(
                    "index de destination hors bornes : {to} >= {}",
                    doc.blocks.len()
                )));
            }
            Ok(())
        }
        Op::SetNode { id, node } => {
            let _ = index_of(doc, id)?;
            validate_node(node)
        }
        Op::SetRuns { id, runs } => {
            let idx = index_of(doc, id)?;
            if node_runs(&doc.blocks[idx].node).is_none() {
                return Err(OpError::new("le bloc ne porte pas de runs"));
            }
            validate_runs(runs)
        }
        Op::ApplyMark { id, range, mark } => {
            let idx = index_of(doc, id)?;
            let runs = node_runs(&doc.blocks[idx].node)
                .ok_or_else(|| OpError::new("le bloc ne porte pas de runs"))?;
            let (a, b) = *range;
            let len = runs_char_len(runs);
            if a > b || b > len {
                return Err(OpError::new(format!(
                    "range invalide : ({a},{b}) hors 0..={len}"
                )));
            }
            validate_mark_patch(mark)
        }
        Op::SetTableCell { id, row, col, runs } => {
            let idx = index_of(doc, id)?;
            match &doc.blocks[idx].node {
                Node::Table { rows } => {
                    if *row >= rows.len() || *col >= rows[*row].len() {
                        return Err(OpError::new("cellule hors bornes"));
                    }
                    validate_runs(runs)
                }
                _ => Err(OpError::new("le bloc n'est pas une table")),
            }
        }
        Op::SetMeta { .. } => Ok(()),
    }
}

// ---------------------------------------------------------------------------
// Application (reducer pur) + calcul de l'inverse
// ---------------------------------------------------------------------------

/// Découpe les runs sur `[a, b)` et applique `patch` à la portion intérieure,
/// puis fusionne les runs adjacents de mêmes marques.
fn apply_mark_to_runs(runs: &mut Vec<Run>, a: usize, b: usize, patch: &MarkPatch) {
    if a == b {
        return;
    }
    let mut result: Vec<Run> = Vec::new();
    let mut offset = 0usize;
    for run in std::mem::take(runs) {
        let chars: Vec<char> = run.text.chars().collect();
        let len = chars.len();
        let (start, end) = (offset, offset + len);
        offset = end;

        if end <= a || start >= b {
            result.push(run); // entièrement hors range
            continue;
        }
        let cut1 = a.clamp(start, end) - start; // fin de la partie gauche
        let cut2 = b.clamp(start, end) - start; // début de la partie droite

        let mk = |slice: &[char], marks: Marks| Run {
            text: slice.iter().collect(),
            marks,
        };
        if cut1 > 0 {
            result.push(mk(&chars[..cut1], run.marks.clone()));
        }
        let mut mid_marks = run.marks.clone();
        patch.apply_to(&mut mid_marks);
        result.push(mk(&chars[cut1..cut2], mid_marks));
        if cut2 < len {
            result.push(mk(&chars[cut2..], run.marks.clone()));
        }
    }
    *runs = coalesce(result);
}

/// Fusionne les runs adjacents partageant les mêmes marques ; retire les vides.
fn coalesce(runs: Vec<Run>) -> Vec<Run> {
    let mut out: Vec<Run> = Vec::new();
    for r in runs {
        if r.text.is_empty() {
            continue;
        }
        match out.last_mut() {
            Some(last) if last.marks == r.marks => last.text.push_str(&r.text),
            _ => out.push(r),
        }
    }
    out
}

/// Valide puis applique `op` à `doc`, et renvoie l'**op inverse** (pour l'undo).
///
/// Garanti : appliquer l'inverse renvoyé restaure exactement l'état précédent.
/// En cas d'erreur de validation, `doc` n'est pas modifié.
pub fn apply(doc: &mut Document, op: Op) -> Result<Op, OpError> {
    validate(doc, &op)?;
    let inverse = match op {
        Op::InsertBlock { at, block } => {
            let id = block.id.clone();
            doc.blocks.insert(at, block);
            Op::DeleteBlock { id }
        }
        Op::DeleteBlock { id } => {
            let idx = index_of(doc, &id)?;
            let block = doc.blocks.remove(idx);
            Op::InsertBlock { at: idx, block }
        }
        Op::MoveBlock { id, to } => {
            let from = index_of(doc, &id)?;
            let block = doc.blocks.remove(from);
            doc.blocks.insert(to.min(doc.blocks.len()), block);
            Op::MoveBlock { id, to: from }
        }
        Op::SetNode { id, node } => {
            let idx = index_of(doc, &id)?;
            let old = std::mem::replace(&mut doc.blocks[idx].node, node);
            Op::SetNode { id, node: old }
        }
        Op::SetRuns { id, runs } => {
            let idx = index_of(doc, &id)?;
            let slot = node_runs_mut(&mut doc.blocks[idx].node)
                .ok_or_else(|| OpError::new("le bloc ne porte pas de runs"))?;
            let old = std::mem::replace(slot, runs);
            Op::SetRuns { id, runs: old }
        }
        Op::ApplyMark { id, range, mark } => {
            let idx = index_of(doc, &id)?;
            let slot = node_runs_mut(&mut doc.blocks[idx].node)
                .ok_or_else(|| OpError::new("le bloc ne porte pas de runs"))?;
            let old = slot.clone();
            apply_mark_to_runs(slot, range.0, range.1, &mark);
            // Inverse robuste : restaurer l'intégralité des runs d'origine.
            Op::SetRuns { id, runs: old }
        }
        Op::SetTableCell { id, row, col, runs } => {
            let idx = index_of(doc, &id)?;
            match &mut doc.blocks[idx].node {
                Node::Table { rows } => {
                    let old = std::mem::replace(&mut rows[row][col].runs, runs);
                    Op::SetTableCell {
                        id,
                        row,
                        col,
                        runs: old,
                    }
                }
                _ => return Err(OpError::new("le bloc n'est pas une table")),
            }
        }
        Op::SetMeta { title, lang } => {
            let old_title = title.as_ref().map(|_| doc.meta.title.clone());
            let old_lang = lang.as_ref().map(|_| doc.meta.lang.clone());
            if let Some(t) = title {
                doc.meta.title = t;
            }
            if let Some(l) = lang {
                doc.meta.lang = l;
            }
            Op::SetMeta {
                title: old_title,
                lang: old_lang,
            }
        }
    };
    Ok(inverse)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::model::{Cell, Meta};

    fn doc() -> Document {
        Document {
            meta: Meta {
                title: "T".into(),
                lang: "fr".into(),
            },
            blocks: vec![
                Block::new(Node::Heading {
                    level: 1,
                    runs: vec![Run::plain("Titre")],
                }),
                Block::new(Node::Paragraph {
                    runs: vec![Run::plain("Bonjour le monde")],
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
            ],
        }
    }

    /// Applique `op` à `d`, vérifie que l'état change, puis applique l'inverse
    /// renvoyé et vérifie le retour exact à l'état initial.
    fn assert_invertible(mut d: Document, op: Op) {
        let original = d.clone();
        let inverse = apply(&mut d, op).expect("apply doit réussir");
        assert_ne!(d, original, "l'op devrait modifier le document");
        apply(&mut d, inverse).expect("apply inverse doit réussir");
        assert_eq!(d, original, "l'inverse doit restaurer l'état initial");
    }

    #[test]
    fn insert_block_inversible() {
        assert_invertible(
            doc(),
            Op::InsertBlock {
                at: 1,
                block: Block::new(Node::Paragraph {
                    runs: vec![Run::plain("nouveau")],
                }),
            },
        );
    }

    #[test]
    fn delete_block_inversible() {
        let d = doc();
        let id = d.blocks[1].id.clone();
        assert_invertible(d, Op::DeleteBlock { id });
    }

    #[test]
    fn move_block_inversible() {
        let d = doc();
        let id = d.blocks[0].id.clone();
        assert_invertible(d, Op::MoveBlock { id, to: 2 });
    }

    #[test]
    fn set_runs_inversible() {
        let d = doc();
        let id = d.blocks[1].id.clone();
        assert_invertible(
            d,
            Op::SetRuns {
                id,
                runs: vec![Run::plain("autre texte")],
            },
        );
    }

    #[test]
    fn set_node_inversible() {
        let d = doc();
        let id = d.blocks[1].id.clone();
        assert_invertible(
            d,
            Op::SetNode {
                id,
                node: Node::Quote {
                    runs: vec![Run::plain("citation")],
                },
            },
        );
    }

    #[test]
    fn apply_mark_inversible() {
        let d = doc();
        let id = d.blocks[1].id.clone();
        assert_invertible(
            d,
            Op::ApplyMark {
                id,
                range: (0, 7), // "Bonjour"
                mark: MarkPatch {
                    bold: Some(true),
                    ..MarkPatch::default()
                },
            },
        );
    }

    #[test]
    fn set_table_cell_inversible() {
        let d = doc();
        let id = d.blocks[2].id.clone();
        assert_invertible(
            d,
            Op::SetTableCell {
                id,
                row: 0,
                col: 1,
                runs: vec![Run::plain("B!")],
            },
        );
    }

    #[test]
    fn set_meta_inversible() {
        assert_invertible(
            doc(),
            Op::SetMeta {
                title: Some("Nouveau titre".into()),
                lang: None,
            },
        );
    }

    #[test]
    fn apply_mark_decoupe_correctement() {
        let mut d = doc();
        let id = d.blocks[1].id.clone();
        // "Bonjour le monde" : marque le mot "monde" (offsets 11..16).
        apply(
            &mut d,
            Op::ApplyMark {
                id: id.clone(),
                range: (11, 16),
                mark: MarkPatch {
                    bold: Some(true),
                    ..MarkPatch::default()
                },
            },
        )
        .unwrap();
        let runs = match &d.blocks[1].node {
            Node::Paragraph { runs } => runs,
            _ => unreachable!(),
        };
        assert_eq!(runs.len(), 2);
        assert_eq!(runs[0].text, "Bonjour le ");
        assert!(!runs[0].marks.bold);
        assert_eq!(runs[1].text, "monde");
        assert!(runs[1].marks.bold);
    }

    // ---- Erreurs de validation : l'état ne doit pas changer ----

    #[test]
    fn validation_rejette_id_inconnu() {
        let mut d = doc();
        let before = d.clone();
        let err = apply(&mut d, Op::DeleteBlock { id: BlockId::new() });
        assert!(err.is_err());
        assert_eq!(d, before, "un échec ne doit pas modifier le document");
    }

    #[test]
    fn validation_rejette_heading_hors_bornes() {
        let d = doc();
        let id = d.blocks[0].id.clone();
        let err = validate(
            &d,
            &Op::SetNode {
                id,
                node: Node::Heading {
                    level: 9,
                    runs: vec![],
                },
            },
        );
        assert!(err.is_err());
    }

    #[test]
    fn validation_rejette_couleur_invalide() {
        let d = doc();
        let id = d.blocks[1].id.clone();
        let err = validate(
            &d,
            &Op::ApplyMark {
                id,
                range: (0, 1),
                mark: MarkPatch {
                    color: Some(Some("rouge".into())),
                    ..MarkPatch::default()
                },
            },
        );
        assert!(err.is_err());
    }

    #[test]
    fn validation_rejette_range_hors_bornes() {
        let d = doc();
        let id = d.blocks[1].id.clone();
        let err = validate(
            &d,
            &Op::ApplyMark {
                id,
                range: (0, 999),
                mark: MarkPatch::default(),
            },
        );
        assert!(err.is_err());
    }

    #[test]
    fn validation_rejette_table_non_rectangulaire() {
        let err = validate_node(&Node::Table {
            rows: vec![
                vec![Cell::default(), Cell::default()],
                vec![Cell::default()],
            ],
        });
        assert!(err.is_err());
    }

    #[test]
    fn mark_patch_double_option_round_trip() {
        // Some(None) (effacer) ≠ None (inchangé) après round-trip JSON.
        let clear = MarkPatch {
            link: Some(None),
            ..MarkPatch::default()
        };
        let json = serde_json::to_string(&clear).unwrap();
        assert_eq!(json, r#"{"link":null}"#);
        let back: MarkPatch = serde_json::from_str(&json).unwrap();
        assert_eq!(back.link, Some(None));

        let unchanged = MarkPatch::default();
        let json = serde_json::to_string(&unchanged).unwrap();
        assert_eq!(json, "{}");
        let back: MarkPatch = serde_json::from_str(&json).unwrap();
        assert_eq!(back.link, None);
    }
}
