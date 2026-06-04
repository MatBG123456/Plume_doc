import type { ElementType, ReactNode } from "react";
import type { Block } from "../bindings";
import { RunsView } from "./RunsView";
import { ListGroup } from "./ListGroup";
import { useEditor } from "../editor/EditorContext";
import { EditableText } from "../editor/EditableText";
import { EditableTable } from "../editor/EditableTable";
import { editImage } from "../editor/actions";
import { Pencil, Trash } from "../icons";

// Dispatch d'un bloc vers son composant du design system. Le rendu des listes
// (regroupement des `ListItem` consécutifs) appartient à `DocumentView` ; ici on
// rend chaque bloc isolément. La fonction est **totale** sur `Node` (un cas par
// variante + garde `never`).

/** Échelle typographique des titres, par niveau (1..=6). */
const HEADING: Record<number, string> = {
  1: "mb-3 mt-8 text-4xl font-bold tracking-tight",
  2: "mb-3 mt-7 text-3xl font-semibold tracking-tight",
  3: "mb-2 mt-6 text-2xl font-semibold",
  4: "mb-2 mt-5 text-xl font-semibold",
  5: "mb-2 mt-4 text-lg font-semibold",
  6: "mb-2 mt-4 text-base font-semibold uppercase tracking-wide text-muted",
};

/** Balise HTML correspondant au niveau de titre (1..=6). */
const HEADING_TAG: Record<number, ElementType> = {
  1: "h1",
  2: "h2",
  3: "h3",
  4: "h4",
  5: "h5",
  6: "h6",
};

export function BlockView({ block }: { block: Block }): ReactNode {
  const { node } = block;
  const anchor = block.id;
  const editor = useEditor();
  const editable = editor?.editable ?? false;

  switch (node.type) {
    case "Paragraph":
      return editable ? (
        <EditableText block={block} runs={node.runs} tag="p" className="my-3 leading-relaxed" />
      ) : (
        <p data-block-id={anchor} className="my-3 leading-relaxed">
          <RunsView runs={node.runs} />
        </p>
      );

    case "Heading": {
      const level = Math.min(6, Math.max(1, node.level));
      const Tag = HEADING_TAG[level];
      return editable ? (
        <EditableText
          block={block}
          runs={node.runs}
          tag={`h${level}`}
          className={HEADING[level]}
        />
      ) : (
        <Tag data-block-id={anchor} className={HEADING[level]}>
          <RunsView runs={node.runs} />
        </Tag>
      );
    }

    case "ListItem":
      // Défensif : en pratique `DocumentView` regroupe les items. Un item isolé
      // rend une liste à un seul élément.
      return <ListGroup blocks={[block]} />;

    case "Quote":
      return editable ? (
        <EditableText
          block={block}
          runs={node.runs}
          tag="blockquote"
          className="my-4 border-l-4 border-coral/40 pl-4 italic text-muted"
        />
      ) : (
        <blockquote
          data-block-id={anchor}
          className="my-4 border-l-4 border-coral/40 pl-4 italic text-muted"
        >
          <RunsView runs={node.runs} />
        </blockquote>
      );

    case "CodeBlock":
      return (
        <figure data-block-id={anchor} className="my-4">
          {node.lang && (
            <figcaption className="mb-1 font-mono text-xs uppercase tracking-wide text-faint">
              {node.lang}
            </figcaption>
          )}
          <pre className="overflow-x-auto rounded-row bg-ink/[0.04] p-4 text-sm text-ink ring-1 ring-line">
            <code className="whitespace-pre font-mono print:whitespace-pre-wrap print:break-words">
              {node.text}
            </code>
          </pre>
        </figure>
      );

    case "Table":
      return editable ? (
        <EditableTable block={block} node={node} />
      ) : (
        <div data-block-id={anchor} className="my-4 overflow-x-auto">
          <table className="w-full border-collapse text-sm">
            <tbody>
              {node.rows.map((row, r) => (
                <tr key={r}>
                  {row.map((cell, c) => (
                    <td
                      key={c}
                      data-row={r}
                      data-col={c}
                      className="border border-line px-3 py-1.5 align-top"
                    >
                      <RunsView runs={cell.runs} />
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      );

    case "Image":
      return editable && editor ? (
        <figure data-block-id={anchor} className="group relative my-5 flex flex-col items-center">
          <img
            src={node.src}
            alt={node.alt}
            style={node.width_pct !== null ? { width: `${node.width_pct}%` } : undefined}
            className="h-auto max-w-full rounded-row ring-1 ring-line"
          />
          {node.alt !== "" && (
            <figcaption className="mt-2 text-xs text-faint">{node.alt}</figcaption>
          )}
          <div className="absolute right-2 top-2 flex gap-1 rounded-md bg-paper/90 p-0.5 opacity-0 ring-1 ring-line transition group-hover:opacity-100 print:hidden">
            <button
              type="button"
              onClick={() => editImage(editor, anchor)}
              title="Éditer l'image"
              className="rounded p-1 text-muted hover:bg-coral-soft hover:text-coral-ink"
            >
              <Pencil className="h-3.5 w-3.5" />
            </button>
            <button
              type="button"
              onClick={() => editor.dispatch({ op: "DeleteBlock", id: anchor }, { sync: true })}
              title="Supprimer l'image"
              className="rounded p-1 text-deny hover:bg-deny/10"
            >
              <Trash className="h-3.5 w-3.5" />
            </button>
          </div>
        </figure>
      ) : (
        <figure data-block-id={anchor} className="my-5 flex flex-col items-center">
          <img
            src={node.src}
            alt={node.alt}
            style={node.width_pct !== null ? { width: `${node.width_pct}%` } : undefined}
            className="h-auto max-w-full rounded-row ring-1 ring-line"
          />
          {node.alt !== "" && (
            <figcaption className="mt-2 text-xs text-faint">{node.alt}</figcaption>
          )}
        </figure>
      );

    case "PageBreak":
      return (
        <div
          data-block-id={anchor}
          role="separator"
          aria-label="Saut de page"
          className="my-8 select-none break-after-page print:my-0"
        >
          {/* Habillage purement visuel : masqué aux lecteurs d'écran (l'info est
              déjà portée par aria-label) et à l'impression (le saut de page réel
              est porté par `break-after-page` sur le conteneur). */}
          <div
            aria-hidden="true"
            className="flex items-center gap-3 text-[11px] uppercase tracking-widest text-faint print:hidden"
          >
            <span className="h-px flex-1 bg-line" />
            saut de page
            <span className="h-px flex-1 bg-line" />
          </div>
        </div>
      );

    default: {
      // Exhaustivité : si une variante de `Node` est ajoutée sans cas ici,
      // le compilateur signalera ce `never`.
      const _exhaustive: never = node;
      return _exhaustive;
    }
  }
}
