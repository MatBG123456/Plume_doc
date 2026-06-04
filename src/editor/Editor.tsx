import { useCallback, useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import type { Document, Op } from "../bindings";
import { DocumentView } from "../render/DocumentView";
import { fixtureDoc } from "../render/fixture";
import { EditorContext, type DispatchOpts, type EditorApi, type PendingFocus } from "./EditorContext";
import { Toolbar } from "./Toolbar";
import { ChatPanel } from "./ChatPanel";
import { CommandPalette, type Command } from "./CommandPalette";
import { SearchBar } from "./SearchBar";
import { Spark } from "../Spark";
import { Download, FileDown, FolderOpen, Redo, Save, Search, Undo, X } from "../icons";

// Racine de l'éditeur. Le document vit côté Rust (source de vérité) : on le
// charge au montage, et chaque édition est une `Op` envoyée à `apply_op`. La
// boucle agent (Wave 5) mute le **même** document et émet `op_applied`.
//
// Wave 6 — persistance : ouvrir/enregistrer un `.plume.json` (I/O côté Rust,
// sélecteur natif via plugin-dialog) + autosave débouncé. Le **snapshot** du doc
// est passé à `save_document` (le contenu écrit est lié au chemin) ; un drapeau
// `dirty` versionné évite d'effacer l'état modifié quand une édition survient
// pendant un enregistrement.
//
// Multi-onglets : le cache de session et le garde-fou de fermeture vivent
// désormais dans `TabManager`. L'Editor remonte son état via `onState`, reçoit
// `initialPath`/`initialDirty` au montage, et expose un `flushRef` (drain des ops
// + autosave) appelé avant chaque bascule d'onglet.

const FILTERS = [{ name: "Plume", extensions: ["json"] }];
const IMPORT_FILTERS = [
  { name: "Documents (md, txt, docx)", extensions: ["md", "markdown", "txt", "docx"] },
];

type EditorProps = {
  /** Remonte l'état courant (doc/path/dirty) au gestionnaire d'onglets. */
  onState?: (s: { doc: Document; path: string | null; dirty: boolean }) => void;
  /** Chemin/état initiaux (restaurés par l'onglet au montage). */
  initialPath?: string | null;
  initialDirty?: boolean;
  /** Le gestionnaire d'onglets y branche un flush impératif (drain des ops en vol
   *  + autosave en attente) renvoyant le doc faisant autorité, à appeler AVANT de
   *  basculer d'onglet — sinon la dernière frappe peut être perdue/corrompue. */
  flushRef?: { current: (() => Promise<Document | null>) | null };
};

export function Editor({
  onState,
  initialPath = null,
  initialDirty = false,
  flushRef,
}: EditorProps) {
  const [doc, setDoc] = useState<Document | null>(null);
  const [editable, setEditable] = useState(false);
  const [syncSignal, setSyncSignal] = useState(0);
  const [pendingFocus, setPendingFocus] = useState<PendingFocus>(null);
  const [error, setError] = useState("");
  const [path, setPath] = useState<string | null>(initialPath);
  const [dirty, setDirty] = useState(initialDirty);
  const [saving, setSaving] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [focusId, setFocusId] = useState<string | null>(null); // bloc ciblé pour l'assistant
  const [dragOver, setDragOver] = useState(false); // survol d'un fichier glissé
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
  const prevFocus = useRef<HTMLElement | null>(null); // focus à restaurer après un overlay

  useEffect(() => {
    docRef.current = doc;
    pathRef.current = path;
    dirtyRef.current = dirty;
  });

  // Le document Rust est positionné par le gestionnaire d'onglets (set_document)
  // avant le montage ; ici on le charge simplement (ou le starter au 1er lancement).
  useEffect(() => {
    invoke<Document>("get_document")
      .then((d) => {
        setDoc(d);
        setEditable(true);
      })
      .catch(() => {
        setDoc(fixtureDoc);
        setEditable(false);
      });
  }, []);

  // Remonte l'état courant au gestionnaire d'onglets (snapshot + titre + dirty).
  useEffect(() => {
    if (editable && doc) onState?.({ doc, path, dirty });
  }, [editable, doc, path, dirty, onState]);

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

  // Importe un document externe (md/markdown/txt/docx) : Rust le convertit vers
  // le modèle et remplace l'état d'édition. Pas de chemin (ce n'est pas un
  // .plume.json) → marqué « non enregistré » pour inciter à enregistrer.
  const importFile = useCallback(async () => {
    if (dirtyRef.current) {
      const ok = window.confirm("Des modifications non enregistrées seront perdues. Importer quand même ?");
      if (!ok) return;
    }
    try {
      const selected = await openDialog({ filters: IMPORT_FILTERS, multiple: false, directory: false });
      if (typeof selected !== "string") return; // annulé
      const loaded = await invoke<Document>("import_document", { path: selected });
      rev.current += 1;
      setDoc(loaded);
      setSyncSignal((n) => n + 1);
      setPath(null);
      setDirty(true);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Import d'un fichier déposé (drag & drop) : même flux qu'`importFile`, le
  // chemin venant du dépôt. On filtre l'extension avant d'appeler Rust.
  const importDropped = useCallback(async (path: string) => {
    if (!/\.(md|markdown|txt|docx)$/i.test(path)) {
      setError("Glisser-déposer : formats acceptés — md, txt, docx.");
      return;
    }
    if (dirtyRef.current) {
      const ok = window.confirm("Des modifications non enregistrées seront perdues. Importer le fichier déposé ?");
      if (!ok) return;
    }
    try {
      const loaded = await invoke<Document>("import_document", { path });
      rev.current += 1;
      setDoc(loaded);
      setSyncSignal((n) => n + 1);
      setPath(null);
      setDirty(true);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }, []);

  // Glisser-déposer un fichier sur la fenêtre pour l'importer (md/txt/docx).
  useEffect(() => {
    if (!editable) return;
    let un: (() => void) | undefined;
    let cancelled = false;
    void (async () => {
      try {
        const u = await getCurrentWebview().onDragDropEvent((e) => {
          if (e.payload.type === "drop") {
            setDragOver(false);
            const p = e.payload.paths[0];
            if (p) void importDropped(p);
          } else if (e.payload.type === "leave") {
            setDragOver(false);
          } else {
            setDragOver(true); // enter / over
          }
        });
        if (cancelled) u();
        else un = u;
      } catch {
        // API indisponible (env) → pas de drag&drop, sans erreur.
      }
    })();
    return () => {
      cancelled = true;
      un?.();
    };
  }, [editable, importDropped]);

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

  // Flush impératif pour le gestionnaire d'onglets : draine la file d'ops en vol
  // (pour ne pas perdre la dernière frappe ni laisser une op s'appliquer au mauvais
  // document après une bascule), enregistre un autosave en attente, et renvoie le
  // doc à jour. Branché tant que l'Editor est monté.
  useEffect(() => {
    if (!flushRef) return;
    flushRef.current = async () => {
      await queue.current;
      if (pathRef.current && dirtyRef.current) {
        try {
          await saveTo(pathRef.current, docRef.current ?? fixtureDoc);
        } catch {
          // erreur déjà surfacée par saveTo (setError)
        }
      }
      return docRef.current;
    };
    return () => {
      if (flushRef) flushRef.current = null;
    };
  }, [flushRef, saveTo]);

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
    { id: "import", label: "Importer (md, docx)…", run: () => void importFile() },
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
            <div className="sticky top-[86px] z-10 bg-paper/95 backdrop-blur print:hidden">
              <div className="flex flex-wrap items-center gap-1 border-b border-line px-3 py-1.5 sm:px-4">
                <FileButton onClick={() => void openFile()}>
                  <span className="inline-flex items-center gap-1">
                    <FolderOpen className="h-3.5 w-3.5" /> Ouvrir
                  </span>
                </FileButton>
                <FileButton onClick={() => void importFile()}>
                  <span className="inline-flex items-center gap-1">
                    <FileDown className="h-3.5 w-3.5" /> Importer
                  </span>
                </FileButton>
                <FileButton onClick={saveCurrent}>
                  <span className="inline-flex items-center gap-1">
                    <Save className="h-3.5 w-3.5" /> Enregistrer
                  </span>
                </FileButton>
                <FileButton onClick={() => void saveAsFile()}>Enregistrer sous…</FileButton>
                <span className="mx-1 h-5 w-px bg-line" />
                <FileButton onClick={() => void undo()} title="Annuler (Ctrl+Z)">
                  <Undo className="h-4 w-4" />
                </FileButton>
                <FileButton onClick={() => void redo()} title="Rétablir (Ctrl+Maj+Z)">
                  <Redo className="h-4 w-4" />
                </FileButton>
                <span className="mx-1 h-5 w-px bg-line" />
                <FileButton onClick={() => void exportMarkdown()}>
                  <span className="inline-flex items-center gap-1">
                    <Download className="h-3.5 w-3.5" /> Markdown
                  </span>
                </FileButton>
                <FileButton onClick={() => void exportDocx()}>
                  <span className="inline-flex items-center gap-1">
                    <Download className="h-3.5 w-3.5" /> Word
                  </span>
                </FileButton>
                <FileButton onClick={exportPdf}>
                  <span className="inline-flex items-center gap-1">
                    <Download className="h-3.5 w-3.5" /> PDF
                  </span>
                </FileButton>
                <span className="mx-1 h-5 w-px bg-line" />
                <button
                  type="button"
                  title="Rechercher (Ctrl+F)"
                  onMouseDown={(e) => {
                    e.preventDefault(); // garde le focus de l'éditable
                    openSearch();
                  }}
                  className="rounded-md px-2 py-1 text-muted hover:bg-coral-soft hover:text-coral-ink"
                >
                  <Search className="h-4 w-4" />
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
            className={`fixed bottom-0 right-0 top-[86px] z-30 flex w-[min(360px,92vw)] flex-col border-l border-line bg-paper shadow-pop transition-transform lg:w-[360px] lg:shadow-none print:hidden ${
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
              <X className="h-4 w-4" />
            ) : (
              <>
                <Spark className="h-4 w-4" /> Assistant
              </>
            )}
          </button>
        </>
      )}

      {/* Glisser-déposer : voile + invite pendant le survol d'un fichier. */}
      {dragOver && (
        <div className="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-ink/20 print:hidden">
          <div className="rounded-panel border-2 border-dashed border-coral bg-paper px-6 py-4 text-sm font-medium text-coral-ink shadow-pop">
            Déposez un fichier (md, txt, docx) pour l'importer
          </div>
        </div>
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
