//! Export (Wave 7) : Markdown et `.docx`.
//!
//! Le modèle typé étant la source de vérité, l'export est un *mapping* pur
//! `Document → cible`. (Le PDF, lui, est produit côté front par l'impression du
//! webview, qui réutilise le renderer.) Comme `save`, ces commands reçoivent le
//! document en **snapshot** et écrivent au chemin fourni.

use std::fs;

use plume_core::{Block, Document, Node, Run};

// ===========================================================================
// Markdown
// ===========================================================================

/// Échappe les caractères Markdown structurels d'un texte (hors code).
fn esc(s: &str) -> String {
    let mut o = String::with_capacity(s.len());
    for c in s.chars() {
        if matches!(c, '\\' | '`' | '*' | '_' | '[' | ']' | '<' | '>') {
            o.push('\\');
        }
        o.push(c);
    }
    o
}

/// Longueur de la plus longue suite de backticks consécutifs dans `s`.
fn max_backticks(s: &str) -> usize {
    let (mut max, mut cur) = (0usize, 0usize);
    for c in s.chars() {
        if c == '`' {
            cur += 1;
            max = max.max(cur);
        } else {
            cur = 0;
        }
    }
    max
}

/// Un run inline → Markdown (gras, italique, barré, code, lien, souligné).
/// La couleur n'a pas d'équivalent Markdown : elle est omise (lossy).
fn run_md(r: &Run) -> String {
    if r.text.is_empty() {
        return String::new(); // évite un délimiteur vide (****) ou un lien sans texte
    }
    let m = &r.marks;
    if m.code {
        // Délimiteur de (N+1) backticks pour préserver le contenu littéral,
        // avec un espace de marge si le texte commence/finit par un backtick.
        let fence = "`".repeat(max_backticks(&r.text) + 1);
        let pad = if r.text.starts_with('`') || r.text.ends_with('`') {
            " "
        } else {
            ""
        };
        return format!("{fence}{pad}{}{pad}{fence}", r.text);
    }
    let mut t = esc(&r.text);
    if m.underline {
        t = format!("<u>{t}</u>");
    }
    if m.strike {
        t = format!("~~{t}~~");
    }
    if m.italic {
        t = format!("*{t}*");
    }
    if m.bold {
        t = format!("**{t}**");
    }
    if let Some(link) = &m.link {
        // Destination encadrée par <...> : autorise parenthèses et espaces (qui
        // casseraient la forme nue) ; on neutralise les caractères interdits.
        let dest = link
            .replace('\\', "%5C")
            .replace('<', "%3C")
            .replace('>', "%3E");
        t = format!("[{t}](<{dest}>)");
    }
    t
}

fn runs_md(runs: &[Run]) -> String {
    runs.iter().map(run_md).collect()
}

/// Contenu d'une cellule de table sur une seule ligne, pipes échappés.
fn cell_md(runs: &[Run]) -> String {
    runs_md(runs).replace('|', "\\|").replace('\n', " ")
}

/// Rend un bloc non-liste en Markdown.
fn block_md(node: &Node) -> String {
    match node {
        Node::Paragraph { runs } => runs_md(runs),
        Node::Heading { level, runs } => {
            let hashes = "#".repeat((*level).clamp(1, 6) as usize);
            format!("{hashes} {}", runs_md(runs))
        }
        Node::Quote { runs } => format!("> {}", runs_md(runs)),
        Node::CodeBlock { lang, text } => {
            let lang = lang.clone().unwrap_or_default();
            // Fence d'au moins 3 backticks, plus longue que toute suite interne.
            let fence = "`".repeat(max_backticks(text).max(2) + 1);
            format!("{fence}{lang}\n{text}\n{fence}")
        }
        Node::Image { src, alt, .. } => format!("![{}]({src})", esc(alt)),
        Node::PageBreak => "---".to_string(),
        Node::Table { rows } => table_md(rows),
        // Un item isolé (le regroupement est fait par l'appelant) : puce simple.
        Node::ListItem {
            ordered,
            level,
            runs,
        } => list_line(*ordered, *level, runs),
    }
}

fn list_line(ordered: bool, level: u8, runs: &[Run]) -> String {
    let indent = "  ".repeat(level as usize);
    let marker = if ordered { "1." } else { "-" };
    format!("{indent}{marker} {}", runs_md(runs))
}

