//! Import de documents externes vers le modèle Plume.
//!
//! - **Markdown** (`pulldown-cmark`) : titres, paragraphes, listes (imbriquées),
//!   blocs de code, tableaux, gras/italique/barré/code/lien.
//! - **.docx** (zip + `word/document.xml` via `quick-xml`) : titres (styles
//!   Heading), paragraphes, **tableaux** (`w:tbl`), listes (niveau via `ilvl`),
//!   gras/italique/souligné/barré, **couleur** (`w:color`) et **hyperliens**
//!   (`w:hyperlink` résolu via `document.xml.rels`). *(L'ordonné des listes —
//!   puce vs numéro — n'est pas distingué : il faudrait lire `numbering.xml`.)*
//!
//! Ces conversions sont *lossy* par nature : ce qui n'est pas représentable dans
//! le modèle est ignoré. Le résultat est un `Document` typé, prêt pour le
//! pipeline d'édition (chaque bloc reçoit un id neuf). (Le PDF n'est pas encore
//! pris en charge : l'extracteur est lourd et le texte y est peu structuré.)

use std::io::Read;

use plume_core::{Block, Cell, Document, Marks, Meta, Node, Run};
use serde::Serialize;

use crate::Shared;

// ===========================================================================
// Helpers communs
// ===========================================================================

