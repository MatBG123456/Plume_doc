import { useEffect, useMemo, useState } from "react";
import type { Document, Node as DocNode, Run } from "../bindings";
import { setSelection } from "./caret";
import { useEditor } from "./EditorContext";
import { charsToRuns, runsToChars } from "./text";
import { occurrences, replaceRanges } from "./search";

// Recherche / remplacement dans le document (Wave 8). Les correspondances sont
// calculées sur le **modèle** (texte concaténé des blocs textuels), surlignées
// dans le DOM via `setSelection`. Le remplacement reconstruit les runs du bloc
// (en héritant les marques du voisin) et émet `SetRuns`. ↑/↓ ou boutons ;
// Entrée = suivant ; Échap = fermer.

type Match = { id: string; start: number; end: number };

function nodeRuns(node: DocNode): Run[] | null {
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

function blockText(node: DocNode): string | null {
  const runs = nodeRuns(node);
  return runs ? runs.map((r) => r.text).join("") : null;
}

export function SearchBar({ doc, onClose }: { doc: Document; onClose: () => void }) {
  const editor = useEditor();
  const [query, setQuery] = useState("");
  const [replacement, setReplacement] = useState("");
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

  const safeIdx = matches.length > 0 ? idx % matches.length : 0;

  useEffect(() => {
    const m = matches[safeIdx];
    if (!m) return;
    try {
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

  const replaceCurrent = () => {
    const m = matches[safeIdx];
    if (!m || !editor) return;
    const block = doc.blocks.find((b) => b.id === m.id);
    const runs = block ? nodeRuns(block.node) : null;
    if (!runs) return;
    const next = replaceRanges(runsToChars(runs), [{ start: m.start, end: m.end }], replacement);
    editor.dispatch({ op: "SetRuns", id: m.id, runs: charsToRuns(next) }, { sync: true });
  };

  const replaceAll = () => {
    if (!editor || matches.length === 0) return;
    const byBlock = new Map<string, { start: number; end: number }[]>();
    for (const m of matches) {
      const arr = byBlock.get(m.id) ?? [];
      arr.push({ start: m.start, end: m.end });
      byBlock.set(m.id, arr);
    }
    for (const [id, ranges] of byBlock) {
      const block = doc.blocks.find((b) => b.id === id);
      const runs = block ? nodeRuns(block.node) : null;
      if (!runs) continue;
      const sorted = [...ranges].sort((a, b) => a.start - b.start);
      const next = replaceRanges(runsToChars(runs), sorted, replacement);
      editor.dispatch({ op: "SetRuns", id, runs: charsToRuns(next) }, { sync: true });
    }
  };

  const btn = "rounded-md px-1.5 py-0.5 text-sm text-muted hover:bg-coral-soft hover:text-coral-ink";

  return (
    <div className="fixed left-1/2 top-3 z-50 flex w-[min(420px,92vw)] -translate-x-1/2 flex-col gap-1.5 rounded-panel bg-card px-3 py-2 shadow-pop ring-1 ring-line print:hidden">
      <div className="flex items-center gap-2">
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
          className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-faint"
        />
        <span className="min-w-12 text-right font-mono text-xs text-muted">
          {matches.length === 0 ? (query.trim() === "" ? "" : "0") : `${safeIdx + 1}/${matches.length}`}
        </span>
        <button type="button" onClick={() => go(-1)} title="Précédent (Maj+Entrée)" className={btn}>
          ↑
        </button>
        <button type="button" onClick={() => go(1)} title="Suivant (Entrée)" className={btn}>
          ↓
        </button>
        <button type="button" onClick={onClose} title="Fermer (Échap)" className={btn}>
          ✕
        </button>
      </div>

      {editor && (
        <div className="flex items-center gap-2 border-t border-line pt-1.5">
          <input
            value={replacement}
            onChange={(e) => setReplacement(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Escape") {
                e.preventDefault();
                onClose();
              }
            }}
            placeholder="Remplacer par…"
            className="min-w-0 flex-1 bg-transparent text-sm text-ink outline-none placeholder:text-faint"
          />
          <button
            type="button"
            onClick={replaceCurrent}
            disabled={matches.length === 0}
            title="Remplacer cette occurrence"
            className={`${btn} disabled:opacity-40`}
          >
            Remplacer
          </button>
          <button
            type="button"
            onClick={replaceAll}
            disabled={matches.length === 0}
            title="Tout remplacer"
            className={`rounded-md px-2 py-0.5 text-sm font-medium text-coral hover:bg-coral-soft hover:text-coral-ink disabled:opacity-40`}
          >
            Tout
          </button>
        </div>
      )}
    </div>
  );
}
