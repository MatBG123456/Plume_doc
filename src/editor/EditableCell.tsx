import { useLayoutEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Run } from "../bindings";
import { useEditor } from "./EditorContext";
import { getSelectionOffsets, setSelection } from "./caret";
import { runsToHtml } from "./html";
import { charsToRuns, reconcile, runsToChars } from "./text";
import { toggleBoolMark, type BoolMark } from "./actions";

// Cellule de tableau éditable. Même principe que `EditableText` (DOM rempli
// depuis le modèle, frappe laissée au navigateur puis reconvertie en op) mais la
// frappe émet `SetTableCell { id, row, col, runs }`. Une cellule reste
// mono-bloc : Entrée est neutralisée (pas de découpe de bloc dans une cellule).

type Props = { blockId: string; row: number; col: number; runs: Run[] };

export function EditableCell({ blockId, row, col, runs }: Props) {
  const editor = useEditor();
  const ref = useRef<HTMLTableCellElement | null>(null);
  const focused = useRef(false);
  const syncSignal = editor?.syncSignal ?? 0;

  // (a) Resynchro DOM ← modèle quand la cellule n'a PAS le focus.
  useLayoutEffect(() => {
    if (focused.current) return;
    if (ref.current) ref.current.innerHTML = runsToHtml(runs);
  }, [runs]);

  // (b) Resynchro forcée de la cellule focalisée après une op structurelle.
  useLayoutEffect(() => {
    if (!focused.current) return;
    const el = ref.current;
    if (!el) return;
    const saved = getSelectionOffsets(el);
    el.innerHTML = runsToHtml(runs);
    if (saved) {
      const len = Array.from(el.textContent ?? "").length;
      setSelection(el, Math.min(saved.start, len), Math.min(saved.end, len));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncSignal]);

  function onInput() {
    const el = ref.current;
    if (!el || !editor) return;
    const { chars } = reconcile(runsToChars(runs), el.textContent ?? "");
    editor.dispatch({ op: "SetTableCell", id: blockId, row, col, runs: charsToRuns(chars) });
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLTableCellElement>) {
    // Tab / Maj+Tab : déplace le focus vers la cellule suivante / précédente.
    if (e.key === "Tab") {
      e.preventDefault();
      if (!editor) return;
      const table = editor.doc.blocks.find((b) => b.id === blockId);
      if (!table || table.node.type !== "Table") return;
      const rows = table.node.rows;
      const cols = rows[0]?.length ?? 0;
      let r = row;
      let c = col;
      if (e.shiftKey) {
        if (c > 0) c -= 1;
        else if (r > 0) {
          r -= 1;
          c = cols - 1;
        } else return;
      } else if (c < cols - 1) {
        c += 1;
      } else if (r < rows.length - 1) {
        r += 1;
        c = 0;
      } else return;
      const target = document.querySelector<HTMLElement>(
        `[data-editable-cell="${CSS.escape(blockId)}"][data-row="${r}"][data-col="${c}"]`,
      );
      target?.focus();
      return;
    }
    if (e.key === "Enter") {
      e.preventDefault(); // cellule mono-ligne
      return;
    }
    // Gras/italique/souligné au clavier (sinon le navigateur applique son propre
    // formatage via execCommand, qui corromprait le DOM de la cellule).
    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey && editor) {
      const k = e.key.toLowerCase();
      if (k === "b" || k === "i" || k === "u" || k === "e" || (k === "x" && e.shiftKey)) {
        e.preventDefault();
        const m: BoolMark =
          k === "b"
            ? "bold"
            : k === "i"
              ? "italic"
              : k === "u"
                ? "underline"
                : k === "e"
                  ? "code"
                  : "strike";
        toggleBoolMark(editor, m);
      }
    }
  }

  return (
    <td
      ref={ref}
      data-editable-cell={blockId}
      data-row={row}
      data-col={col}
      contentEditable
      suppressContentEditableWarning
      spellCheck
      onInput={onInput}
      onKeyDown={onKeyDown}
      onFocus={() => {
        focused.current = true;
      }}
      onBlur={() => {
        focused.current = false;
      }}
      className="min-w-[5rem] border border-line px-3 py-1.5 align-top outline-none focus:bg-coral-soft"
    />
  );
}
