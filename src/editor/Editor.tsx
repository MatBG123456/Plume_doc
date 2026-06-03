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

export function Editor() {
  const [doc, setDoc] = useState<Document | null>(null);
  const [editable, setEditable] = useState(false);
  const [syncSignal, setSyncSignal] = useState(0);
  const [pendingFocus, setPendingFocus] = useState<PendingFocus>(null);
  const [error, setError] = useState("");
  const [path, setPath] = useState<string | null>(null);
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);

  const queue = useRef<Promise<void>>(Promise.resolve());
  const saveChain = useRef<Promise<void>>(Promise.resolve());
  const rev = useRef(0); // révision d'édition, incrémentée à chaque modification
  // Miroirs pour les handlers impératifs (raccourcis, fermeture) sans closures périmées.
  const docRef = useRef<Document | null>(null);
  const pathRef = useRef<string | null>(null);
  const dirtyRef = useRef(false);
  const closing = useRef(false); // garde de ré-entrance du flush de fermeture

  useEffect(() => {
    docRef.current = doc;
    pathRef.current = path;
    dirtyRef.current = dirty;
  });

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

  // Raccourcis Ctrl/Cmd+S (enregistrer) et Ctrl/Cmd+O (ouvrir).
  useEffect(() => {
    if (!editable) return;
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const k = e.key.toLowerCase();
      if (k === "s") {
        e.preventDefault();
        saveCurrent();
      } else if (k === "o") {
        e.preventDefault();
        void openFile();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [editable, saveCurrent, openFile]);

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
          if (!dirtyRef.current) return; // rien à flusher → fermeture normale
          e.preventDefault();
          if (closing.current) return; // flush déjà en cours (anti ré-entrance)
          closing.current = true;
          try {
            if (pathRef.current) {
              await saveTo(pathRef.current, docRef.current ?? fixtureDoc);
              await win.destroy();
            } else {
              const keep = window.confirm(
                "Document non enregistré. Enregistrer avant de fermer ?\n\nOK = enregistrer · Annuler = fermer sans enregistrer.",
              );
              if (!keep) await win.destroy(); // fermer sans enregistrer
              else if (await saveAsFile()) await win.destroy(); // annulé → rester ouvert
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
  }, [editable, saveTo, saveAsFile]);

  const requestFocus = useCallback((id: string, offset: number) => {
    setPendingFocus({ id, offset });
  }, []);

  const clearFocus = useCallback(() => setPendingFocus(null), []);

  if (!doc) {
    return <div className="p-10 text-sm text-neutral-400">Chargement du document…</div>;
  }

  const api: EditorApi = {
    doc,
    editable,
    syncSignal,
    dispatch,
    pendingFocus,
    requestFocus,
    clearFocus,
  };

  const fileName = path ? path.split(/[\\/]/).pop() ?? path : "Brouillon";
  const status = saving ? "enregistrement…" : dirty ? "non enregistré" : path ? "enregistré" : "non enregistré";
  const dot = saving ? "bg-amber-400" : !path || dirty ? "bg-neutral-300" : "bg-green-500";

  return (
    <EditorContext.Provider value={api}>
      <div className="flex items-start">
        <div className="min-w-0 flex-1">
          {editable && (
            <div className="sticky top-[49px] z-10 bg-white/95 backdrop-blur print:hidden">
              <div className="flex items-center gap-1 border-b border-neutral-200 px-4 py-1.5">
                <FileButton onClick={() => void openFile()}>Ouvrir</FileButton>
                <FileButton onClick={saveCurrent}>Enregistrer</FileButton>
                <FileButton onClick={() => void saveAsFile()}>Enregistrer sous…</FileButton>
                <span className="mx-1 h-5 w-px bg-neutral-200" />
                <FileButton onClick={() => void exportMarkdown()}>↧ Markdown</FileButton>
                <FileButton onClick={() => void exportDocx()}>↧ Word</FileButton>
                <FileButton onClick={exportPdf}>↧ PDF</FileButton>
                <span className="ml-auto flex items-center gap-1.5 text-xs text-neutral-500">
                  <span className={`h-1.5 w-1.5 rounded-full ${dot}`} />
                  <span className="font-medium text-neutral-700">{fileName}</span>
                  <span>· {status}</span>
                </span>
              </div>
              <Toolbar />
            </div>
          )}
          <DocumentView doc={doc} />
        </div>
        {editable && (
          <aside className="sticky top-[49px] h-[calc(100vh-49px)] w-[340px] shrink-0 border-l border-neutral-200 bg-neutral-50 print:hidden">
            <ChatPanel />
          </aside>
        )}
      </div>
      {error && (
        <div className="fixed bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-md bg-red-600 px-4 py-2 text-sm text-white shadow-lg print:hidden">
          {error}
        </div>
      )}
    </EditorContext.Provider>
  );
}

function FileButton({ onClick, children }: { onClick: () => void; children: ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="rounded px-2 py-1 text-sm text-neutral-700 hover:bg-neutral-100"
    >
      {children}
    </button>
  );
}
