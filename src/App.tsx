import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { TabManager } from "./editor/TabManager";
import { Spark } from "./Spark";
import { Moon, Sun } from "./icons";

// Wave 4 — édition directe. L'app monte l'`Editor` : le document vit côté Rust
// (source de vérité) et chaque frappe, raccourci ou action de la barre d'outils
// passe par le pipeline d'opérations (`apply_op`). La barre supérieure conserve
// le smoke-test `ping` du cœur (Wave 0) et porte la bascule de thème.

type Theme = "light" | "dark";

/** Thème clair/sombre, persisté ; initialisé sur la préférence système. */
function useTheme(): [Theme, () => void] {
  const [theme, setTheme] = useState<Theme>(() => {
    const saved = localStorage.getItem("plume.theme");
    if (saved === "light" || saved === "dark") return saved;
    return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  });
  useEffect(() => {
    document.documentElement.setAttribute("data-theme", theme);
    localStorage.setItem("plume.theme", theme);
  }, [theme]);
  return [theme, () => setTheme((t) => (t === "dark" ? "light" : "dark"))];
}

type Core = "checking" | "ok" | "offline";

function CoreStatus() {
  const [core, setCore] = useState<Core>("checking");

  useEffect(() => {
    invoke<string>("ping")
      .then(() => setCore("ok"))
      .catch(() => setCore("offline"));
  }, []);

  const dot = core === "ok" ? "bg-teal" : core === "offline" ? "bg-faint" : "bg-coral";
  const label = core === "ok" ? "cœur prêt" : core === "offline" ? "aperçu" : "…";

  return (
    <span className="flex items-center gap-2 text-xs text-muted">
      <span className={`h-2 w-2 rounded-full ${dot}`} />
      <span className="hidden sm:inline">{label}</span>
    </span>
  );
}

function App() {
  const [theme, toggleTheme] = useTheme();

  return (
    <div className="min-h-screen bg-paper text-ink print:bg-white">
      <header className="sticky top-0 z-20 flex h-[49px] items-center justify-between border-b border-line bg-paper/80 px-4 backdrop-blur sm:px-6 print:hidden">
        <span className="flex items-center gap-1.5">
          <Spark className="h-4 w-4 text-coral" />
          <span className="font-serif text-base font-medium tracking-tight text-ink">Plume</span>
        </span>
        <div className="flex items-center gap-3">
          <CoreStatus />
          <button
            type="button"
            onClick={toggleTheme}
            title={theme === "dark" ? "Thème clair" : "Thème sombre"}
            className="flex h-7 w-7 items-center justify-center rounded-pill text-muted hover:bg-coral-soft hover:text-coral-ink"
          >
            {theme === "dark" ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
          </button>
        </div>
      </header>

      <main className="pb-16">
        <TabManager />
      </main>
    </div>
  );
}

export default App;
