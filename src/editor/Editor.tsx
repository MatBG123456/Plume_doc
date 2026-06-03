import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Document, Op } from "../bindings";
import { DocumentView } from "../render/DocumentView";
import { fixtureDoc } from "../render/fixture";
import { EditorContext, type DispatchOpts, type EditorApi, type PendingFocus } from "./EditorContext";
import { Toolbar } from "./Toolbar";
import { ChatPanel } from "./ChatPanel";

// Racine de l'éditeur. Le document vit côté Rust (source de vérité) : on le
// charge au montage, et chaque édition est une `Op` envoyée à `apply_op`. Les
// dispatches sont mis en **file séquentielle** pour que les ops s'appliquent
// dans l'ordre et que l'état React reflète le dernier résultat. Hors Tauri
// (Vite seul), on retombe sur la fixture en lecture seule.
//
// Wave 5 : la boucle agent (`chat_send`) mute le **même** document côté Rust et
// émet des events `op_applied` (preview live) ; on s'y abonne pour resynchroniser
// le rendu au fil du stream.

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

  // Preview live : la boucle agent émet `op_applied` (nouveau doc) à chaque op,
  // et `chat_error` en cas d'échec. On met à jour `doc` (les blocs NON focalisés
  // se rafraîchissent via l'effet (a) de EditableText). On NE bump PAS syncSignal :
  // cela forcerait l'effet (b) à réécrire le bloc focalisé et écraserait une
  // frappe en cours non encore round-trippée.
  useEffect(() => {
    if (!editable) return;
    const subs = [
      listen<{ doc: Document }>("op_applied", (e) => setDoc(e.payload.doc)),
      listen<{ message: string }>("chat_error", (e) => setError(e.payload.message)),
    ];
    return () => {
      subs.forEach((p) => void p.then((un) => un()));
    };
  }, [editable]);

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
      <div className="flex items-start">
        <div className="min-w-0 flex-1">
          {editable && <Toolbar />}
          <DocumentView doc={doc} />
        </div>
        {editable && (
          <aside className="sticky top-[49px] h-[calc(100vh-49px)] w-[340px] shrink-0 border-l border-neutral-200 bg-neutral-50">
            <ChatPanel />
          </aside>
        )}
      </div>
      {error && (
        <div className="fixed bottom-4 left-1/2 z-20 -translate-x-1/2 rounded-md bg-red-600 px-4 py-2 text-sm text-white shadow-lg">
          {error}
        </div>
      )}
    </EditorContext.Provider>
  );
}
