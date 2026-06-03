import type { MarkPatch, Node as DocNode, Run } from "../bindings";
import type { EditorApi } from "./EditorContext";
import { getSelectionOffsets } from "./caret";
import { reconcile, runsToChars } from "./text";

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

/** Bascule une marque booléenne sur la sélection (toggle selon l'état courant). */
export function toggleBoolMark(editor: EditorApi, mark: BoolMark): void {
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
  const active = activeHost();
  if (!active) return;
  const range = activeRange(active.host);
  if (!range) return;
  const url = window.prompt("URL du lien (laisser vide pour retirer) :", "https://");
  if (url === null) return; // annulé
  const trimmed = url.trim();
  const link = trimmed === "" ? null : trimmed;
  // Évite d'envoyer un lien trivialement invalide (ex. « https:// » sans hôte),
  // que Rust rejetterait ; on retire ou pose seulement une URL absolue plausible.
  if (link !== null && !/^[a-zA-Z][a-zA-Z0-9+.-]*:\/\/.+/.test(link)) return;
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
