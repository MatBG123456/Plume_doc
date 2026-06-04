import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";
import type { Document, Op } from "../bindings";
import { DocumentView } from "../render/DocumentView";
import { fixtureDoc } from "../render/fixture";
import { EditorContext, type DispatchOpts, type EditorApi, type PendingFocus } from "./EditorContext";
import { Toolbar } from "./Toolbar";
import { ChatPanel } from "./ChatPanel";
import { CommandPalette, type Command } from "./CommandPalette";
import { SearchBar } from "./SearchBar";
import { Spark } from "../Spark";

// Racine de l'éditeur. Le document vit côté Rust (source de vérité) : on le
// charge au montage, et chaque édition est une `Op` envoyée à `apply_op`. La
// boucle agent (Wave 5) mute le **même** document et émet `op_applied`.
//
// Wave 6 — persistance : ouvrir/enregistrer un `.plume.json` (I/O côté Rust,
// sélecteur natif via plugin-dialog) + autosave débouncé. Le **snapshot** du doc
// est passé à `save_document` (le contenu écrit est lié au chemin) ; un drapeau
// `dirty` versionné évite d'effacer l'état modifié quand une édition survient
// pendant un enregistrement ; un flush à la fermeture évite la perte d'édits.

const FILTERS = [{ name: "Plume", extensions: ["json"] }];

// Cache de session (localStorage) : permet de fermer sans enregistrer puis de
// retrouver son travail au prochain lancement (récupération de brouillon).
const SESSION_KEY = "plume.session";
type Session = { doc: Document; path: string | null; dirty: boolean };

function cacheSession(doc: Document | null, path: string | null, dirty: boolean) {
  if (!doc) return;
  try {
    localStorage.setItem(SESSION_KEY, JSON.stringify({ doc, path, dirty }));
  } catch {
    // quota dépassé (très gros document) : cache best-effort, on ignore.
  }
}

function readSession(): Session | null {
  try {
    const raw = localStorage.getItem(SESSION_KEY);
    if (!raw) return null;
    const s = JSON.parse(raw) as Session;
    if (!s || typeof s !== "object" || !s.doc || !Array.isArray(s.doc.blocks)) return null;
    return s;
  } catch {
    return null;
  }
}