fn table_md(rows: &[Vec<plume_core::Cell>]) -> String {
    if rows.is_empty() {
        return String::new();
    }
    let width = rows[0].len().max(1);
    let mut lines = Vec::new();
    // En-tête = 1re ligne (le modèle ne distingue pas, mais GFM exige un en-tête).
    let header = &rows[0];
    lines.push(format!(
        "| {} |",
        header
            .iter()
            .map(|c| cell_md(&c.runs))
            .collect::<Vec<_>>()
            .join(" | ")
    ));
    lines.push(format!("| {} |", vec!["---"; width].join(" | ")));
    for row in &rows[1..] {
        lines.push(format!(
            "| {} |",
            row.iter()
                .map(|c| cell_md(&c.runs))
                .collect::<Vec<_>>()
                .join(" | ")
        ));
    }
    lines.join("\n")
}

/// Document → Markdown. Les `ListItem` consécutifs forment un seul bloc liste.
pub fn to_markdown(doc: &Document) -> String {
    let mut blocks: Vec<String> = Vec::new();
    let mut i = 0;
    while i < doc.blocks.len() {
        if let Node::ListItem { .. } = doc.blocks[i].node {
            let mut lines = Vec::new();
            while i < doc.blocks.len() {
                if let Node::ListItem {
                    ordered,
                    level,
                    runs,
                } = &doc.blocks[i].node
                {
                    lines.push(list_line(*ordered, *level, runs));
                    i += 1;
                } else {
                    break;
                }
            }
            blocks.push(lines.join("\n"));
        } else {
            blocks.push(block_md(&doc.blocks[i].node));
            i += 1;
        }
    }
    let title = doc.meta.title.trim();
    let mut md = String::new();
    if !title.is_empty() {
        md.push_str(&format!("# {}\n\n", esc(title)));
    }
    md.push_str(&blocks.join("\n\n"));
    md.push('\n');
    md
}

// ===========================================================================
// .docx (OOXML via docx-rs)
// ===========================================================================

/// Marques d'un run → run docx (gras, italique, souligné, barré, code, couleur).
fn docx_run(r: &Run) -> docx_rs::Run {
    let mut run = docx_rs::Run::new().add_text(&r.text);
    let m = &r.marks;
    if m.bold {
        run = run.bold();
    }
    if m.italic {
        run = run.italic();
    }
    if m.underline {
        run = run.underline("single");
    }
    if m.strike {
        run = run.strike();
    }
    if m.code {
        run = run.fonts(docx_rs::RunFonts::new().ascii("Consolas"));
    }
    if let Some(c) = &m.color {
        run = run.color(c.trim_start_matches('#'));
    }
    run
}

fn docx_para_runs(runs: &[Run]) -> docx_rs::Paragraph {
    let mut p = docx_rs::Paragraph::new();
    if runs.is_empty() {
        return p.add_run(docx_rs::Run::new().add_text(""));
    }
    for r in runs {
        p = p.add_run(docx_run(r));
    }
    p
}

/// Taille (demi-points) d'un titre par niveau : H1≈20pt … H6≈12pt.
fn heading_size(level: u8) -> usize {
    match level.clamp(1, 6) {
        1 => 40,
        2 => 34,
        3 => 30,
        4 => 26,
        5 => 24,
        _ => 22,
    }
}

/// Définit les styles de titre Word (Title, Heading1..6) : c'est ce qui rend le
/// `.docx` **structuré** côté Word (volet Navigation, table des matières, plan).
/// Sans ces styles nommés, des titres « gras + grande taille » restent du corps
/// de texte aux yeux de Word.
fn with_heading_styles(mut d: docx_rs::Docx) -> docx_rs::Docx {
    use docx_rs::*;
    d = d.add_style(
        Style::new("Title", StyleType::Paragraph)
            .name("Title")
            .bold()
            .size(48),
    );
    for (id, name, size) in [
        ("Heading1", "heading 1", 36usize),
        ("Heading2", "heading 2", 32),
        ("Heading3", "heading 3", 28),
        ("Heading4", "heading 4", 26),
        ("Heading5", "heading 5", 24),
        ("Heading6", "heading 6", 22),
    ] {
        d = d.add_style(
            Style::new(id, StyleType::Paragraph)
                .name(name)
                .bold()
                .size(size),
        );
    }
    d
}

