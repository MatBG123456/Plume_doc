import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Document, Op } from "../bindings";
import { DocumentView } from "../render/DocumentView";
import { fixtureDoc } from "../render/fixture";
import { EditorContext, type DispatchOpts, type EditorApi, type PendingFocus } from "./EditorContext";
import { Toolbar } from "./Toolbar";

// Racine de l'éditeur. Le document vit côté Rust (source de vérité) : on le
// charge au montage, et chaque édition est une `Op` envoyée à `apply_op`. Les
// dispatches sont mis en **file séquentielle** pour que les ops s'appliquent
// dans l'ordre et que l'état React reflète le dernier résultat. Hors Tauri
// (Vite seul), on retombe sur la fixture en lecture seule.

export function Editor() {
  const [doc, setDoc] = useState<Document | null>(null);
  const [editable, setEditable] = useState(false);
  const [syncSignal, setSyncSignal] = useState(0);
  const [pendingFocus, setPendingFocus] = useState<PendingFocus>(null);
  const [error, setError] = useState("");
  const queue = useRef<Promise<void>>(Promise.resolve());

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

  const dispatch = useCallback((op: Op, opts?: DispatchOpts) => {
    queue.current = queue.current.then(async () => {
      try {
        const next = await invoke<Document>("apply_op", { op });
        setDoc(next);
        setError("");
        if (opts?.sync) setSyncSignal((n) => n + 1);
      } catch (e) {
        setError(String(e));
        setPendingFocus(null); // pas de focus fantôme si l'op a échoué
      }
    });
  }, []);

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

  return (
    <EditorContext.Provider value={api}>
      {editable && <Toolbar />}
      <DocumentView doc={doc} />
      {error && (
        <div className="fixed bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-md bg-red-600 px-4 py-2 text-sm text-white shadow-lg">
          Opération refusée : {error}
        </div>
      )}
    </EditorContext.Provider>
  );
}
