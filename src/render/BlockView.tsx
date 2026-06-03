import type { ElementType, ReactNode } from "react";
import type { Block } from "../bindings";
import { RunsView } from "./RunsView";
import { ListGroup } from "./ListGroup";

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
  6: "mb-2 mt-4 text-base font-semibold uppercase tracking-wide text-neutral-500",
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

  switch (node.type) {
    case "Paragraph":
      return (
        <p data-block-id={anchor} className="my-3 leading-relaxed">
          <RunsView runs={node.runs} />
        </p>
      );

    case "Heading": {
      const level = Math.min(6, Math.max(1, node.level));
      const Tag = HEADING_TAG[level];
      return (
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
      return (
        <blockquote
          data-block-id={anchor}
          className="my-4 border-l-4 border-neutral-300 pl-4 italic text-neutral-600"
        >
          <RunsView runs={node.runs} />
        </blockquote>
      );

    case "CodeBlock":
      return (
        <figure data-block-id={anchor} className="my-4">
          {node.lang && (
            <figcaption className="mb-1 font-mono text-xs uppercase tracking-wide text-neutral-400">
              {node.lang}
            </figcaption>
          )}
          <pre className="overflow-x-auto rounded-lg bg-neutral-900 p-4 text-sm text-neutral-100">
            <code className="whitespace-pre font-mono">{node.text}</code>
          </pre>
        </figure>
      );

    case "Table":
      return (
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
                      className="border border-neutral-300 px-3 py-1.5 align-top"
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
      return (
        <figure data-block-id={anchor} className="my-5 flex flex-col items-center">
          <img
            src={node.src}
            alt={node.alt}
            style={node.width_pct !== null ? { width: `${node.width_pct}%` } : undefined}
            className="h-auto max-w-full rounded ring-1 ring-neutral-200"
          />
          {node.alt !== "" && (
            <figcaption className="mt-2 text-xs text-neutral-500">{node.alt}</figcaption>
          )}
        </figure>
      );

    case "PageBreak":
      return (
        <div
          data-block-id={anchor}
          role="separator"
          aria-label="Saut de page"
          className="my-8 select-none"
        >
          {/* Habillage purement visuel : masqué aux lecteurs d'écran (l'info est
              déjà portée par aria-label du séparateur). */}
          <div
            aria-hidden="true"
            className="flex items-center gap-3 text-[11px] uppercase tracking-widest text-neutral-400"
          >
            <span className="h-px flex-1 bg-neutral-200" />
            saut de page
            <span className="h-px flex-1 bg-neutral-200" />
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
