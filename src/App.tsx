import { useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Document } from "./bindings";

// Document vide, typé par le modèle Rust généré (ts-rs). Prouve que le front
// consomme bien la source de vérité de `plume-core`.
const EMPTY_DOC: Document = { meta: { title: "", lang: "fr" }, blocks: [] };

/**
 * Wave 0 — écran de vérification end-to-end.
 *
 * Le bouton invoque la command Tauri `ping`, qui délègue à `plume-core::ping`.
 * Voir la réponse « pong from plume-core » prouve que la chaîne
 * webview → Tauri → cœur Rust est branchée.
 */
function App() {
  const [reply, setReply] = useState<string>("");
  const [error, setError] = useState<string>("");

  async function handlePing() {
    setError("");
    try {
      setReply(await invoke<string>("ping"));
    } catch (e) {
      setError(String(e));
    }
  }

  return (
    <main className="min-h-screen flex flex-col items-center justify-center gap-6 p-8 text-center">
      <h1 className="text-3xl font-semibold tracking-tight">Plume</h1>
      <p className="text-sm text-neutral-500 max-w-md">
        Éditeur de documents riches AI-native. Wave 1 : modèle de document typé,
        partagé entre Rust (source de vérité) et TypeScript (ts-rs).
      </p>

      <p className="text-xs text-neutral-400">
        Document courant : « {EMPTY_DOC.meta.title || "sans titre" } » —{" "}
        {EMPTY_DOC.blocks.length} bloc(s)
      </p>

      <button
        onClick={handlePing}
        className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-medium text-white hover:bg-neutral-700"
      >
        Ping le cœur Rust
      </button>

      {reply && (
        <p className="font-mono text-sm text-green-600">{reply}</p>
      )}
      {error && (
        <p className="font-mono text-sm text-red-600">{error}</p>
      )}
    </main>
  );
}

export default App;
