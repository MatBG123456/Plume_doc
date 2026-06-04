import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Document } from "../bindings";
import { Editor } from "./Editor";
import { Plus, X } from "../icons";

// Gestion multi-onglets. Le backend Rust ne tient qu'UN document (l'onglet
// actif) ; basculer d'onglet appelle `set_document` pour y charger le snapshot
// cible, puis remonte un `Editor` neuf (clé = id d'onglet). Les snapshots vivent
// dans une ref (pas de re-render par frappe, l'Editor est mémoïsé) ; seules les
// métadonnées (titre/dirty) sont en state. Le cache de session et le garde-fou
// de fermeture couvrent TOUS les onglets (déplacés depuis l'Editor).
//
// Limite assumée (v1) : l'historique undo/redo (côté Rust) est propre au document
// actif et réinitialisé à chaque bascule (set_document vide les piles).

const SESSION_KEY = "plume.session";

type TabMeta = { id: string; title: string; path: string | null; dirty: boolean };
type Cached = { v: number; activeId: string; tabs: (TabMeta & { doc: Document | null })[] };

const MemoEditor = memo(Editor);

function makeId(): string {
  const c = globalThis.crypto;
  if (c && "randomUUID" in c) return c.randomUUID();
  return `t-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
}

function blankDoc(): Document {
  return {
    meta: { title: "", lang: "fr" },
    blocks: [{ id: makeId(), node: { type: "Paragraph", runs: [] } }],
  };
}

function baseName(path: string): string {
  const n = path.split(/[\\/]/).pop() ?? path;
  return n.replace(/\.plume\.json$/i, "").replace(/\.json$/i, "");
}

function deriveTitle(path: string | null, doc: Document): string {
  if (path) return baseName(path);
  return doc.meta.title.trim() || "Sans titre";
}

function readCache(): Cached | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const c = JSON.parse(raw) as Cached;
    if (!c || c.v !== 2 || !Array.isArray(c.tabs)) return null;
    const tabs = c.tabs.filter((t) => t.doc && Array.isArray(t.doc.blocks));
    if (tabs.length === 0) return null;
    return { ...c, tabs };
  } catch {
    return null;
  }
}

export function TabManager() {
  const initialId = useMemo(makeId, []);
  const [tabs, setTabs] = useState<TabMeta[]>(() => [
    { id: initialId, title: "Sans titre", path: null, dirty: false },
  ]);
  const [activeId, setActiveId] = useState(initialId);
  const [ready, setReady] = useState(false);

  const snapshots = useRef<Record<string, Document>>({});
  const tabsRef = useRef(tabs);
  const activeIdRef = useRef(activeId);
  const cacheTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const closing = useRef(false);
  // Flush impératif de l'Editor actif (branché par l'Editor monté).
  const flushRef = useRef<(() => Promise<Document | null>) | null>(null);

  useEffect(() => {
    tabsRef.current = tabs;
    activeIdRef.current = activeId;
  });

  // Draine les ops/autosave en vol de l'onglet actif et capture son doc à jour
  // dans `snapshots`. À appeler AVANT tout `set_document` de bascule, sinon une op
  // tardive s'appliquerait au mauvais document (corruption) ou serait perdue.
  const flushActive = useCallback(async () => {
    try {
      const doc = await flushRef.current?.();
      if (doc) snapshots.current[activeIdRef.current] = doc;
    } catch {
      // best-effort : on garde la dernière snapshot connue.
    }
  }, []);

  const writeCache = useCallback(() => {
    try {
      const payload: Cached = {
        v: 2,
        activeId: activeIdRef.current,
        tabs: tabsRef.current.map((t) => ({ ...t, doc: snapshots.current[t.id] ?? null })),
      };
      localStorage.setItem(SESSION_KEY, JSON.stringify(payload));
    } catch {
      // quota dépassé : cache best-effort.
    }
  }, []);

  const scheduleCache = useCallback(() => {
    if (cacheTimer.current) clearTimeout(cacheTimer.current);
    cacheTimer.current = setTimeout(writeCache, 600);
  }, [writeCache]);

  // Restauration de session au démarrage (avant de monter l'Editor).
  useEffect(() => {
    void (async () => {
      const cached = readCache();
      if (cached) {
        cached.tabs.forEach((t) => {
          if (t.doc) snapshots.current[t.id] = t.doc;
        });
        const active = cached.tabs.find((t) => t.id === cached.activeId) ?? cached.tabs[0];
        try {
          await invoke("set_document", { doc: snapshots.current[active.id] });
        } catch {
          // ignore : l'Editor chargera le doc Rust courant.
        }
        setTabs(cached.tabs.map((t) => ({ id: t.id, title: t.title, path: t.path, dirty: t.dirty })));
        setActiveId(active.id);
      } else {
        // Pas de cache : on capture le doc de départ (Rust) comme snapshot de
        // l'onglet initial, pour qu'une bascule précoce ne le perde pas.
        try {
          snapshots.current[initialId] = await invoke<Document>("get_document");
        } catch {
          snapshots.current[initialId] = blankDoc();
        }
      }
      setReady(true);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Remontée d'état depuis l'Editor actif → snapshot (ref) + métadonnées (state).
  const onState = useCallback(
    (s: { doc: Document; path: string | null; dirty: boolean }) => {
      const id = activeIdRef.current;
      snapshots.current[id] = s.doc;
      const title = deriveTitle(s.path, s.doc);
      setTabs((prev) => {
        const i = prev.findIndex((t) => t.id === id);
        if (i < 0) return prev;
        const t = prev[i];
        if (t.path === s.path && t.dirty === s.dirty && t.title === title) return prev;
        const next = prev.slice();
        next[i] = { ...t, path: s.path, dirty: s.dirty, title };
        return next;
      });
      scheduleCache();
    },
    [scheduleCache],
  );

  const switchTo = useCallback(
    async (id: string) => {
      if (id === activeIdRef.current) return;
      await flushActive(); // capture la dernière frappe + draine les ops de l'onglet sortant
      const snap = snapshots.current[id] ?? blankDoc();
      snapshots.current[id] = snap;
      try {
        await invoke("set_document", { doc: snap });
      } catch {
        return; // échec → on ne bascule pas (UI cohérente avec Rust)
      }
      setActiveId(id);
      writeCache();
    },
    [flushActive, writeCache],
  );

  const newTab = useCallback(async () => {
    await flushActive(); // draine l'onglet sortant avant le set_document du nouvel onglet
    const id = makeId();
    const doc = blankDoc();
    snapshots.current[id] = doc;
    try {
      await invoke("set_document", { doc });
    } catch {
      return;
    }
    setTabs((p) => [...p, { id, title: "Sans titre", path: null, dirty: false }]);
    setActiveId(id);
    writeCache();
  }, [flushActive, writeCache]);

  const closeTab = useCallback(
    async (id: string) => {
      const cur = tabsRef.current;
      const tab = cur.find((t) => t.id === id);
      if (
        tab?.dirty &&
        !window.confirm(`Fermer « ${tab.title} » ? Les modifications non enregistrées seront perdues.`)
      ) {
        return;
      }
      const wasActive = id === activeIdRef.current;
      // Draine l'onglet actif AVANT toute mutation Rust (aucune op tardive ne doit
      // s'appliquer au document voisin).
      if (wasActive) await flushActive();

      const idx = cur.findIndex((t) => t.id === id);
      const remaining = cur.filter((t) => t.id !== id);

      if (remaining.length === 0) {
        // Dernier onglet fermé → on recrée un onglet vierge.
        const nid = makeId();
        const doc = blankDoc();
        snapshots.current[nid] = doc;
        try {
          await invoke("set_document", { doc });
        } catch {
          return;
        }
        delete snapshots.current[id];
        setTabs([{ id: nid, title: "Sans titre", path: null, dirty: false }]);
        setActiveId(nid);
        writeCache();
        return;
      }

      if (wasActive) {
        const next = remaining[Math.min(idx, remaining.length - 1)];
        const nextDoc = snapshots.current[next.id] ?? blankDoc();
        snapshots.current[next.id] = nextDoc;
        try {
          await invoke("set_document", { doc: nextDoc });
        } catch {
          return; // échec → on ne ferme pas (sinon UI désynchro de Rust)
        }
        delete snapshots.current[id];
        setTabs(remaining);
        setActiveId(next.id);
      } else {
        delete snapshots.current[id];
        setTabs(remaining);
      }
      writeCache();
    },
    [flushActive, writeCache],
  );

  // Garde-fou de fermeture : un onglet « dirty » suffit à demander confirmation.
  useEffect(() => {
    let un: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const win = getCurrentWindow();
        const u = await win.onCloseRequested(async (e) => {
          if (closing.current) return;
          closing.current = true;
          e.preventDefault(); // on gère la fermeture nous-mêmes (flush + cache)
          try {
            await flushActive(); // capture la dernière frappe de l'onglet actif
            const anyDirty = tabsRef.current.some((t) => t.dirty);
            if (anyDirty) {
              const close = window.confirm(
                "Des onglets ont des modifications non enregistrées.\n\n" +
                  "OK = fermer (récupérées au prochain lancement)\n" +
                  "Annuler = rester.",
              );
              if (!close) return; // rester ouvert
            }
            writeCache(); // flush synchrone du cache de session
            await win.destroy();
          } finally {
            closing.current = false;
          }
        });
        if (cancelled) u();
        else un = u;
      } catch {
        // indisponible (env/capability) → dégradation silencieuse.
      }
    })();
    return () => {
      cancelled = true;
      un?.();
    };
  }, [writeCache, flushActive]);

  if (!ready) {
    return <div className="p-10 text-sm text-faint">Chargement…</div>;
  }

  const activeTab = tabs.find((t) => t.id === activeId);

  return (
    <>
      <div className="sticky top-[49px] z-30 flex h-[37px] items-stretch gap-1 overflow-x-auto border-b border-line bg-paper/90 px-2 backdrop-blur print:hidden">
        {tabs.map((t) => {
          const active = t.id === activeId;
          return (
            <div
              key={t.id}
              className={`group my-1 flex shrink-0 items-center gap-1 rounded-row pl-3 pr-1.5 text-sm ${
                active ? "bg-card text-ink ring-1 ring-line" : "text-muted hover:bg-card/60"
              }`}
            >
              <button
                type="button"
                onClick={() => void switchTo(t.id)}
                className="flex max-w-[180px] items-center gap-1.5 truncate py-1"
                title={t.title}
              >
                {t.dirty && <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-coral" />}
                <span className="truncate">{t.title}</span>
              </button>
              <button
                type="button"
                onClick={() => void closeTab(t.id)}
                title="Fermer l'onglet"
                className="shrink-0 rounded p-0.5 text-faint hover:text-deny group-hover:opacity-100 sm:opacity-0"
              >
                <X className="h-3 w-3" />
              </button>
            </div>
          );
        })}
        <button
          type="button"
          onClick={() => void newTab()}
          title="Nouvel onglet"
          className="my-1 flex shrink-0 items-center rounded-row px-2 text-muted hover:bg-card hover:text-coral-ink"
        >
          <Plus className="h-4 w-4" />
        </button>
      </div>

      <MemoEditor
        key={activeId}
        onState={onState}
        flushRef={flushRef}
        initialPath={activeTab?.path ?? null}
        initialDirty={activeTab?.dirty ?? false}
      />
    </>
  );
}
