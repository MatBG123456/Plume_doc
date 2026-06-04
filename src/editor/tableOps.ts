import type { Cell, Node as DocNode } from "../bindings";

// Opérations pures sur la structure d'un tableau : renvoient un nouveau nœud
// `Table` (rectangulaire) que `EditableTable` applique via `SetNode`. Le pipeline
// Rust valide (table rectangulaire, cellules valides) et calcule l'inverse.

export type TableNode = Extract<DocNode, { type: "Table" }>;

export function emptyCell(): Cell {
  return { runs: [] };
}

export function newTable(rows = 2, cols = 2): TableNode {
  return {
    type: "Table",
    rows: Array.from({ length: rows }, () => Array.from({ length: cols }, emptyCell)),
  };
}

/** Ajoute une ligne (de la largeur courante) en bas. */
export function withRowAdded(t: TableNode): TableNode {
  const width = t.rows[0]?.length ?? 1;
  return { type: "Table", rows: [...t.rows, Array.from({ length: width }, emptyCell)] };
}

/** Retire la dernière ligne (en garde au moins une). */
export function withRowRemoved(t: TableNode): TableNode {
  if (t.rows.length <= 1) return t;
  return { type: "Table", rows: t.rows.slice(0, -1) };
}

/** Ajoute une colonne (une cellule vide à droite de chaque ligne). */
export function withColAdded(t: TableNode): TableNode {
  return { type: "Table", rows: t.rows.map((r) => [...r, emptyCell()]) };
}

/** Retire la dernière colonne (en garde au moins une). */
export function withColRemoved(t: TableNode): TableNode {
  const width = t.rows[0]?.length ?? 0;
  if (width <= 1) return t;
  return { type: "Table", rows: t.rows.map((r) => r.slice(0, -1)) };
}