fn ext_of(path: &str) -> String {
    std::path::Path::new(path)
        .extension()
        .map(|e| e.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

fn name_of(path: &str) -> String {
    std::path::Path::new(path)
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string())
}

/// Borne le texte à `max` caractères (évite de faire exploser le prompt).
fn truncate_chars(s: &str, max: usize) -> String {
    if s.chars().count() <= max {
        return s.to_string();
    }
    let mut out: String = s.chars().take(max).collect();
    out.push_str("\n…[tronqué]");
    out
}

/// Fusionne les runs adjacents de mêmes marques et retire les runs vides.
fn merge_runs(runs: Vec<Run>) -> Vec<Run> {
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

/// Texte brut d'un document (pour fournir un fichier en contexte au chat).
fn doc_plain_text(doc: &Document) -> String {
    doc.blocks
        .iter()
        .map(|b| node_text(&b.node))
        .filter(|t| !t.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n")
}

fn node_text(node: &Node) -> String {
    match node {
        Node::Paragraph { runs }
        | Node::Heading { runs, .. }
        | Node::ListItem { runs, .. }
        | Node::Quote { runs } => runs.iter().map(|r| r.text.as_str()).collect(),
        Node::CodeBlock { text, .. } => text.clone(),
        Node::Table { rows } => rows
            .iter()
            .map(|row| {
                row.iter()
                    .map(|c| c.runs.iter().map(|r| r.text.as_str()).collect::<String>())
                    .collect::<Vec<_>>()
                    .join(" | ")
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Node::Image { alt, .. } => format!("[image : {alt}]"),
        Node::PageBreak => String::new(),
    }
}

// ===========================================================================
// Markdown
// ===========================================================================

use pulldown_cmark::{CodeBlockKind, Event, HeadingLevel, Options, Parser, Tag, TagEnd};

fn h_level(l: HeadingLevel) -> u8 {
    match l {
        HeadingLevel::H1 => 1,
        HeadingLevel::H2 => 2,
        HeadingLevel::H3 => 3,
        HeadingLevel::H4 => 4,
        HeadingLevel::H5 => 5,
        HeadingLevel::H6 => 6,
    }
}

enum Cur {
    None,
    Para,
    Heading(u8),
    Item { ordered: bool, level: u8 },
    Code { lang: Option<String>, text: String },
}

/// Termine le bloc courant et le pousse dans `blocks` (le 1er H1 devient le titre).
fn flush_block(
    cur: &mut Cur,
    runs: &mut Vec<Run>,
    blocks: &mut Vec<Block>,
    title: &mut Option<String>,
) {
    let taken = merge_runs(std::mem::take(runs));
    match std::mem::replace(cur, Cur::None) {
        Cur::Para if !taken.is_empty() => blocks.push(Block::new(Node::Paragraph { runs: taken })),
        Cur::Heading(level) => {
            let text: String = taken.iter().map(|r| r.text.as_str()).collect();
            if level == 1 && title.is_none() && !text.trim().is_empty() {
                *title = Some(text.trim().to_string());
            } else if !taken.is_empty() {
                blocks.push(Block::new(Node::Heading { level, runs: taken }));
            }
        }
        Cur::Item { ordered, level } => blocks.push(Block::new(Node::ListItem {
            ordered,
            level,
            runs: taken,
        })),
        Cur::Code { lang, text } => blocks.push(Block::new(Node::CodeBlock { lang, text })),
        _ => {}
    }
}

pub fn from_markdown(md: &str) -> Document {
    let parser = Parser::new_ext(md, Options::ENABLE_TABLES | Options::ENABLE_STRIKETHROUGH);

    let mut blocks: Vec<Block> = Vec::new();
    let mut runs: Vec<Run> = Vec::new();
    let mut marks = Marks::default();
    let mut cur = Cur::None;
    let mut list_stack: Vec<bool> = Vec::new(); // ordered, par niveau
    let mut in_item = false;
    let mut title: Option<String> = None;

    // Tableaux : le contenu d'une cellule s'accumule dans `runs`.
    let mut table_rows: Vec<Vec<Cell>> = Vec::new();
    let mut table_row: Vec<Cell> = Vec::new();

    for ev in parser {
        match ev {
            Event::Start(tag) => match tag {
                Tag::Paragraph => {
                    if !in_item {
                        cur = Cur::Para;
                    }
                }
                Tag::Heading { level, .. } => cur = Cur::Heading(h_level(level)),
                Tag::CodeBlock(kind) => {
                    let lang = match kind {
                        CodeBlockKind::Fenced(l) if !l.is_empty() => Some(l.to_string()),
                        _ => None,
                    };
                    cur = Cur::Code {
                        lang,
                        text: String::new(),
                    };
                }
                Tag::List(start) => {
                    // Texte de l'item parent (avant une sous-liste) : on le flush.
                    if matches!(cur, Cur::Item { .. }) {
                        flush_block(&mut cur, &mut runs, &mut blocks, &mut title);
                        in_item = false;
                    }
                    list_stack.push(start.is_some());
                }
                Tag::Item => {
                    in_item = true;
                    let ordered = *list_stack.last().unwrap_or(&false);
                    let level = (list_stack.len().saturating_sub(1)).min(5) as u8;
                    cur = Cur::Item { ordered, level };
                }
                Tag::Emphasis => marks.italic = true,
                Tag::Strong => marks.bold = true,
                Tag::Strikethrough => marks.strike = true,
                Tag::Link { dest_url, .. } => marks.link = Some(dest_url.to_string()),
                Tag::Table(_) => table_rows.clear(),
                Tag::TableHead | Tag::TableRow => table_row.clear(),
                Tag::TableCell => runs.clear(),
                _ => {}
            },
            Event::End(tag) => match tag {
                TagEnd::Paragraph => {
                    if !in_item {
                        flush_block(&mut cur, &mut runs, &mut blocks, &mut title);
                    }
                }
                TagEnd::Heading(_) | TagEnd::CodeBlock => {
                    flush_block(&mut cur, &mut runs, &mut blocks, &mut title)
                }
                TagEnd::Item => {
                    flush_block(&mut cur, &mut runs, &mut blocks, &mut title);
                    in_item = false;
                }
                TagEnd::List(_) => {
                    list_stack.pop();
                }
                TagEnd::Emphasis => marks.italic = false,
                TagEnd::Strong => marks.bold = false,
                TagEnd::Strikethrough => marks.strike = false,
                TagEnd::Link => marks.link = None,
                TagEnd::TableCell => {
                    table_row.push(Cell {
                        runs: merge_runs(std::mem::take(&mut runs)),
                    });
                }
                TagEnd::TableHead | TagEnd::TableRow => {
                    table_rows.push(std::mem::take(&mut table_row))
                }
                TagEnd::Table => {
                    if !table_rows.is_empty() {
                        blocks.push(Block::new(Node::Table {
                            rows: std::mem::take(&mut table_rows),
                        }));
                    }
                }
                _ => {}
            },
            Event::Text(t) => {
                if let Cur::Code { text, .. } = &mut cur {
                    text.push_str(&t);
                } else {
                    runs.push(Run {
                        text: t.to_string(),
                        marks: marks.clone(),
                    });
                }
            }
            Event::Code(c) => {
                let mut m = marks.clone();
                m.code = true;
                runs.push(Run {
                    text: c.to_string(),
                    marks: m,
                });
            }
            Event::SoftBreak => runs.push(Run::plain(" ")),
            Event::HardBreak => runs.push(Run::plain("\n")),
            _ => {}
        }
    }
    // Flush d'un éventuel bloc resté ouvert.
    flush_block(&mut cur, &mut runs, &mut blocks, &mut title);

    Document {
        meta: Meta {
            title: title.unwrap_or_default(),
            lang: "fr".into(),
        },
        blocks,
    }
}

// ===========================================================================
// .docx
// ===========================================================================

pub fn from_docx(bytes: &[u8]) -> Result<Document, String> {
    use std::io::Cursor;
    let mut zip =
        zip::ZipArchive::new(Cursor::new(bytes)).map_err(|e| format!("docx illisible : {e}"))?;
    let mut xml = String::new();
    zip.by_name("word/document.xml")
        .map_err(|e| format!("word/document.xml absent : {e}"))?
        .read_to_string(&mut xml)
        .map_err(|e| e.to_string())?;
    // Relations (rId → cible) pour résoudre les hyperliens externes (best-effort).
    let mut rels = std::collections::HashMap::new();
    if let Ok(mut f) = zip.by_name("word/_rels/document.xml.rels") {
        let mut s = String::new();
        if f.read_to_string(&mut s).is_ok() {
            rels = parse_rels(&s);
        }
    }
    Ok(docx_xml_to_document(&xml, &rels))
}

/// `document.xml.rels` → map `rId` → cible (URL d'hyperlien externe, etc.).
fn parse_rels(xml: &str) -> std::collections::HashMap<String, String> {
    use quick_xml::events::Event as Xml;
    use quick_xml::reader::Reader;
    let mut reader = Reader::from_str(xml);
    let mut map = std::collections::HashMap::new();
    loop {
        match reader.read_event() {
            Ok(Xml::Start(e)) | Ok(Xml::Empty(e)) if e.name().as_ref() == b"Relationship" => {
                if let (Some(id), Some(target)) = (attr_val(&e, b"Id"), attr_val(&e, b"Target")) {
                    map.insert(id, target);
                }
            }
            Ok(Xml::Eof) | Err(_) => break,
            _ => {}
        }
    }
    map
}

fn attr_val(e: &quick_xml::events::BytesStart, key: &[u8]) -> Option<String> {
    e.attributes().flatten().find_map(|a| {
        if a.key.as_ref() == key {
            Some(String::from_utf8_lossy(a.value.as_ref()).into_owned())
        } else {
            None
        }
    })
}

/// `<w:b/>`, `<w:b w:val="true"/>` ⇒ vrai ; `<w:b w:val="false|0|off"/>` ⇒ faux.
fn on_off(e: &quick_xml::events::BytesStart) -> bool {
    !matches!(
        attr_val(e, b"w:val").as_deref(),
        Some("false" | "0" | "off")
    )
}

/// `w:color` w:val (6 hex) → "#RRGGBB" ; "auto"/invalide → None.
fn hex_color(v: String) -> Option<String> {
    let v = v.trim_start_matches('#');
    if v.len() == 6 && v.chars().all(|c| c.is_ascii_hexdigit()) {
        Some(format!("#{}", v.to_uppercase()))
    } else {
        None
    }
}

fn docx_xml_to_document(xml: &str, rels: &std::collections::HashMap<String, String>) -> Document {
    use quick_xml::events::Event as Xml;
    use quick_xml::reader::Reader;

    let mut reader = Reader::from_str(xml);
    let mut blocks: Vec<Block> = Vec::new();
    let mut title: Option<String> = None;

    let mut runs: Vec<Run> = Vec::new();
    let mut heading: Option<u8> = None;
    let mut is_list = false;
    let mut list_level: u8 = 0;
    // run courant
    let (mut bold, mut italic, mut underline, mut strike) = (false, false, false, false);
    let mut color: Option<String> = None;
    let mut in_text = false;
    let mut run_text = String::new();
    let mut link: Option<String> = None; // hyperlien courant
                                         // tableaux (contenu d'une cellule accumulé dans `runs`)
    let mut in_cell = false;
    let mut table_rows: Vec<Vec<Cell>> = Vec::new();
    let mut table_row: Vec<Cell> = Vec::new();

    loop {
        match reader.read_event() {
            Ok(Xml::Start(e)) | Ok(Xml::Empty(e)) => match e.name().as_ref() {
                b"w:tbl" => table_rows.clear(),
                b"w:tr" => table_row.clear(),
                b"w:tc" => {
                    in_cell = true;
                    runs.clear();
                }
                b"w:p" => {
                    if !in_cell {
                        runs.clear();
                        heading = None;
                        is_list = false;
                        list_level = 0;
                    }
                }
                b"w:hyperlink" => {
                    link = attr_val(&e, b"r:id").and_then(|id| rels.get(&id).cloned());
                }
                b"w:pStyle" if !in_cell => {
                    if let Some(v) = attr_val(&e, b"w:val") {
                        let low = v.to_ascii_lowercase();
                        if let Some(n) = low.strip_prefix("heading") {
                            heading = Some(
                                n.trim()
                                    .parse::<u8>()
                                    .ok()
                                    .map(|x| x.clamp(1, 6))
                                    .unwrap_or(1),
                            );
                        } else if low == "title" {
                            heading = Some(1);
                        }
                    }
                }
                b"w:numPr" => is_list = true,
                b"w:ilvl" => {
                    list_level = attr_val(&e, b"w:val")
                        .and_then(|v| v.parse::<u8>().ok())
                        .unwrap_or(0)
                        .min(5);
                }
                b"w:r" => {
                    bold = false;
                    italic = false;
                    underline = false;
                    strike = false;
                    color = None;
                    run_text.clear();
                }
                b"w:b" => bold = on_off(&e),
                b"w:i" => italic = on_off(&e),
                b"w:u" => underline = on_off(&e),
                b"w:strike" => strike = on_off(&e),
                b"w:color" => color = attr_val(&e, b"w:val").and_then(hex_color),
                b"w:t" => in_text = true,
                b"w:br" => run_text.push('\n'),
                b"w:tab" => run_text.push('\t'),
                _ => {}
            },
            Ok(Xml::Text(t)) => {
                if in_text {
                    run_text.push_str(&t.unescape().unwrap_or_default());
                }
            }
            Ok(Xml::End(e)) => match e.name().as_ref() {
                b"w:t" => in_text = false,
                b"w:r" => {
                    if !run_text.is_empty() {
                        runs.push(Run {
                            text: std::mem::take(&mut run_text),
                            marks: Marks {
                                bold,
                                italic,
                                underline,
                                strike,
                                link: link.clone(),
                                color: color.clone(),
                                ..Default::default()
                            },
                        });
                    }
                }
                b"w:hyperlink" => link = None,
                b"w:p" if !in_cell => {
                    let taken = merge_runs(std::mem::take(&mut runs));
                    if let Some(level) = heading {
                        let text: String = taken.iter().map(|r| r.text.as_str()).collect();
                        if level == 1 && title.is_none() && !text.trim().is_empty() {
                            title = Some(text.trim().to_string());
                        } else if !taken.is_empty() {
                            blocks.push(Block::new(Node::Heading { level, runs: taken }));
                        }
                    } else if is_list {
                        if !taken.is_empty() {
                            blocks.push(Block::new(Node::ListItem {
                                ordered: false,
                                level: list_level,
                                runs: taken,
                            }));
                        }
                    } else if !taken.is_empty() {
                        blocks.push(Block::new(Node::Paragraph { runs: taken }));
                    }
                }
                b"w:tc" => {
                    in_cell = false;
                    table_row.push(Cell {
                        runs: merge_runs(std::mem::take(&mut runs)),
                    });
                }
                b"w:tr" => table_rows.push(std::mem::take(&mut table_row)),
                b"w:tbl" => {
                    if !table_rows.is_empty() {
                        blocks.push(Block::new(Node::Table {
                            rows: std::mem::take(&mut table_rows),
                        }));
                    }
                }
                _ => {}
            },
            Ok(Xml::Eof) | Err(_) => break,
            _ => {}
        }
    }

    Document {
        meta: Meta {
            title: title.unwrap_or_default(),
            lang: "fr".into(),
        },
        blocks,
    }
}

// ===========================================================================
// Commands
// ===========================================================================

fn import_path(path: &str) -> Result<Document, String> {
    let bytes = std::fs::read(path).map_err(|e| e.to_string())?;
    match ext_of(path).as_str() {
        "md" | "markdown" | "txt" | "text" => Ok(from_markdown(&String::from_utf8_lossy(&bytes))),
        "docx" => from_docx(&bytes),
        other => Err(format!("format non supporté : .{other}")),
    }
}

/// Importe un fichier externe (md/markdown/txt/docx) : **remplace** le document
/// d'édition (comme l'ouverture) et le renvoie.
#[tauri::command]
pub fn import_document(path: String, state: tauri::State<'_, Shared>) -> Result<Document, String> {
    let doc = import_path(&path)?;
    let mut s = state.lock().unwrap_or_else(|e| e.into_inner());
    s.doc = doc.clone();
    s.undo.clear();
    s.redo.clear();
    s.last_edit = None;
    Ok(doc)
}

#[derive(Serialize)]
pub struct ContextDoc {
    pub name: String,
    pub text: String,
}

/// Lit un fichier (md/markdown/txt/docx) et renvoie son **texte** (borné) pour le
/// fournir en contexte au chat — sans toucher au document d'édition.
#[tauri::command]
pub fn read_context(path: String) -> Result<ContextDoc, String> {
    let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
    let text = match ext_of(&path).as_str() {
        "md" | "markdown" | "txt" | "text" => String::from_utf8_lossy(&bytes).into_owned(),
        "docx" => doc_plain_text(&from_docx(&bytes)?),
        other => return Err(format!("format non supporté : .{other}")),
    };
    Ok(ContextDoc {
        name: name_of(&path),
        text: truncate_chars(&text, 20_000),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Parse un `document.xml` sans relations (pas d'hyperliens).
    fn docx(xml: &str) -> Document {
        docx_xml_to_document(xml, &std::collections::HashMap::new())
    }

    #[test]
    fn markdown_titres_listes_code() {
        let md = "# Mon titre\n\nUn **gras** et *italique*.\n\n- a\n- b\n  - b1\n\n```rust\nfn x() {}\n```\n";
        let doc = from_markdown(md);
        assert_eq!(doc.meta.title, "Mon titre", "le 1er H1 devient le titre");
        let has_bold = doc.blocks.iter().any(
            |b| matches!(&b.node, Node::Paragraph { runs } if runs.iter().any(|r| r.marks.bold)),
        );
        assert!(has_bold, "le gras doit être préservé");
        let levels: Vec<u8> = doc
            .blocks
            .iter()
            .filter_map(|b| match &b.node {
                Node::ListItem { level, .. } => Some(*level),
                _ => None,
            })
            .collect();
        assert!(
            levels.contains(&0) && levels.contains(&1),
            "niveaux de liste 0 et 1"
        );
        let has_code = doc.blocks.iter().any(
            |b| matches!(&b.node, Node::CodeBlock { lang, .. } if lang.as_deref() == Some("rust")),
        );
        assert!(has_code, "le bloc de code rust doit être présent");
    }

    #[test]
    fn markdown_tableau() {
        let md = "| A | B |\n| --- | --- |\n| 1 | 2 |\n";
        let doc = from_markdown(md);
        let rows = doc
            .blocks
            .iter()
            .find_map(|b| match &b.node {
                Node::Table { rows } => Some(rows.clone()),
                _ => None,
            })
            .expect("un tableau doit être importé");
        assert_eq!(rows.len(), 2, "en-tête + 1 ligne");
        assert_eq!(rows[0].len(), 2, "2 colonnes");
    }

    #[test]
    fn markdown_lien_code_inline_niveaux() {
        let md = "## Niveau 2\n\nUn [lien](https://x.org) et du `code`.\n\n### Niveau 3\n";
        let doc = from_markdown(md);
        let levels: Vec<u8> = doc
            .blocks
            .iter()
            .filter_map(|b| match &b.node {
                Node::Heading { level, .. } => Some(*level),
                _ => None,
            })
            .collect();
        assert!(
            levels.contains(&2) && levels.contains(&3),
            "H2 et H3 préservés"
        );
        let has_link = doc.blocks.iter().any(|b| {
            matches!(&b.node, Node::Paragraph { runs }
                if runs.iter().any(|r| r.marks.link.as_deref() == Some("https://x.org")))
        });
        let has_code = doc.blocks.iter().any(|b| {
            matches!(&b.node, Node::Paragraph { runs }
                if runs.iter().any(|r| r.marks.code && r.text == "code"))
        });
        assert!(has_link, "lien inline préservé");
        assert!(has_code, "code inline préservé");
    }

    #[test]
    fn docx_xml_titres_runs_listes() {
        let xml = r#"<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>
            <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Mon titre</w:t></w:r></w:p>
            <w:p><w:pPr><w:pStyle w:val="Heading2"/></w:pPr><w:r><w:t>Section</w:t></w:r></w:p>
            <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>gras</w:t></w:r><w:r><w:t> normal</w:t></w:r></w:p>
            <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>item</w:t></w:r></w:p>
        </w:body></w:document>"#;
        let doc = docx(xml);
        assert_eq!(
            doc.meta.title, "Mon titre",
            "le 1er Heading1 devient le titre"
        );
        assert!(
            doc.blocks
                .iter()
                .any(|b| matches!(&b.node, Node::Heading { level: 2, runs }
                if runs.iter().map(|r| r.text.as_str()).collect::<String>() == "Section")),
            "Heading2 préservé",
        );
        let para = doc
            .blocks
            .iter()
            .find_map(|b| match &b.node {
                Node::Paragraph { runs } => Some(runs),
                _ => None,
            })
            .expect("un paragraphe");
        assert!(
            para.iter().any(|r| r.text == "gras" && r.marks.bold),
            "run gras"
        );
        assert!(
            para.iter().any(|r| r.text == " normal" && !r.marks.bold),
            "run normal"
        );
        assert!(
            doc.blocks
                .iter()
                .any(|b| matches!(&b.node, Node::ListItem { runs, .. }
                if runs.iter().any(|r| r.text == "item"))),
            "item de liste (numPr) préservé",
        );
    }

    #[test]
    fn docx_b_val_false_nest_pas_gras() {
        let xml = r#"<w:document xmlns:w="x"><w:body><w:p><w:r><w:rPr><w:b w:val="false"/></w:rPr><w:t>x</w:t></w:r></w:p></w:body></w:document>"#;
        let doc = docx(xml);
        let para = doc
            .blocks
            .iter()
            .find_map(|b| match &b.node {
                Node::Paragraph { runs } => Some(runs),
                _ => None,
            })
            .expect("un paragraphe");
        assert!(!para[0].marks.bold, "w:val=\"false\" ⇒ pas gras");
    }

    #[test]
    fn docx_tableau_couleur_niveau() {
        let xml = r#"<w:document xmlns:w="x"><w:body>
            <w:tbl>
                <w:tr><w:tc><w:p><w:r><w:t>A</w:t></w:r></w:p></w:tc>
                      <w:tc><w:p><w:r><w:t>B</w:t></w:r></w:p></w:tc></w:tr>
                <w:tr><w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc>
                      <w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p></w:tc></w:tr>
            </w:tbl>
            <w:p><w:r><w:rPr><w:color w:val="FF0000"/></w:rPr><w:t>rouge</w:t></w:r></w:p>
            <w:p><w:pPr><w:numPr><w:ilvl w:val="2"/></w:numPr></w:pPr><w:r><w:t>sous-item</w:t></w:r></w:p>
        </w:body></w:document>"#;
        let doc = docx(xml);
        // Tableau 2×2.
        let rows = doc
            .blocks
            .iter()
            .find_map(|b| match &b.node {
                Node::Table { rows } => Some(rows),
                _ => None,
            })
            .expect("un tableau");
        assert_eq!(rows.len(), 2);
        assert_eq!(rows[0].len(), 2);
        assert_eq!(rows[0][0].runs[0].text, "A");
        // Couleur de run.
        assert!(
            doc.blocks
                .iter()
                .any(|b| matches!(&b.node, Node::Paragraph { runs }
                if runs.iter().any(|r| r.marks.color.as_deref() == Some("#FF0000")))),
            "couleur de run préservée",
        );
        // Niveau de liste depuis ilvl.
        assert!(
            doc.blocks
                .iter()
                .any(|b| matches!(&b.node, Node::ListItem { level: 2, .. })),
            "niveau de liste (ilvl) préservé",
        );
    }

    #[test]
    fn docx_hyperlien_resolu_via_rels() {
        let xml = r#"<w:document xmlns:w="x"><w:body>
            <w:p><w:hyperlink r:id="rId7"><w:r><w:t>ici</w:t></w:r></w:hyperlink></w:p>
        </w:body></w:document>"#;
        let mut rels = std::collections::HashMap::new();
        rels.insert("rId7".to_string(), "https://example.com".to_string());
        let doc = docx_xml_to_document(xml, &rels);
        assert!(
            doc.blocks.iter().any(|b| matches!(&b.node, Node::Paragraph { runs }
                if runs.iter().any(|r| r.text == "ici" && r.marks.link.as_deref() == Some("https://example.com")))),
            "hyperlien résolu via les relations",
        );
    }
}
