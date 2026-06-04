import { createElement, useLayoutEffect, useRef } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import type { Block, Node as DocNode, Run } from "../bindings";
import { useEditor } from "./EditorContext";
import { getSelectionOffsets, setCaret, setSelection } from "./caret";
import { runsToHtml } from "./html";
import { charsToRuns, reconcile, runsToChars } from "./text";
import { toggleBoolMark } from "./actions";

// Surface éditable d'un bloc textuel. Principe : le DOM est rempli **depuis le
// modèle** (innerHTML) ; la frappe est laissée au navigateur (non contrôlée,
// caret natif préservé) puis reconvertie en op `SetRuns`. Le DOM n'est resynchro
// depuis le modèle que (a) quand le bloc n'a pas le focus, ou (b) sur le bloc
// focalisé après une op toolbar/structurelle (`syncSignal`) — auquel cas la
// sélection est restaurée. Tout passe par `dispatch` → pipeline Rust `apply_op`.
//
// IMPORTANT : `dispatch` est asynchrone (aller-retour IPC). Les ops structurelles
// (Entrée, fusion) lisent donc le **texte vivant du DOM** (et non la closure
// `runs`, qui peut être en retard d'une frappe non encore résolue) pour ne perdre
// aucun caractère en frappe rapide.

type Props = {
  block: Block;
  runs: Run[];
  tag: string;
  className: string;
};

function textRuns(node: DocNode): Run[] | null {
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

/** Bloc qui prolonge le bloc courant après Entrée (item de liste, sinon paragraphe). */
function continuationNode(node: DocNode, runs: Run[]): DocNode {
  if (node.type === "ListItem") {
    return { type: "ListItem", ordered: node.ordered, level: node.level, runs };
  }
  return { type: "Paragraph", runs };
}

function makeId(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `b-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

export function EditableText({ block, runs, tag, className }: Props) {
  const editor = useEditor();
  const ref = useRef<HTMLElement | null>(null);
  const focused = useRef(false);

  const syncSignal = editor?.syncSignal ?? 0;
  const pendingFocus = editor?.pendingFocus ?? null;

  // (a) Resynchro DOM ← modèle quand le bloc n'a PAS le focus (changements
  // externes, et normalisation après blur quand l'op de frappe se résout).
  useLayoutEffect(() => {
    if (focused.current) return;
    if (ref.current) ref.current.innerHTML = runsToHtml(runs);
  }, [runs]);

  // (b) Resynchro forcée du bloc FOCALISÉ après une op toolbar/structurelle :
  // le bloc focalisé n'est jamais rafraîchi par (a), donc on le fait ici en
  // préservant la sélection. Les autres blocs sont couverts par (a).
  useLayoutEffect(() => {
    if (!focused.current) return;
    const el = ref.current;
    if (!el) return;
    const saved = getSelectionOffsets(el);
    el.innerHTML = runsToHtml(runs);
    if (saved) {
      // Borne sur le nouveau contenu : après un undo qui le raccourcit, le caret
      // tombe en fin de texte de façon prévisible (pas à une position héritée).
      const len = Array.from(el.textContent ?? "").length;
      setSelection(el, Math.min(saved.start, len), Math.min(saved.end, len));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [syncSignal]);

  // Focus inter-blocs demandé (après Entrée / fusion) : prend le focus au caret.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || !pendingFocus || pendingFocus.id !== block.id) return;
    el.focus();
    setCaret(el, pendingFocus.offset);
    editor?.clearFocus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pendingFocus, syncSignal]);

  function onInput() {
    const el = ref.current;
    if (!el || !editor) return;
    const { chars } = reconcile(runsToChars(runs), el.textContent ?? "");
    editor.dispatch({ op: "SetRuns", id: block.id, runs: charsToRuns(chars) });
  }

  function handleEnter(el: HTMLElement) {
    if (!editor) return;
    // Contenu VIVANT du DOM (une op de frappe peut être encore en vol).
    const live = reconcile(runsToChars(runs), el.textContent ?? "").chars;
    const sel = getSelectionOffsets(el);
    const a = sel ? Math.min(sel.start, sel.end) : live.length;
    const b = sel ? Math.max(sel.start, sel.end) : live.length;
    const left = live.slice(0, a);
    const right = live.slice(b); // une sélection [a,b) est remplacée par la coupure

    const index = editor.doc.blocks.findIndex((x) => x.id === block.id);
    const at = index < 0 ? editor.doc.blocks.length : index + 1;
    const newId = makeId();

    editor.dispatch({ op: "SetRuns", id: block.id, runs: charsToRuns(left) }, { sync: true });
    editor.dispatch(
      {
        op: "InsertBlock",
        at,
        block: { id: newId, node: continuationNode(block.node, charsToRuns(right)) },
      },
      { sync: true },
    );
    editor.requestFocus(newId, 0);
  }

  /** Fusion avec le bloc précédent (Backspace en tête de bloc). */
  function handleBackspaceMerge(el: HTMLElement): boolean {
    if (!editor) return false;
    const blocks = editor.doc.blocks;
    const index = blocks.findIndex((b) => b.id === block.id);
    if (index <= 0) return false;
    const prev = blocks[index - 1];
    const prevRuns = textRuns(prev.node);
    if (!prevRuns) return false; // bloc précédent non textuel : pas de fusion

    const prevLen = runsToChars(prevRuns).length;
    const live = reconcile(runsToChars(runs), el.textContent ?? "").chars;
    const merged = charsToRuns([...runsToChars(prevRuns), ...live]);

    editor.dispatch({ op: "SetRuns", id: prev.id, runs: merged }, { sync: true });
    editor.dispatch({ op: "DeleteBlock", id: block.id }, { sync: true });
    editor.requestFocus(prev.id, prevLen);
    return true;
  }

  function onKeyDown(e: ReactKeyboardEvent<HTMLElement>) {
    if (!editor) return;
    const el = ref.current;
    if (!el) return;

    const mod = e.ctrlKey || e.metaKey;
    if (mod && !e.altKey) {
      const k = e.key.toLowerCase();
      if (k === "b" || k === "i" || k === "u") {
        e.preventDefault();
        toggleBoolMark(editor, k === "b" ? "bold" : k === "i" ? "italic" : "underline");
        return;
      }
    }

    if (e.key === "Enter") {
      e.preventDefault();
      handleEnter(el);
      return;
    }

    if (e.key === "Backspace") {
      const sel = getSelectionOffsets(el);
      if (sel && sel.start === 0 && sel.end === 0 && handleBackspaceMerge(el)) {
        e.preventDefault();
      }
    }
  }

  return createElement(tag, {
    ref,
    contentEditable: true,
    suppressContentEditableWarning: true,
    spellCheck: true,
    "data-block-id": block.id,
    "data-editable-block": block.id,
    className: `${className} rounded-sm outline-none focus:bg-coral-soft`,
    onInput,
    onKeyDown,
    onFocus: () => {
      focused.current = true;
    },
    onBlur: () => {
      // Pas de réécriture ici : l'effet (a) resynchronise dès que `runs` se met
      // à jour (bloc non focalisé), avec des données fraîches et sans flash.
      focused.current = false;
    },
  });
}
