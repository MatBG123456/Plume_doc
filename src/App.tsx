import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { Editor } from "./editor/Editor";

// Wave 4 — édition directe. L'app monte l'`Editor` : le document vit côté Rust
// (source de vérité) et chaque frappe, raccourci ou action de la barre d'outils
// passe par le pipeline d'opérations (`apply_op`). La barre supérieure conserve
// le smoke-test `ping` du cœur (Wave 0).

type Core = "checking" | "ok" | "offline";

function CoreStatus() {
  const [core, setCore] = useState<Core>("checking");

  useEffect(() => {
    invoke<string>("ping")
      .then(() => setCore("ok"))
      .catch(() => setCore("offline"));
  }, []);

  const dot = core === "ok" ? "bg-teal" : core === "offline" ? "bg-faint/60" : "bg-coral";
  const label = core === "ok" ? "cœur prêt" : core === "offline" ? "aperçu" : "…";

  return (
    <span className="flex items-center gap-2 text-xs text-muted">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      {label}
    </span>
  );
}

function App() {
  return (
    <div className="min-h-screen bg-paper text-ink print:bg-white">
      <header className="sticky top-0 z-20 flex h-[49px] items-center justify-between border-b border-line bg-paper/80 px-6 backdrop-blur print:hidden">
        <span className="flex items-center gap-1.5">
          <span className="text-coral">✳</span>
          <span className="font-serif text-base font-medium tracking-tight text-ink">Plume</span>
        </span>
        <CoreStatus />
      </header>

      <main className="pb-16">
        <Editor />
      </main>
    </div>
  );
}

export default App;
