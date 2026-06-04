import type { Marks, MarkPatch, Node as DocNode, Run } from "../bindings";
import type { EditorApi } from "./EditorContext";
import { getSelectionOffsets } from "./caret";
import { charsToRuns, reconcile, runsToChars } from "./text";
import { newTable } from "./tableOps";

// Actions de la barre d'outils et des raccourcis clavier. Toutes opèrent sur la
// **sélection courante** : on retrouve le bloc éditable hôte via l'attribut
// `data-editable-block`, on calcule le range en code points, puis on émet l'op
// correspondante (ApplyMark / SetNode) avec `sync` pour rafraîchir le rendu.

export type BoolMark = "bold" | "italic" | "underline" | "strike" | "code";

export type BlockKind = "paragraph" | "h1" | "h2" | "h3" | "quote" | "bullet" | "number";

/** Bloc éditable contenant la sélection (hôte + id), ou `null`. */
function activeHost(): { host: HTMLElement; id: string } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const anchor = sel.anchorNode;
  const el = anchor instanceof HTMLElement ? anchor : anchor?.parentElement;
  const host = el?.closest<HTMLElement>("[data-editable-block]") ?? null;
  const id = host?.getAttribute("data-editable-block");
  return host && id ? { host, id } : null;
}

/** Sélection ordonnée (a ≤ b) en code points dans l'hôte, ou `null` si vide. */
function activeRange(host: HTMLElement): { a: number; b: number } | null {
  const r = getSelectionOffsets(host);
  if (!r) return null;
  const a = Math.min(r.start, r.end);
  const b = Math.max(r.start, r.end);
  return a === b ? null : { a, b };
}

function runsOf(editor: EditorApi, id: string): Run[] | null {
  const block = editor.doc.blocks.find((b) => b.id === id);
  if (!block) return null;
  return nodeRuns(block.node);
}

function nodeRuns(node: DocNode): Run[] | null {
  switch (node.type) {
    case "Paragraph":
    case "Heading":
    case "ListItem":
    case "Quote":
      return node.runs;
    default:
      return null;
  }
}

// --- Cellules de tableau ----------------------------------------------------
// Un `<td>` éditable n'a pas de `data-editable-block` et une table n'a pas de
// runs au niveau bloc : les marques s'y appliquent en reconstruisant les runs de
// la cellule (avec la marque sur la sélection) via une op `SetTableCell`.

type Cell = { host: HTMLElement; id: string; row: number; col: number };

/** Cellule de tableau éditable contenant la sélection, ou `null`. */
function activeCell(): Cell | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const anchor = sel.anchorNode;
  const el = anchor instanceof HTMLElement ? anchor : anchor?.parentElement;
  const host = el?.closest<HTMLElement>("[data-editable-cell]") ?? null;
  const id = host?.getAttribute("data-editable-cell");
  const row = Number(host?.getAttribute("data-row"));
  const col = Number(host?.getAttribute("data-col"));
  if (!host || !id || Number.isNaN(row) || Number.isNaN(col)) return null;
  return { host, id, row, col };
}

function cellRuns(editor: EditorApi, id: string, row: number, col: number): Run[] | null {
  const block = editor.doc.blocks.find((b) => b.id === id);
  if (!block || block.node.type !== "Table") return null;
  return block.node.rows[row]?.[col]?.runs ?? null;
}

/** Texte vivant de la cellule (modèle réconcilié avec le DOM), en caractères. */
function cellLiveChars(editor: EditorApi, cell: Cell) {
  const runs = cellRuns(editor, cell.id, cell.row, cell.col);
  if (!runs) return null;
  return reconcile(runsToChars(runs), cell.host.textContent ?? "").chars;
}

/** Applique un patch de marques sur la sélection d'une cellule (dispatch SetTableCell). */
function applyCellPatch(editor: EditorApi, cell: Cell, range: { a: number; b: number }, patch: MarkPatch): void {
  const chars = cellLiveChars(editor, cell);
  if (!chars) return;
  const next = chars.map((c, i) => {
    if (i < range.a || i >= range.b) return c;
    const marks: Marks = { ...c.marks, ...patch };
    return { ...c, marks };
  });
  editor.dispatch(
    { op: "SetTableCell", id: cell.id, row: cell.row, col: cell.col, runs: charsToRuns(next) },
    { sync: true },
  );
}

/** Demande l'URL d'un lien : `string` = poser, `null` = retirer, `undefined` = annulé/invalide. */
function promptLink(): string | null | undefined {
  const url = window.prompt("URL du lien (laisser vide pour retirer) :", "https://");
  if (url === null) return undefined; // annulé
  const trimmed = url.trim();
  const link = trimmed === "" ? null : trimmed;
  // Évite un lien trivialement invalide (ex. « https:// » sans hôte) que Rust rejetterait.
  if (link !== null && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/.+/.test(link)) return undefined;
  return link;
}

