import type { ElementType, ReactNode } from "react";
import type { Block, Run } from "../bindings";
import { RunsView } from "./RunsView";

// Dans le modèle, les listes n'existent pas comme conteneur : chaque puce est un
// bloc `ListItem` plat porteur de `ordered` + `level` (0..=5). Le renderer doit
// reconstruire la hiérarchie `<ul>/<ol>` imbriquée à partir d'une suite de blocs
// `ListItem` consécutifs (le regroupement consécutif est fait par `DocumentView`).
//
// L'algorithme est piloté par la **profondeur absolue** : la profondeur DOM d'un
// item suit son `level` réel. Un saut de niveau (0 → 2) produit les conteneurs
// intermédiaires, et un segment démarrant à `level > 0` est indenté d'autant —
// l'information de `level` n'est donc jamais perdue.

type Item = { id: string; ordered: boolean; level: number; runs: Run[] };

type Entry = { ordered: boolean; key: string; node: ReactNode };

/**
 * Rend tous les items de `items[start..]` dont le `level >= depth`, en ouvrant
 * un conteneur par profondeur. Renvoie le nœud rendu et l'index suivant.
 */
function renderLevel(
  items: Item[],
  start: number,
  depth: number,
  keyBase: string,
): [ReactNode, number] {
  const entries: Entry[] = [];
  let i = start;

  while (i < items.length && items[i].level >= depth) {
    if (items[i].level === depth) {
      const it = items[i];
      i += 1;
      let nested: ReactNode = null;
      if (i < items.length && items[i].level > depth) {
        [nested, i] = renderLevel(items, i, depth + 1, it.id);
      }
      entries.push({
        ordered: it.ordered,
        key: it.id,
        node: (
          <li key={it.id} data-block-id={it.id} className="pl-1 leading-relaxed">
            <RunsView runs={it.runs} />
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
      [nested, i] = renderLevel(items, i, depth + 1, phantomKey);
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
        className={`my-3 space-y-1 pl-6 ${ordered ? "list-decimal" : "list-disc"} marker:text-neutral-400`}
      >
        {group.map((e) => e.node)}
      </Tag>,
    );
  }

  return [<>{containers}</>, i];
}

/** Reçoit une suite de blocs `ListItem` consécutifs et la rend imbriquée. */
export function ListGroup({ blocks }: { blocks: Block[] }): ReactNode {
  const items: Item[] = blocks.map((b) => {
    // `b.node` est garanti `ListItem` par le regroupement amont.
    const node = b.node as Extract<Block["node"], { type: "ListItem" }>;
    return { id: b.id, ordered: node.ordered, level: node.level, runs: node.runs };
  });
  return renderLevel(items, 0, 0, "list")[0];
}
