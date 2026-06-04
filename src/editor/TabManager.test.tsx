import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// État partagé, hoisté pour être accessible dans les factories de mock.
const h = vi.hoisted(() => ({
  rustDoc: { current: null as unknown },
  calls: [] as string[],
}));

// `invoke` mocké : simule le document Rust (get_document = dernier set_document)
// et journalise l'ordre des appels pour vérifier flush→set_document.
vi.mock("@tauri-apps/api/core", () => ({
  invoke: vi.fn(async (cmd: string, args?: { doc?: { meta?: { title?: string } } }) => {
    if (cmd === "get_document") return h.rustDoc.current;
    if (cmd === "set_document") {
      h.rustDoc.current = args?.doc;
      h.calls.push(`set:${args?.doc?.meta?.title || "blank"}`);
    }
    return undefined;
  }),
}));

vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onCloseRequested: async () => () => {},
    destroy: async () => {},
  }),
}));

// Editor stubé : participe au protocole (get_document → onState + flushRef).
vi.mock("./Editor", async () => {
  const React = await import("react");
  const { invoke } = await import("@tauri-apps/api/core");
  const Editor = ({
    onState,
    flushRef,
  }: {
    onState?: (s: { doc: unknown; path: string | null; dirty: boolean }) => void;
    flushRef?: { current: (() => Promise<unknown>) | null };
  }) => {
    React.useEffect(() => {
      let mounted = true;
      void invoke("get_document").then((doc) => {
        if (!mounted) return;
        if (flushRef) {
          flushRef.current = async () => {
            h.calls.push("flush");
            return doc;
          };
        }
        onState?.({ doc, path: null, dirty: false });
      });
      return () => {
        mounted = false;
      };
    }, [onState, flushRef]);
    return React.createElement("div", { "data-testid": "editor" });
  };
  return { Editor };
});

import { TabManager } from "./TabManager";

const STARTER = {
  meta: { title: "STARTER", lang: "fr" },
  blocks: [{ id: "b1", node: { type: "Paragraph", runs: [] } }],
};

beforeEach(() => {
  h.rustDoc.current = STARTER;
  h.calls.length = 0;
  localStorage.clear();
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("TabManager", () => {
  it("nouvel onglet : flush AVANT set_document, puis restauration au retour", async () => {
    render(<TabManager />);
    await screen.findByText("STARTER"); // l'onglet initial a capturé STARTER

    fireEvent.click(screen.getByTitle("Nouvel onglet"));
    await waitFor(() => expect(h.calls).toContain("set:blank"));
    // Le flush de l'onglet sortant précède le set_document du nouvel onglet.
    expect(h.calls.indexOf("flush")).toBeGreaterThanOrEqual(0);
    expect(h.calls.indexOf("flush")).toBeLessThan(h.calls.indexOf("set:blank"));
    await screen.findByText("Sans titre");

    // Retour sur STARTER → set_document(STARTER) (snapshot restauré), flush avant.
    h.calls.length = 0;
    fireEvent.click(screen.getByText("STARTER"));
    await waitFor(() => expect(h.calls).toContain("set:STARTER"));
    expect(h.calls.indexOf("flush")).toBeLessThan(h.calls.indexOf("set:STARTER"));
  });

  it("ferme l'onglet actif → bascule sur le voisin via set_document", async () => {
    render(<TabManager />);
    await screen.findByText("STARTER");
    fireEvent.click(screen.getByTitle("Nouvel onglet"));
    await screen.findByText("Sans titre");

    h.calls.length = 0;
    // Ferme l'onglet actif (le vierge, 2e) → revient à STARTER.
    fireEvent.click(screen.getAllByTitle("Fermer l'onglet")[1]);
    await waitFor(() => expect(h.calls).toContain("set:STARTER"));
  });
});
