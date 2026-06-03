import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

// Panneau de chat (Wave 5). Envoie l'historique à la command Rust `chat_send`,
// qui exécute la boucle agent (streaming + application des ops via le pipeline).
// Le texte de l'assistant arrive via l'event `assistant_text` (preview live) ;
// chaque op appliquée (`op_applied`) marque une frontière de tour, ce qui fige
// le texte streamé courant. L'historique complet (format Anthropic) est renvoyé
// à la fin de l'échange. Les erreurs sont affichées par le toast global (Editor,
// via l'event `chat_error`).

type Block = { type: string; text?: string; name?: string };
type ChatMessage = { role: string; content: Block[] | unknown };

type Display = { role: "user" | "assistant"; text: string; tools: string[] };

/** Extrait un affichage lisible d'un message brut (ignore les tool_results). */
function toDisplay(m: ChatMessage): Display | null {
  const blocks = Array.isArray(m.content) ? (m.content as Block[]) : [];
  const text = blocks
    .filter((b) => b.type === "text")
    .map((b) => b.text ?? "")
    .join("");
  if (m.role === "user") {
    if (text.trim() === "") return null; // message de tool_results : non affiché
    return { role: "user", text, tools: [] };
  }
  const tools = blocks.filter((b) => b.type === "tool_use").map((b) => b.name ?? "op");
  return { role: "assistant", text, tools };
}

function Bubble({ d }: { d: Display }) {
  const mine = d.role === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-lg px-3 py-2 text-sm ${
          mine ? "bg-neutral-900 text-white" : "bg-white text-neutral-800 ring-1 ring-neutral-200"
        }`}
      >
        {d.text && <p className="whitespace-pre-wrap">{d.text}</p>}
        {d.tools.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {d.tools.map((t, i) => (
              <span
                key={i}
                className="rounded bg-neutral-100 px-1.5 py-0.5 font-mono text-[11px] text-neutral-600"
              >
                ⚙ {t}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export function ChatPanel() {
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState("");
  const [streaming, setStreaming] = useState("");
  const [liveTurns, setLiveTurns] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const streamingRef = useRef("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  function resetLive() {
    streamingRef.current = "";
    setStreaming("");
    setLiveTurns([]);
  }

  useEffect(() => {
    const subs = [
      // Texte de l'assistant au fil du stream.
      listen<{ text: string }>("assistant_text", (e) => {
        streamingRef.current += e.payload.text;
        setStreaming(streamingRef.current);
      }),
      // Frontière de tour : une op vient d'être appliquée → fige le texte courant.
      listen("op_applied", () => {
        if (streamingRef.current.trim() !== "") {
          setLiveTurns((t) => [...t, streamingRef.current]);
          streamingRef.current = "";
          setStreaming("");
        }
      }),
    ];
    return () => {
      subs.forEach((p) => void p.then((un) => un()));
    };
  }, []);

  // Auto-scroll en bas à chaque mise à jour.
  useEffect(() => {
    scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight });
  }, [messages, streaming, liveTurns, busy]);

  async function send() {
    const text = input.trim();
    if (text === "" || busy) return;
    const userMsg: ChatMessage = { role: "user", content: [{ type: "text", text }] };
    const next = [...messages, userMsg];
    setMessages(next);
    setInput("");
    resetLive();
    setBusy(true);
    try {
      const updated = await invoke<ChatMessage[]>("chat_send", { messages: next });
      setMessages(updated);
    } catch {
      // L'erreur est déjà signalée par l'event `chat_error` (toast global).
    } finally {
      setBusy(false);
      resetLive();
    }
  }

  const displays = messages.map(toDisplay).filter((d): d is Display => d !== null);

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-200 px-4 py-2.5 text-sm font-semibold tracking-tight">
        Assistant
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {displays.length === 0 && !busy && (
          <p className="text-xs leading-relaxed text-neutral-400">
            Demandez une modification du document, par ex. «&nbsp;mets le titre en gras et ajoute un
            paragraphe d'introduction&nbsp;». L'assistant édite via des opérations validées.
          </p>
        )}

        {displays.map((d, i) => (
          <Bubble key={i} d={d} />
        ))}

        {busy &&
          liveTurns.map((t, i) => (
            <Bubble key={`live-${i}`} d={{ role: "assistant", text: t, tools: [] }} />
          ))}

        {busy && (
          <Bubble d={{ role: "assistant", text: streaming || "…", tools: [] }} />
        )}
      </div>

      <div className="border-t border-neutral-200 p-3">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void send();
            }
          }}
          rows={3}
          placeholder="Demander une modification…"
          disabled={busy}
          className="w-full resize-none rounded-md border border-neutral-300 px-3 py-2 text-sm outline-none focus:border-neutral-500 disabled:bg-neutral-50"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-neutral-400">Entrée pour envoyer · Maj+Entrée saut de ligne</span>
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || input.trim() === ""}
            className="rounded-md bg-neutral-900 px-3 py-1.5 text-sm font-medium text-white hover:bg-neutral-700 disabled:opacity-40"
          >
            {busy ? "…" : "Envoyer"}
          </button>
        </div>
      </div>
    </div>
  );
}
