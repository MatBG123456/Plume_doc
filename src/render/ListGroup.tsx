import type { ElementType, ReactNode } from "react";
import type { Block, Run } from "../bindings";
import { RunsView } from "./RunsView";
import { useEditor } from "../editor/EditorContext";
import { EditableText } from "../editor/EditableText";

// Dans le modèle, les listes n'existent pas comme conteneur : chaque puce est un
// bloc `ListItem` plat porteur de `ordered` + `level` (0..=5). Le renderer doit
// reconstruire la hiérarchie `<ul>/<ol>` imbriquée à partir d'une suite de blocs
// `ListItem` consécutifs (le regroupement consécutif est fait par `DocumentView`).
//
// L'algorithme est piloté par la **profondeur absolue** : la profondeur DOM d'un
// item suit son `level` réel. Un saut de niveau (0 → 2) produit les conteneurs
// intermédiaires, et un segment démarrant à `level > 0` est indenté d'autant —
// l'information de `level` n'est donc jamais perdue.

type Item = { block: Block; ordered: boolean; level: number; runs: Run[] };

type Entry = { ordered: boolean; key: string; node: ReactNode };

/** Contenu d'un item : éditable (span) si l'éditeur est actif, sinon lecture seule. */
function itemContent(item: Item, editable: boolean): ReactNode {
  return editable ? (
    <EditableText block={item.block} runs={item.runs} tag="span" className="block" />
  ) : (
    <RunsView runs={item.runs} />
  );
}

/**
 * Rend tous les items de `items[start..]` dont le `level >= depth`, en ouvrant
 * un conteneur par profondeur. Renvoie le nœud rendu et l'index suivant.
 */
function renderLevel(
  items: Item[],
  start: number,
  depth: number,
  keyBase: string,
  editable: boolean,
): [ReactNode, number] {
  const entries: Entry[] = [];
  let i = start;

  while (i < items.length && items[i].level >= depth) {
    if (items[i].level === depth) {
      const it = items[i];
      i += 1;
      let nested: ReactNode = null;
      if (i < items.length && items[i].level > depth) {
        [nested, i] = renderLevel(items, i, depth + 1, it.block.id, editable);
      }
      entries.push({
        ordered: it.ordered,
        key: it.block.id,
        node: (
          <li key={it.block.id} data-block-id={it.block.id} className="pl-1 leading-relaxed">
            {itemContent(it, editable)}
            {nested}
          </li>
        ),
      });
    } else {
      // Saut de niveau : aucun item à cette profondeur pour héberger la liste
      // plus profonde → on insère un `<li>` vide (sans puce) comme conteneur.
      const phantomKey = `${keyBase}-ph${i}`;
      const ordered = items[i].ordered;
      let nested: ReactNode;
      [nested, i] = renderLevel(items, i, depth + 1, phantomKey, editable);
      entries.push({
        ordered,
        key: phantomKey,
        node: (
          <li key={phantomKey} className="list-none pl-1">
            {nested}
          </li>
        ),
      });
    }
  }

  // Découpe les entrées consécutives par type (puces vs numéros) en conteneurs
  // `<ul>`/`<ol>` distincts et successifs.
  const containers: ReactNode[] = [];
  let idx = 0;
  while (idx < entries.length) {
    const ordered = entries[idx].ordered;
    const group: Entry[] = [];
    while (idx < entries.length && entries[idx].ordered === ordered) {
      group.push(entries[idx]);
      idx += 1;
    }
    const Tag: ElementType = ordered ? "ol" : "ul";
    containers.push(
      <Tag
        key={group[0].key}
        className={`my-3 space-y-1 pl-6 ${ordered ? "list-decimal" : "list-disc"} marker:text-faint`}
      >
        {group.map((e) => e.node)}
      </Tag>,
    );
  }

  return [<>{containers}</>, i];
}

/** Reçoit une suite de blocs `ListItem` consécutifs et la rend imbriquée. */
export function ListGroup({ blocks }: { blocks: Block[] }): ReactNode {
  const editable = useEditor()?.editable ?? false;
  const items: Item[] = blocks.map((b) => {
    // `b.node` est garanti `ListItem` par le regroupement amont.
    const node = b.node as Extract<Block["node"], { type: "ListItem" }>;
    return { block: b, ordered: node.ordered, level: node.level, runs: node.runs };
  });
  return renderLevel(items, 0, 0, "list", editable)[0];
}
