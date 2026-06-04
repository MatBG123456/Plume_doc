import { useLayoutEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Run } from "../bindings";
import { useEditor } from "./EditorContext";
import { getSelectionOffsets, setSelection } from "./caret";
import { runsToHtml } from "./html";
import { charsToRuns, reconcile, runsToChars } from "./text";

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
    if (e.key === "Enter") e.preventDefault(); // cellule mono-ligne
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