/** Bascule une marque booléenne sur la sélection (toggle selon l'état courant). */
export function toggleBoolMark(editor: EditorApi, mark: BoolMark): void {
  const cell = activeCell();
  if (cell) {
    const range = activeRange(cell.host);
    if (!range) return;
    const chars = cellLiveChars(editor, cell);
    if (!chars) return;
    const sel = chars.slice(range.a, range.b);
    const allSet = sel.length > 0 && sel.every((c) => c.marks[mark]);
    const patch: MarkPatch = {};
    patch[mark] = !allSet;
    applyCellPatch(editor, cell, range, patch);
    return;
  }

  const active = activeHost();
  if (!active) return;
  const range = activeRange(active.host);
  if (!range) return;
  const runs = runsOf(editor, active.id);
  if (!runs) return;

  // Marques calculées sur le texte VIVANT (une frappe peut être en vol, donc
  // `editor.doc` peut être en retard) pour choisir le bon sens du toggle.
  const live = reconcile(runsToChars(runs), active.host.textContent ?? "").chars;
  const chars = live.slice(range.a, range.b);
  const allSet = chars.length > 0 && chars.every((c) => c.marks[mark]);
  const patch: MarkPatch = {};
  patch[mark] = !allSet;
  editor.dispatch(
    { op: "ApplyMark", id: active.id, range: [range.a, range.b], mark: patch },
    { sync: true },
  );
}

/** Pose (`hex`) ou retire (`null`) une couleur sur la sélection. */
export function setColor(editor: EditorApi, color: string | null): void {
  const cell = activeCell();
  if (cell) {
    const range = activeRange(cell.host);
    if (range) applyCellPatch(editor, cell, range, { color });
    return;
  }
  const active = activeHost();
  if (!active) return;
  const range = activeRange(active.host);
  if (!range) return;
  editor.dispatch(
    { op: "ApplyMark", id: active.id, range: [range.a, range.b], mark: { color } },
    { sync: true },
  );
}

/** Pose ou retire un lien sur la sélection (URL demandée à l'utilisateur). */
export function setLink(editor: EditorApi): void {
  const cell = activeCell();
  if (cell) {
    const range = activeRange(cell.host);
    if (!range) return;
    const link = promptLink();
    if (link === undefined) return;
    applyCellPatch(editor, cell, range, { link });
    return;
  }
  const active = activeHost();
  if (!active) return;
  const range = activeRange(active.host);
  if (!range) return;
  const link = promptLink();
  if (link === undefined) return;
  editor.dispatch(
    { op: "ApplyMark", id: active.id, range: [range.a, range.b], mark: { link } },
    { sync: true },
  );
}

function nodeForKind(kind: BlockKind, runs: Run[]): DocNode {
  switch (kind) {
    case "paragraph":
      return { type: "Paragraph", runs };
    case "h1":
      return { type: "Heading", level: 1, runs };
    case "h2":
      return { type: "Heading", level: 2, runs };
    case "h3":
      return { type: "Heading", level: 3, runs };
    case "quote":
      return { type: "Quote", runs };
    case "bullet":
      return { type: "ListItem", ordered: false, level: 0, runs };
    case "number":
      return { type: "ListItem", ordered: true, level: 0, runs };
  }
}

/** Change le type du bloc courant (SetNode), en conservant ses runs. */
export function setBlockType(editor: EditorApi, kind: BlockKind): void {
  const active = activeHost();
  if (!active) return;
  const block = editor.doc.blocks.find((b) => b.id === active.id);
  if (!block) return;
  const runs = nodeRuns(block.node) ?? [];
  editor.dispatch({ op: "SetNode", id: active.id, node: nodeForKind(kind, runs) }, { sync: true });
}

function makeId(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `b-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

/** Bloc (texte OU table) contenant la sélection, via le wrapper `data-block-id`. */
function activeBlockId(): string | null {
  const sel = window.getSelection();
  const node = sel?.anchorNode ?? null;
  const el = node instanceof HTMLElement ? node : (node?.parentElement ?? null);
  const host = el?.closest<HTMLElement>("[data-block-id]") ?? null;
  return host?.getAttribute("data-block-id") ?? null;
}

/** Épingle le bloc contenant la sélection comme contexte PRIORITAIRE pour l'assistant. */
export function targetActiveBlock(editor: EditorApi): void {
  const id = activeBlockId();
  if (id) editor.setFocus(id);
}

/** Insère un tableau (2×2 par défaut) après le bloc courant (sinon à la fin). */
export function insertTable(editor: EditorApi, rows = 2, cols = 2): void {
  const active = activeHost();
  const blocks = editor.doc.blocks;
  const idx = active ? blocks.findIndex((b) => b.id === active.id) : -1;
  const at = idx < 0 ? blocks.length : idx + 1;
  editor.dispatch(
    { op: "InsertBlock", at, block: { id: makeId(), node: newTable(rows, cols) } },
    { sync: true },
  );
}
