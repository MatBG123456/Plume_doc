import { useEffect, useMemo, useState } from "react";
import type { Document, Node as DocNode } from "../bindings";
import { setSelection } from "./caret";

// Recherche dans le document (Wave 8). Les correspondances sont calculées sur le
// **modèle** (texte concaténé des blocs textuels), puis surlignées dans le DOM
// via `setSelection` (mêmes offsets code points que l'éditeur). Navigation
// ↑/↓ ou boutons ; Entrée = suivant ; Échap = fermer.

type Match = { id: string; start: number; end: number };

/** Texte concaténé d'un bloc textuel, ou `null` si le bloc ne porte pas de runs. */
function blockText(node: DocNode): string | null {
  switch (node.type) {
    case "Paragraph":
    case "Heading":
    case "ListItem":
    case "Quote":
      return node.runs.map((r) => r.text).join("");
    default:
      return null;
  }
}

/** Occurrences (offsets en code points) de `query` dans `text`, insensible à la casse. */
function occurrences(text: string, query: string): { start: number; end: number }[] {
  const hay = Array.from(text.toLowerCase());
  const needle = Array.from(query.toLowerCase());
  const out: { start: number; end: number }[] = [];
  if (needle.length === 0) return out;
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ start: i, end: i + needle.length });
  }
  return out;
}

export function SearchBar({ doc, onClose }: { doc: Document; onClose: () => void }) {
  const [query, setQuery] = useState("");
  const [idx, setIdx] = useState(0);

  const matches = useMemo<Match[]>(() => {
    const q = query.trim();
    if (q === "") return [];
    const out: Match[] = [];
    for (const b of doc.blocks) {
      const t = blockText(b.node);
      if (t === null) continue;
      for (const m of occurrences(t, q)) out.push({ id: b.id, start: m.start, end: m.end });
    }
    return out;
  }, [doc, query]);

  useEffect(() => setIdx(0), [query]);

  // Index borné si `matches` a rétréci (document modifié pendant la recherche).
  const safeIdx = matches.length > 0 ? idx % matches.length : 0;

  // Surligne la correspondance courante (scroll + sélection DOM).
  useEffect(() => {
    const m = matches[safeIdx];
    if (!m) return;
    try {
      // `CSS.escape` : un BlockId est une chaîne libre (agent, fichier ouvert) ;
      // sans échappement, un id avec caractères spéciaux ferait planter querySelector.
      const host = document.querySelector<HTMLElement>(
        `[data-editable-block="${CSS.escape(m.id)}"]`,
      );
      if (!host) return;
      host.scrollIntoView({ block: "center" });
      setSelection(host, m.start, m.end);
    } catch {
      /* sélecteur invalide / bloc absent : on ignore */
    }
  }, [safeIdx, matches]);

  const go = (delta: number) => {
    if (matches.length === 0) return;
    setIdx((i) => (i + delta + matches.length) % matches.length);
  };

  return (
    <div className="fixed left-1/2 top-3 z-50 flex -translate-x-1/2 items-center gap-2 rounded-lg bg-white px-3 py-2 shadow-lg ring-1 ring-neutral-200 print:hidden">
      <input
        autoFocus
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            go(e.shiftKey ? -1 : 1);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="Rechercher…"
        className="w-56 text-sm outline-none"
      />
      <span className="min-w-14 text-right font-mono text-xs text-neutral-500">
        {matches.length === 0
          ? query.trim() === ""
            ? ""
            : "0"
          : `${safeIdx + 1}/${matches.length}`}
      </span>
      <button
        type="button"
        onClick={() => go(-1)}
        title="Précédent (Maj+Entrée)"
        className="rounded px-1.5 py-0.5 text-sm text-neutral-600 hover:bg-neutral-100"
      >
        ↑
      </button>
      <button
        type="button"
        onClick={() => go(1)}
        title="Suivant (Entrée)"
        className="rounded px-1.5 py-0.5 text-sm text-neutral-600 hover:bg-neutral-100"
      >
        ↓
      </button>
      <button
        type="button"
        onClick={onClose}
        title="Fermer (Échap)"
        className="rounded px-1.5 py-0.5 text-sm text-neutral-600 hover:bg-neutral-100"
      >
        ✕
      </button>
    </div>
  );
}