export function Editor() {
  const [doc, setDoc] = useState<Document | null>(null);
  const [editable, setEditable] = useState(false);
  const [syncSignal, setSyncSignal] = useState(0);
  const [pendingFocus, setPendingFocus] = useState<PendingFocus>(null);
  const [error, setError] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null); // bloc ciblé pour l'assistant
  // Ouverture du chat : par défaut ouvert sur grand écran, fermé sur petit ;
  // mémorisé. Le document récupère la largeur quand le chat est fermé.
  const [chatOpen, setChatOpen] = useState(() => {
    const s = localStorage.getItem("plume.chatOpen");
    if (s === "1") return true;
    if (s === "0") return false;
    return window.matchMedia?.("(min-width: 1024px)").matches ?? true;
  });

  const queue = useRef<Promise<void>>(Promise.resolve());
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const rev = useRef(0); // révision d'édition, incrémentée à chaque modification
  // Miroirs pour les handlers impératifs (raccourcis, fermeture) sans closures périmées.
  const docRef = useRef<Document | null>(null);
  const pathRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const closing = useRef(false); // garde de ré-entrance du flush de fermeture
  const prevFocus = useRef<HTMLElement | null>(null); // focus à restaurer après un overlay

  useEffect(() => {
    docRef.current = doc;
    pathRef.current = path;
    dirtyRef.current = dirty;
  });

  useEffect(() => {
    invoke<Document>("get_document")
      .then(async (d) => {
        setEditable(true);
        // Restauration de session : si un cache existe, on remet le document Rust
        // dans cet état (set_document) puis on l'affiche ; sinon, doc de départ.
        const cached = readSession();
        if (cached) {
          try {
            await invoke("set_document", { doc: cached.doc });
            setDoc(cached.doc);
            setPath(cached.path ?? null);
            setDirty(cached.dirty);
            return;
          } catch {
            // échec de restauration → on retombe sur le doc de départ.
          }
        }
        setDoc(d);
      })
      .catch(() => {
        setDoc(fixtureDoc);
        setEditable(false);
      });
  }, []);

  const markEdited = useCallback(() => {
    rev.current += 1;
    setDirty(true);
  }, []);

  const dispatch = useCallback(
    (op: Op, opts?: DispatchOpts) => {
      queue.current = queue.current.then(async () => {
        try {
          const next = await invoke<Document>("apply_op", { op });
          setDoc(next);
          markEdited();
          setError("");
          if (opts?.sync) setSyncSignal((n) => n + 1);
        } catch (e) {
          setError(String(e));
          setPendingFocus(null); // pas de focus fantôme si l'op a échoué
        }
      });
    },
    [markEdited],
  );

  // Preview live de la boucle agent : `op_applied` → on met à jour `doc` (les
  // blocs NON focalisés se rafraîchissent via l'effet (a)) SANS bump de
  // syncSignal (sinon l'effet (b) écraserait une frappe en cours dans le bloc
  // focalisé). On marque le document modifié (autosave).
  useEffect(() => {
    if (!editable) return;
    const subs = [
      listen<{ doc: Document }>("op_applied", (e) => {
        setDoc(e.payload.doc);
        markEdited();
      }),
      listen<{ message: string }>("chat_error", (e) => setError(e.payload.message)),
    ];
    return () => {
      subs.forEach((p) => void p.then((un) => un()));
    };
  }, [editable, markEdited]);

  // Enregistre un snapshot `docToSave` à `target`. Les saves sont sérialisés
  // (chaîne de promesses) ; `dirty` n'est levé que si AUCUNE édition n'est
  // survenue depuis la capture (sinon le nouvel état resterait « non enregistré »).
  const saveTo = useCallback((target: string, docToSave: Document): Promise<void> => {
    const at = rev.current;
    saveChain.current = saveChain.current.then(async () => {
      setSaving(true);
      try {
        await invoke("save_document", { path: target, doc: docToSave });
        if (rev.current === at) setDirty(false);
        setError("");
      } catch (e) {
        setError(String(e));
      } finally {
        setSaving(false);
      }
    });
    return saveChain.current;
  }, []);

  const saveAsFile = useCallback(async (): Promise<string | null> => {
    try {
      const selected = await saveDialog({
        defaultPath: pathRef.current ?? "document.plume.json",
        filters: FILTERS,
      });
      if (typeof selected !== "string") return null; // annulé
      setPath(selected);
      await saveTo(selected, docRef.current ?? fixtureDoc);
      return selected;
    } catch (e) {
      setError(String(e));
      return null;
    }
  }, [saveTo]);

  const saveCurrent = useCallback(() => {
    if (pathRef.current) void saveTo(pathRef.current, docRef.current ?? fixtureDoc);
    else void saveAsFile();
  }, [saveTo, saveAsFile]);

  const openFile = useCallback(async () => {
    if (dirtyRef.current) {
      const ok = window.confirm("Des modifications non enregistrées seront perdues. Continuer ?");
      if (!ok) return;
    }
    try {
      const selected = await openDialog({ filters: FILTERS, multiple: false, directory: false });
      if (typeof selected !== "string") return; // annulé
      const loaded = await invoke<Document>("open_document", { path: selected });
      rev.current += 1; // invalide un autosave en vol lié à l'ancien document
      setDoc(loaded);
      setSyncSignal((n) => n + 1); // rafraîchit tous les éditables sur le doc chargé
      setPath(selected);
      setDirty(false);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Undo/redo : la machinerie (piles d'inverses) vit côté Rust ; ici on rejoue
  // et on resynchronise tout le rendu (le document change structurellement).
  // Sérialisés sur la MÊME file que la frappe : une op SetRuns en vol s'applique
  // forcément avant le undo/redo (sinon le coalescing/les inverses se décalent).
  // Rust renvoie `null` si la pile était vide → on ne touche alors à rien.
  const undo = useCallback(() => {
    queue.current = queue.current.then(async () => {
      try {
        const next = await invoke<Document | null>("undo");
        if (next) {
          setDoc(next);
          setSyncSignal((n) => n + 1);
          markEdited();
        }
        setError("");
      } catch (e) {
        setError(String(e));
      }
    });
  }, [markEdited]);

  const redo = useCallback(() => {
    queue.current = queue.current.then(async () => {
      try {
        const next = await invoke<Document | null>("redo");
        if (next) {
          setDoc(next);
          setSyncSignal((n) => n + 1);
          markEdited();
        }
        setError("");
      } catch (e) {
        setError(String(e));
      }
    });
  }, [markEdited]);

  // Ouverture/fermeture des overlays : on mémorise le focus (l'éditable) à
  // l'ouverture et on le restaure à la fermeture (le caret n'est pas perdu).
  const openPalette = useCallback(() => {
    prevFocus.current = document.activeElement as HTMLElement | null;
    setSearchOpen(false);
    setPaletteOpen(true);
  }, []);
  const openSearch = useCallback(() => {
    prevFocus.current = document.activeElement as HTMLElement | null;
    setPaletteOpen(false);
    setSearchOpen(true);
  }, []);
  const closePalette = useCallback(() => {
    setPaletteOpen(false);
    prevFocus.current?.focus?.();
  }, []);
  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    prevFocus.current?.focus?.();
  }, []);

  // Nom de base pour les exports (dérivé du fichier courant, sans extension).
  const baseName = useCallback(() => {
    const n = pathRef.current ? pathRef.current.split(/[\\/]/).pop() ?? "document" : "document";
    return n.replace(/\.plume\.json$/i, "").replace(/\.json$/i, "");
  }, []);

  const exportMarkdown = useCallback(async () => {
    try {
      const selected = await saveDialog({
        defaultPath: `${baseName()}.md`,
        filters: [{ name: "Markdown", extensions: ["md"] }],
      });
      if (typeof selected !== "string") return;
      await invoke("export_markdown", { path: selected, doc: docRef.current ?? fixtureDoc });
    } catch (e) {
      setError(String(e));
    }
  }, [baseName]);

  const exportDocx = useCallback(async () => {
    try {
      const selected = await saveDialog({
        defaultPath: `${baseName()}.docx`,
        filters: [{ name: "Word", extensions: ["docx"] }],
      });
      if (typeof selected !== "string") return;
      await invoke("export_docx", { path: selected, doc: docRef.current ?? fixtureDoc });
    } catch (e) {
      setError(String(e));
    }
  }, [baseName]);

  // PDF : on imprime le webview (le renderer sert de mise en page) ; le CSS
  // `print:` masque tout le chrome et n'imprime que la page du document.
  function exportPdf() {
    window.print();
  }

  // Autosave débouncé : ~800 ms après la dernière modification, si un chemin est
  // connu. Le `doc` courant (snapshot) est passé à `saveTo`.
  useEffect(() => {
    if (!path || !dirty || !doc) return;
    const t = setTimeout(() => void saveTo(path, doc), 800);
    return () => clearTimeout(t);
  }, [path, dirty, doc, saveTo]);

  // Cache de session : ~500 ms après une modification, on persiste {doc, path,
  // dirty} dans localStorage (récupération au prochain lancement).
  useEffect(() => {
    if (!editable || !doc) return;
    const t = setTimeout(() => cacheSession(doc, path, dirty), 500);
    return () => clearTimeout(t);
  }, [editable, doc, path, dirty]);

  // Raccourcis globaux : enregistrer/ouvrir, annuler/rétablir, palette, recherche.
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      // Ne pas détourner les raccourcis quand le focus est dans un champ de
      // saisie (palette, recherche, chat), qui gère son propre undo natif, etc.
      // Le contentEditable du document n'est PAS un INPUT/TEXTAREA.
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA")) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        saveCurrent();
      } else if (k === "o") {
        e.preventDefault();
        void openFile();
      } else if (k === "z") {
        // preventDefault neutralise l'undo natif du contentEditable.
        e.preventDefault();
        if (e.shiftKey) redo();
        else undo();
      } else if (k === "y") {
        e.preventDefault();
        redo();
      } else if (k === "k") {
        e.preventDefault();
        openPalette();
      } else if (k === "f") {
        e.preventDefault();
        openSearch();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, saveCurrent, openFile, undo, redo, openPalette, openSearch]);

  // Flush à la fermeture : si des modifications sont en attente, on les enregistre
  // (ou on propose un « Enregistrer sous… » pour un brouillon) avant de fermer.
  useEffect(() => {
    if (!editable) return;
    let unlisten: (() => void) | undefined;
    let cancelled = false;
    (async () => {
      try {
        const win = getCurrentWindow();
        const un = await win.onCloseRequested(async (e) => {
          if (!dirtyRef.current) return; // propre → fermeture normale
          e.preventDefault();
          if (closing.current) return; // anti ré-entrance
          closing.current = true;
          try {
            // On NE force PAS l'enregistrement : fermer sans enregistrer reste
            // possible (le cache de session restaure au prochain lancement) ;
            // « Annuler » garde la fenêtre ouverte.
            const close = window.confirm(
              "Des modifications ne sont pas enregistrées dans un fichier.\n\n" +
                "OK = fermer (vos modifications seront récupérées au prochain lancement)\n" +
                "Annuler = rester (Ctrl+S pour enregistrer dans un fichier).",
            );
            if (close) {
              cacheSession(docRef.current, pathRef.current, true); // capture l'état le plus frais
              await win.destroy();
            }
          } finally {
            closing.current = false;
          }
        });
        if (cancelled) un();
        else unlisten = un;
      } catch {
        // onCloseRequested indisponible (env/capability) → dégradation silencieuse.
      }
    })();
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [editable]);

  const requestFocus = useCallback((id: string, offset: number) => {
    setPendingFocus({ id, offset });
  }, []);

  const clearFocus = useCallback(() => setPendingFocus(null), []);

  const setFocus = useCallback((id: string | null) => setFocusId(id), []);

  // Le bloc ciblé disparaît (suppression) → on retire le focus prioritaire.
  useEffect(() => {
    if (focusId && doc && !doc.blocks.some((b) => b.id === focusId)) setFocusId(null);
  }, [doc, focusId]);

  const toggleChat = useCallback(
    () =>
      setChatOpen((v) => {
        localStorage.setItem("plume.chatOpen", v ? "0" : "1");
        return !v;
      }),
    [],
  );

  if (!doc) {
    return <div className="p-10 text-sm text-faint">Chargement du document…</div>;
  }

  const api: EditorApi = {
    doc,
    editable,
    syncSignal,
    dispatch,
    pendingFocus,
    requestFocus,
    clearFocus,
    focusId,
    setFocus,
  };

  const fileName = path ? path.split(/[\\/]/).pop() ?? path : "Brouillon";
  const status = saving ? "enregistrement…" : dirty ? "non enregistré" : path ? "enregistré" : "non enregistré";
  const dot = saving ? "bg-coral" : !path || dirty ? "bg-faint" : "bg-teal";

  const commands: Command[] = [
    { id: "open", label: "Ouvrir…", hint: "Ctrl+O", run: () => void openFile() },
    { id: "save", label: "Enregistrer", hint: "Ctrl+S", run: saveCurrent },
    { id: "saveas", label: "Enregistrer sous…", run: () => void saveAsFile() },
    { id: "exp-md", label: "Exporter en Markdown", run: () => void exportMarkdown() },
    { id: "exp-docx", label: "Exporter en Word (.docx)", run: () => void exportDocx() },
    { id: "exp-pdf", label: "Exporter en PDF", run: exportPdf },
    { id: "undo", label: "Annuler", hint: "Ctrl+Z", run: () => void undo() },
    { id: "redo", label: "Rétablir", hint: "Ctrl+Maj+Z", run: () => void redo() },
    { id: "search", label: "Rechercher…", hint: "Ctrl+F", run: openSearch },
  ];

  return (
    <EditorContext.Provider value={api}>
      {/* Zone document : réserve la largeur du chat sur grand écran s'il est ouvert. */}
      <div className={chatOpen ? "lg:pr-[360px]" : ""}>
        <div className="min-w-0">
          {editable && (
            <div className="sticky top-[49px] z-10 bg-paper/95 backdrop-blur print:hidden">
              <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-1.5 sm:px-4">
                <FileButton onClick={() => void openFile()}>Ouvrir</FileButton>
                <FileButton onClick={saveCurrent}>Enregistrer</FileButton>
                <FileButton onClick={() => void saveAsFile()}>Enregistrer sous…</FileButton>
                <span className="mx-1 h-5 w-px bg-line" />
                <FileButton onClick={() => void undo()} title="Annuler (Ctrl+Z)">
                  ↶
                </FileButton>
                <FileButton onClick={() => void redo()} title="Rétablir (Ctrl+Maj+Z)">
                  ↷
                </FileButton>
                <span className="mx-1 h-5 w-px bg-line" />
                <FileButton onClick={() => void exportMarkdown()}>↧ Markdown</FileButton>
                <FileButton onClick={() => void exportDocx()}>↧ Word</FileButton>
                <FileButton onClick={exportPdf}>↧ PDF</FileButton>
                <span className="mx-1 h-5 w-px bg-line" />
                <button
                  type="button"
                  title="Rechercher (Ctrl+F)"
                  onMouseDown={(e) => {
                    e.preventDefault(); // garde le focus de l'éditable
                    openSearch();
                  }}
                  className="rounded-md px-2 py-1 text-sm text-muted hover:bg-coral-soft hover:text-coral-ink"
                >
                  🔍
                </button>
                <button
                  type="button"
                  title="Palette de commandes (Ctrl+K)"
                  onMouseDown={(e) => {
                    e.preventDefault();
                    openPalette();
                  }}
                  className="rounded-md px-2 py-1 text-sm text-muted hover:bg-coral-soft hover:text-coral-ink"
                >
                  ⌘K
                </button>
                <span className="mx-1 hidden h-5 w-px bg-line lg:block" />
                <button
                  type="button"
                  title={chatOpen ? "Masquer l'assistant" : "Afficher l'assistant"}
                  onClick={toggleChat}
                  className={`hidden items-center gap-1 rounded-md px-2 py-1 text-sm lg:inline-flex ${
                    chatOpen
                      ? "bg-coral-soft text-coral-ink"
                      : "text-muted hover:bg-coral-soft hover:text-coral-ink"
                  }`}
                >
                  <Spark className="h-3.5 w-3.5" /> Assistant
                </button>
                <span className="ml-auto flex items-center gap-1.5 text-xs text-muted">
                  <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                  <span className="font-medium text-ink">{fileName}</span>
                  <span>· {status}</span>
                </span>
              </div>
              <Toolbar />
            </div>
          )}
          <DocumentView doc={doc} />
        </div>
      </div>

      {/* Chat : panneau latéral (desktop) / tiroir coulissant (mobile),
          ouvrable et fermable à toute taille. */}
      {editable && (
        <>
          <aside
            className={`fixed bottom-0 right-0 top-[49px] z-30 flex w-[min(360px,92vw)] flex-col border-l border-line bg-paper shadow-pop transition-transform lg:w-[360px] lg:shadow-none print:hidden ${
              chatOpen ? "translate-x-0" : "translate-x-full"
            }`}
          >
            <ChatPanel />
          </aside>
          {/* Fond cliquable (mobile seulement) quand le tiroir est ouvert. */}
          {chatOpen && (
            <div
              className="fixed inset-0 z-20 bg-ink/20 lg:hidden print:hidden"
              onClick={toggleChat}
            />
          )}
          {/* Bouton flottant (mobile) : ouvre/ferme l'assistant. */}
          <button
            type="button"
            onClick={toggleChat}
            title={chatOpen ? "Fermer l'assistant" : "Assistant"}
            className="fixed bottom-4 right-4 z-40 flex items-center gap-1.5 rounded-pill bg-coral px-4 py-2.5 text-sm font-medium text-white shadow-pop lg:hidden print:hidden"
          >
            {chatOpen ? (
              "✕"
            ) : (
              <>
                <Spark className="h-4 w-4" /> Assistant
              </>
            )}
          </button>
        </>
      )}

      {error && (
        <div className="fixed bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-pill bg-deny px-4 py-2 text-sm text-white shadow-soft print:hidden">
          {error}
        </div>
      )}

      {paletteOpen && <CommandPalette commands={commands} onClose={closePalette} />}
      {searchOpen && <SearchBar doc={doc} onClose={closeSearch} />}
    </EditorContext.Provider>
  );
}

function FileButton({
  onClick,
  children,
  title,
}: {
  onClick: () => void;
  children: ReactNode;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className="rounded-md px-2 py-1 text-sm text-muted hover:bg-coral-soft hover:text-coral-ink"
    >
      {children}
    </button>
  );
}
