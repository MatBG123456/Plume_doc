// Conversion entre la sélection DOM (offsets UTF-16) et les offsets en **code
// points** du modèle (le `range` d'`ApplyMark` est exprimé en caractères). Tout
// le reste de l'éditeur raisonne en code points ; ce module est la seule
// frontière avec les Range/Selection du navigateur.

function cpLen(s: string): number {
  return Array.from(s).length;
}

/** Offsets (code points) de début et fin de la sélection courante dans `root`. */
export function getSelectionOffsets(root: HTMLElement): { start: number; end: number } | null {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    return null;
  }
  return {
    start: offsetWithin(root, range.startContainer, range.startOffset),
    end: offsetWithin(root, range.endContainer, range.endOffset),
  };
}

/** Nombre de code points entre le début de `root` et (container, offset). */
function offsetWithin(root: HTMLElement, container: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);
  range.setEnd(container, offset);
  return cpLen(range.toString());
}

/** Place le caret (réduit) à l'offset `cp` (code points) dans `root`. */
export function setCaret(root: HTMLElement, cp: number): void {
  setSelection(root, cp, cp);
}

/** Sélectionne l'intervalle `[start, end]` (code points) dans `root`. */
export function setSelection(root: HTMLElement, start: number, end: number): void {
  const sel = window.getSelection();
  if (!sel) return;
  const a = locate(root, start);
  const b = locate(root, end);
  if (!a || !b) return;
  const range = document.createRange();
  range.setStart(a.node, a.offset);
  range.setEnd(b.node, b.offset);
  sel.removeAllRanges();
  sel.addRange(range);
}

/** Localise le `(text node, offset UTF-16)` correspondant à l'offset `cp`. */
function locate(root: HTMLElement, cp: number): { node: Node; offset: number } | null {
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  let remaining = cp;
  let last: Text | null = null;
  let node = walker.nextNode() as Text | null;
  while (node) {
    last = node;
    const text = node.textContent ?? "";
    const len = cpLen(text);
    if (remaining <= len) return { node, offset: utf16Index(text, remaining) };
    remaining -= len;
    node = walker.nextNode() as Text | null;
  }
  if (last) return { node: last, offset: (last.textContent ?? "").length };
  // Bloc vide (un <br>, aucun text node) : caret au début du conteneur.
  return { node: root, offset: 0 };
}

/** Index UTF-16 juste après `cp` code points dans `text`. */
function utf16Index(text: string, cp: number): number {
  let i = 0;
  let c = 0;
  for (const ch of text) {
    if (c >= cp) break;
    i += ch.length;
    c += 1;
  }
  return i;
}
