import type { Block, Document, Marks, Node, Run } from "../bindings";

// Document de démonstration (Wave 3) : couvre **toutes** les variantes de `Node`
// et **toutes** les marques, pour vérifier d'un coup d'œil que le renderer est
// fidèle. C'est l'équivalent TS de la fixture Rust de `model.rs`, en plus riche.

const mark = (m: Partial<Marks> = {}): Marks => ({
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  link: null,
  color: null,
  ...m,
});

/** Raccourci : un run de texte avec marques optionnelles. */
const r = (text: string, m: Partial<Marks> = {}): Run => ({ text, marks: mark(m) });

let counter = 0;
const blk = (node: Node): Block => ({ id: `blk-${(counter += 1)}`, node });

// Image placeholder autonome (SVG en data-URI) : s'affiche sans réseau ni fichier.
const PLACEHOLDER_IMG =
  "data:image/svg+xml;utf8," +
  encodeURIComponent(
    "<svg xmlns='http://www.w3.org/2000/svg' width='480' height='240'>" +
      "<rect width='100%' height='100%' fill='#e5e7eb'/>" +
      "<text x='50%' y='50%' fill='#6b7280' font-family='sans-serif' font-size='22'" +
      " text-anchor='middle' dominant-baseline='middle'>Image 480 × 240</text></svg>",
  );

export const fixtureDoc: Document = {
  meta: { title: "Plume — Démonstration du rendu", lang: "fr" },
  blocks: [
    blk({ type: "Heading", level: 1, runs: [r("Titre de niveau 1")] }),

    blk({
      type: "Paragraph",
      runs: [
        r("Ce paragraphe mélange du texte "),
        r("en gras", { bold: true }),
        r(", "),
        r("en italique", { italic: true }),
        r(", "),
        r("gras + italique", { bold: true, italic: true }),
        r(", "),
        r("souligné", { underline: true }),
        r(", "),
        r("barré", { strike: true }),
        r(", "),
        r("souligné + barré", { underline: true, strike: true }),
        r(", du "),
        r("code inline", { code: true }),
        r(", de la "),
        r("couleur", { color: "#2563EB" }),
        r(" et un "),
        r("lien", { link: "https://example.com", underline: true }),
        r(", un "),
        r("lien coloré", { link: "https://example.com", color: "#DC2626" }),
        r("."),
      ],
    }),

    blk({ type: "Heading", level: 2, runs: [r("Listes imbriquées")] }),

    blk({ type: "ListItem", ordered: false, level: 0, runs: [r("Puce de premier niveau")] }),
    blk({
      type: "ListItem",
      ordered: false,
      level: 1,
      runs: [r("Sous-puce, avec un mot "), r("important", { bold: true })],
    }),
    blk({ type: "ListItem", ordered: false, level: 1, runs: [r("Autre sous-puce")] }),
    blk({ type: "ListItem", ordered: false, level: 0, runs: [r("Retour au premier niveau")] }),

    blk({ type: "Heading", level: 2, runs: [r("Liste numérotée")] }),
    blk({ type: "ListItem", ordered: true, level: 0, runs: [r("Première étape")] }),
    blk({ type: "ListItem", ordered: true, level: 0, runs: [r("Deuxième étape")] }),
    blk({ type: "ListItem", ordered: true, level: 1, runs: [r("Sous-étape numérotée")] }),
    blk({ type: "ListItem", ordered: true, level: 0, runs: [r("Troisième étape")] }),

    blk({
      type: "Quote",
      runs: [r("Une citation pour illustrer le bloc "), r("Quote", { code: true }), r(".")],
    }),

    blk({
      type: "CodeBlock",
      lang: "rust",
      text: 'fn main() {\n    println!("Bonjour, Plume !");\n}',
    }),

    blk({ type: "Heading", level: 2, runs: [r("Tableau")] }),
    blk({
      type: "Table",
      rows: [
        [
          { runs: [r("Colonne A", { bold: true })] },
          { runs: [r("Colonne B", { bold: true })] },
          { runs: [r("Colonne C", { bold: true })] },
        ],
        [
          { runs: [r("a1")] },
          { runs: [r("b1", { italic: true })] },
          { runs: [r("c1", { code: true })] },
        ],
        [{ runs: [r("a2")] }, { runs: [r("b2")] }, { runs: [r("c2", { color: "#DC2626" })] }],
      ],
    }),

    blk({ type: "Heading", level: 2, runs: [r("Image")] }),
    blk({ type: "Image", src: PLACEHOLDER_IMG, alt: "Image de démonstration", width_pct: 60 }),

    blk({ type: "PageBreak" }),

    blk({ type: "Heading", level: 2, runs: [r("Après le saut de page")] }),
    blk({
      type: "Paragraph",
      runs: [r("Le contenu reprend ici, après l'indicateur de saut de page.")],
    }),

    blk({ type: "Heading", level: 3, runs: [r("Titre de niveau 3")] }),
    blk({ type: "Heading", level: 4, runs: [r("Titre de niveau 4")] }),
    blk({ type: "Heading", level: 5, runs: [r("Titre de niveau 5")] }),
    blk({ type: "Heading", level: 6, runs: [r("Titre de niveau 6")] }),
  ],
};
