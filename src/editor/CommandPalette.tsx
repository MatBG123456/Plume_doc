import { useEffect, useMemo, useState } from "react";

// Palette de commandes (Wave 8). Overlay modale : filtre au clavier, navigation
// ↑/↓, Entrée pour exécuter, Échap pour fermer. Générique : `Editor` lui fournit
// la liste des commandes (closures sur ses actions).

export type Command = { id: string; label: string; hint?: string; run: () => void };

export function CommandPalette({
  commands,
  onClose,
}: {
  commands: Command[];
  onClose: () => void;
}) {
  const [query, setQuery] = useState("");
  const [sel, setSel] = useState(0);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q === "" ? commands : commands.filter((c) => c.label.toLowerCase().includes(q));
  }, [commands, query]);

  useEffect(() => setSel(0), [query]);

  function exec(c: Command) {
    onClose();
    c.run();
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-ink/20 pt-[15vh] print:hidden"
      onMouseDown={onClose}
    >
      <div
        className="w-[540px] max-w-[90vw] overflow-hidden rounded-panel bg-card shadow-pop ring-1 ring-line"
        onMouseDown={(e) => e.stopPropagation()}
      >
        <input
          autoFocus
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") {
              e.preventDefault();
              setSel((s) => Math.min(s + 1, filtered.length - 1));
            } else if (e.key === "ArrowUp") {
              e.preventDefault();
              setSel((s) => Math.max(s - 1, 0));
            } else if (e.key === "Enter") {
              e.preventDefault();
              if (filtered[sel]) exec(filtered[sel]);
            } else if (e.key === "Escape") {
              e.preventDefault();
              onClose();
            }
          }}
          placeholder="Tapez une commande…"
          className="w-full border-b border-line bg-transparent px-4 py-3 text-sm text-ink outline-none placeholder:text-faint"
        />
        <ul className="max-h-[50vh] overflow-y-auto py-1">
          {filtered.length === 0 && (
            <li className="px-4 py-2 text-sm text-faint">Aucune commande</li>
          )}
          {filtered.map((c, i) => (
            <li key={c.id}>
              <button
                type="button"
                onMouseEnter={() => setSel(i)}
                onMouseDown={(e) => {
                  e.preventDefault();
                  exec(c);
                }}
                className={`flex w-full items-center justify-between px-4 py-2 text-left text-sm ${
                  i === sel ? "bg-coral-soft text-coral-ink" : "text-ink hover:bg-coral-soft"
                }`}
              >
                <span>{c.label}</span>
                {c.hint && <span className="font-mono text-xs text-faint">{c.hint}</span>}
              </button>
            </li>
          ))}
        </ul>
      </div>
    </div>
  );
}
