import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DocumentView } from "./render/DocumentView";
import { fixtureDoc } from "./render/fixture";

// Wave 3 — renderer. L'écran affiche un document fixture (toutes les variantes
// de blocs et de marques) via le pipeline de rendu `DocumentView`. Une barre
// supérieure discrète conserve le smoke-test `ping` du cœur Rust (Wave 0) : vert
// = chaîne webview → Tauri → plume-core OK ; gris = aperçu hors Tauri (Vite seul).

type Core = "checking" | "ok" | "offline";

function CoreStatus() {
  const [core, setCore] = useState<Core>("checking");

  useEffect(() => {
    invoke<string>("ping")
      .then(() => setCore("ok"))
      .catch(() => setCore("offline"));
  }, []);

  const dot = core === "ok" ? "bg-green-500" : core === "offline" ? "bg-neutral-300" : "bg-amber-400";
  const label = core === "ok" ? "cœur prêt" : core === "offline" ? "aperçu" : "…";

  return (
    <span className="flex items-center gap-2 text-xs text-neutral-500">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function App() {
  return (
    <div className="min-h-screen bg-neutral-100">
      <header className="sticky top-0 z-10 flex items-center justify-between border-b border-neutral-200 bg-white/80 px-6 py-3 backdrop-blur">
        <span className="text-sm font-semibold tracking-tight">Plume</span>
        <CoreStatus />
      </header>

      <main className="pb-16">
        <DocumentView doc={fixtureDoc} />
      </main>
    </div>
  );
}

export default App;