fn docx_block(docx: docx_rs::Docx, block: &Block) -> docx_rs::Docx {
    use docx_rs::*;
    match &block.node {
        Node::Paragraph { runs } => docx.add_paragraph(docx_para_runs(runs)),
        Node::Heading { level, runs } => {
            let lvl = (*level).clamp(1, 6);
            let size = heading_size(lvl);
            // Style Word réel (HeadingN) → plan / volet Navigation / TOC ; on garde
            // aussi gras+taille pour un rendu correct quel que soit le lecteur.
            let mut p = Paragraph::new().style(&format!("Heading{lvl}"));
            for r in runs {
                p = p.add_run(docx_run(r).bold().size(size));
            }
            docx.add_paragraph(p)
        }
        Node::Quote { runs } => {
            let mut p = Paragraph::new().indent(Some(720), None, None, None);
            for r in runs {
                p = p.add_run(docx_run(r).italic());
            }
            docx.add_paragraph(p)
        }
        Node::ListItem {
            ordered,
            level,
            runs,
        } => {
            let marker = if *ordered { "1. " } else { "• " };
            let indent = 360 + 360 * (*level as i32);
            let p = Paragraph::new()
                .indent(Some(indent), None, None, None)
                .add_run(Run::new().add_text(marker));
            let p = runs.iter().fold(p, |p, r| p.add_run(docx_run(r)));
            docx.add_paragraph(p)
        }
        Node::CodeBlock { text, .. } => {
            let mut d = docx;
            for line in text.split('\n') {
                let p = Paragraph::new().add_run(
                    Run::new()
                        .add_text(line)
                        .fonts(RunFonts::new().ascii("Consolas")),
                );
                d = d.add_paragraph(p);
            }
            d
        }
        Node::Image { alt, .. } => docx.add_paragraph(
            Paragraph::new().add_run(Run::new().add_text(format!("[Image : {alt}]"))),
        ),
        Node::PageBreak => {
            docx.add_paragraph(Paragraph::new().add_run(Run::new().add_break(BreakType::Page)))
        }
        Node::Table { rows } => {
            let trows: Vec<TableRow> = rows
                .iter()
                .map(|row| {
                    let cells: Vec<TableCell> = row
                        .iter()
                        .map(|c| TableCell::new().add_paragraph(docx_para_runs(&c.runs)))
                        .collect();
                    TableRow::new(cells)
                })
                .collect();
            docx.add_table(Table::new(trows))
        }
    }
}

/// Document → octets `.docx` (OOXML). Renvoie une erreur si la sérialisation échoue.
///
/// Note : `docx-rs` 0.4 sérialise les enfants de `w:rPr` dans un ordre non
/// strictement conforme au schéma ISO/IEC 29500 ; Word et LibreOffice le
/// tolèrent (ouverture sans réparation). Une conformité stricte dépendrait d'une
/// mise à jour de la lib.
pub fn to_docx(doc: &Document) -> Result<Vec<u8>, String> {
    use docx_rs::*;
    let mut d = with_heading_styles(Docx::new());
    let title = doc.meta.title.trim();
    if !title.is_empty() {
        d = d.add_paragraph(
            Paragraph::new()
                .style("Title")
                .add_run(Run::new().add_text(title).bold().size(48)),
        );
    }
    for block in &doc.blocks {
        d = docx_block(d, block);
    }
    let mut buf = Vec::new();
    d.build()
        .pack(std::io::Cursor::new(&mut buf))
        .map_err(|e| format!("échec de génération .docx : {e}"))?;
    Ok(buf)
}

// ===========================================================================
// Commands
// ===========================================================================

/// Exporte le document fourni en Markdown à `path`.
#[tauri::command]
pub fn export_markdown(path: String, doc: Document) -> Result<(), String> {
    fs::write(&path, to_markdown(&doc)).map_err(|e| e.to_string())
}

