import { createContext, useContext } from "react";
import type { Document, Op } from "../bindings";

// Contexte d'édition. Fourni par `Editor`, consommé par les composants de rendu
// (qui basculent en éditable) et par la barre d'outils. Absent ⇒ rendu en
// lecture seule (le renderer Wave 3 reste utilisable sans éditeur).

export type PendingFocus = { id: string; offset: number } | null;

export type DispatchOpts = {
  /** Force la resynchronisation DOM ← modèle des blocs après l'op (toolbar,
   *  changements structurels). À NE PAS activer pour la frappe (caret natif). */
  sync?: boolean;
};

export type EditorApi = {
  doc: Document;
  editable: boolean;
  /** Incrémenté pour forcer les éditables à se resynchroniser sur le modèle. */
  syncSignal: number;
  /** Applique une op via le pipeline Rust (`apply_op`), en file séquentielle. */
  dispatch: (op: Op, opts?: DispatchOpts) => void;
  pendingFocus: PendingFocus;
  /** Demande que le bloc `id` prenne le focus au caret `offset` après rendu. */
  requestFocus: (id: string, offset: number) => void;
  clearFocus: () => void;
  /** Bloc épinglé comme contexte PRIORITAIRE pour l'assistant (ou null). */
  focusId: string | null;
  setFocus: (id: string | null) => void;
};

export const EditorContext = createContext<EditorApi | null>(null);

/** Accès optionnel : `null` hors éditeur (mode lecture seule). */
export function useEditor(): EditorApi | null {
  return useContext(EditorContext);
}
