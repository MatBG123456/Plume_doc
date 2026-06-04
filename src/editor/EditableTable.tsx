import type { ReactNode } from "react";
import type { Block } from "../bindings";
import { useEditor } from "./EditorContext";
import { EditableCell } from "./EditableCell";
import { Minus, Plus, Trash } from "../icons";
import {
  withColAdded,
  withColRemoved,
  withRowAdded,
  withRowRemoved,
  type TableNode,
} from "./tableOps";

// Tableau éditable : cellules éditables (`EditableCell`) + une barre de contrôles
// (ajouter/retirer lignes & colonnes, supprimer) qui apparaît au survol/focus.
// Les changements de structure passent par `SetNode` (nœud Table reconstruit) ;
// la suppression par `DeleteBlock`. La bordure coral signale le bloc « ciblé »
// pour l'assistant.

function CtrlBtn({
  onClick,
  danger,
  children,
}: {
  onClick: () => void;
  danger?: boolean;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      onMouseDown={(e) => {
        e.preventDefault(); // ne pas voler le focus de la cellule
        onClick();
      }}
      className={`inline-flex items-center gap-1 rounded-md px-2 py-0.5 text-xs ${
        danger
          ? "text-deny hover:bg-deny/10"
          : "text-muted hover:bg-coral-soft hover:text-coral-ink"
      }`}
    >
      {children}
    </button>
  );
}

export function EditableTable({ block, node }: { block: Block; node: TableNode }) {
  const editor = useEditor();
  if (!editor) return null;
  const id = block.id;
  const targeted = editor.focusId === id;
  const apply = (next: TableNode) => editor.dispatch({ op: "SetNode", id, node: next }, { sync: true });

  return (
    <div
      data-block-id={id}
      className={`group my-4 rounded-row p-1 ${targeted ? "ring-2 ring-coral" : ""}`}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-collapse text-sm">
          <tbody>
            {node.rows.map((row, r) => (
              <tr key={r}>
                {row.map((cell, c) => (
                  <EditableCell key={c} blockId={id} row={r} col={c} runs={cell.runs} />
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="mt-1 flex flex-wrap items-center gap-0.5 opacity-0 transition group-hover:opacity-100 group-focus-within:opacity-100 print:hidden">
        <CtrlBtn onClick={() => apply(withRowAdded(node))}>
          <Plus className="h-3 w-3" /> ligne
        </CtrlBtn>
        <CtrlBtn onClick={() => apply(withRowRemoved(node))}>
          <Minus className="h-3 w-3" /> ligne
        </CtrlBtn>
        <span className="mx-0.5 h-4 w-px bg-line" />
        <CtrlBtn onClick={() => apply(withColAdded(node))}>
          <Plus className="h-3 w-3" /> colonne
        </CtrlBtn>
        <CtrlBtn onClick={() => apply(withColRemoved(node))}>
          <Minus className="h-3 w-3" /> colonne
        </CtrlBtn>
        <span className="mx-0.5 h-4 w-px bg-line" />
        <CtrlBtn onClick={() => editor.dispatch({ op: "DeleteBlock", id }, { sync: true })} danger>
          <Trash className="h-3 w-3" /> Supprimer
        </CtrlBtn>
      </div>
    </div>
  );
}
