import type { ReactNode } from "react";
import type { Block, Document } from "../bindings";
import { BlockView } from "./BlockView";
import { ListGroup } from "./ListGroup";

// Rend un `Document` complet sous forme de « page » (métaphore Word : feuille
// centrée, typographie soignée, peu de chrome). Avant le rendu, on segmente la
// suite plate de blocs : les `ListItem` consécutifs forment un segment « liste »
// (rendu imbriqué par `ListGroup`), les autres blocs restent isolés.

type Segment = { kind: "list"; blocks: Block[] } | { kind: "block"; block: Block };

function segment(blocks: Block[]): Segment[] {
  const segments: Segment[] = [];
  for (const block of blocks) {
    if (block.node.type === "ListItem") {
      const last = segments[segments.length - 1];
      if (last && last.kind === "list") last.blocks.push(block);
      else segments.push({ kind: "list", blocks: [block] });
    } else {
      segments.push({ kind: "block", block });
    }
  }
  return segments;
}

export function DocumentView({ doc }: { doc: Document }): ReactNode {
  const segments = segment(doc.blocks);

  return (
    <article
      lang={doc.meta.lang}
      className="mx-auto my-10 max-w-[760px] rounded-sm bg-white px-14 py-16 font-serif text-[17px] leading-relaxed text-neutral-800 shadow-sm ring-1 ring-neutral-200"
    >
      {doc.meta.title !== "" && (
        <header className="mb-10 border-b border-neutral-200 pb-6">
          <h1 className="text-center text-4xl font-bold tracking-tight">{doc.meta.title}</h1>
        </header>
      )}

      {segments.map((seg): ReactNode =>
        seg.kind === "list" ? (
          <ListGroup key={`list-${seg.blocks[0].id}`} blocks={seg.blocks} />
        ) : (
          <BlockView key={seg.block.id} block={seg.block} />
        ),
      )}

      {doc.blocks.length === 0 && (
        <p className="text-center italic text-neutral-400">Document vide.</p>
      )}
    </article>
  );
}