/// Exporte le document fourni en `.docx` à `path`.
#[tauri::command]
pub fn export_docx(path: String, doc: Document) -> Result<(), String> {
    let bytes = to_docx(&doc)?;
    fs::write(&path, bytes).map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use plume_core::{Block, Cell, Marks, Meta, Node, Run};

    fn fixture() -> Document {
        Document {
            meta: Meta {
                title: "Titre Démo".into(),
                lang: "fr".into(),
            },
            blocks: vec![
                Block::new(Node::Heading {
                    level: 2,
                    runs: vec![Run::plain("Section")],
                }),
                Block::new(Node::Paragraph {
                    runs: vec![
                        Run::plain("Du "),
                        Run {
                            text: "gras".into(),
                            marks: Marks {
                                bold: true,
                                ..Marks::default()
                            },
                        },
                        Run::plain(" et un "),
                        Run {
                            text: "lien".into(),
                            marks: Marks {
                                link: Some("https://example.com".into()),
                                ..Marks::default()
                            },
                        },
                    ],
                }),
                Block::new(Node::ListItem {
                    ordered: false,
                    level: 0,
                    runs: vec![Run::plain("puce")],
                }),
                Block::new(Node::ListItem {
                    ordered: false,
                    level: 1,
                    runs: vec![Run::plain("sous-puce")],
                }),
                Block::new(Node::CodeBlock {
                    lang: Some("rust".into()),
                    text: "fn main() {}".into(),
                }),
                Block::new(Node::Table {
                    rows: vec![
                        vec![
                            Cell {
                                runs: vec![Run::plain("A")],
                            },
                            Cell {
                                runs: vec![Run::plain("B")],
                            },
                        ],
                        vec![
                            Cell {
                                runs: vec![Run::plain("1")],
                            },
                            Cell {
                                runs: vec![Run::plain("2")],
                            },
                        ],
                    ],
                }),
            ],
        }
    }

    #[test]
    fn markdown_couvre_les_blocs() {
        let md = to_markdown(&fixture());
        assert!(md.contains("# Titre Démo"));
        assert!(md.contains("## Section"));
        assert!(md.contains("**gras**"));
        assert!(md.contains("[lien](<https://example.com>)"));
        assert!(md.contains("- puce"));
        assert!(md.contains("  - sous-puce"));
        assert!(md.contains("```rust\nfn main() {}\n```"));
        assert!(md.contains("| A | B |"));
        assert!(md.contains("| --- | --- |"));
    }

    #[test]
    fn markdown_lien_et_code_robustes() {
        let doc = Document {
            meta: Meta {
                title: String::new(),
                lang: "fr".into(),
            },
            blocks: vec![
                Block::new(Node::Paragraph {
                    runs: vec![Run {
                        text: "ici".into(),
                        marks: Marks {
                            link: Some("https://x.org/Rust_(langage)".into()),
                            ..Marks::default()
                        },
                    }],
                }),
                Block::new(Node::Paragraph {
                    runs: vec![Run {
                        text: "a`b".into(),
                        marks: Marks {
                            code: true,
                            ..Marks::default()
                        },
                    }],
                }),
                Block::new(Node::CodeBlock {
                    lang: None,
                    text: "```\nnested\n```".into(),
                }),
            ],
        };
        let md = to_markdown(&doc);
        // Lien avec parenthèses : encadré par <...> → ne casse pas la destination.
        assert!(md.contains("[ici](<https://x.org/Rust_(langage)>)"));
        // Span de code contenant un backtick : préservé via délimiteur (N+1).
        assert!(md.contains("``a`b``"));
        // Fence d'un CodeBlock contenant ``` : allongée à 4 backticks.
        assert!(md.contains("````\n```\nnested\n```\n````"));
    }

    #[test]
    fn docx_produit_un_zip_ooxml() {
        let bytes = to_docx(&fixture()).expect("génération docx");
        assert!(bytes.len() > 100, "le .docx ne doit pas être vide");
        // Un .docx est un conteneur ZIP : signature « PK\x03\x04 ».
        assert_eq!(&bytes[..2], b"PK", "le .docx doit être un conteneur ZIP");
    }

    #[test]
    fn docx_export_contient_styles_texte_et_table() {
        use std::io::{Cursor, Read};
        let bytes = to_docx(&fixture()).expect("génération docx");
        let mut zip = zip::ZipArchive::new(Cursor::new(bytes)).expect("conteneur zip");
        let mut xml = String::new();
        zip.by_name("word/document.xml")
            .expect("word/document.xml")
            .read_to_string(&mut xml)
            .unwrap();
        // Le contenu (pas seulement une enveloppe ZIP valide) est correct :
        assert!(xml.contains("Titre Démo"), "le titre est écrit");
        assert!(xml.contains("Section"), "le texte du titre H2 est écrit");
        assert!(
            xml.contains("Heading2"),
            "le style de titre Word (HeadingN) est référencé"
        );
        assert!(xml.contains("<w:tbl"), "le tableau est exporté (w:tbl)");
    }
}
