import { useEffect, useMemo, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { Node as DocNode } from "../bindings";
import { useEditor } from "./EditorContext";
import { Spark } from "../Spark";

/** Texte court d'un bloc (pour l'aperçu du focus). */
function blockText(node: DocNode): string {
  switch (node.type) {
    case "Paragraph":
    case "Heading":
    case "ListItem":
    case "Quote":
      return node.runs.map((r) => r.text).join("");
    case "CodeBlock":
      return node.text;
    case "Table":
      return "[tableau]";
    case "Image":
      return `[image : ${node.alt}]`;
    case "PageBreak":
      return "[saut de page]";
  }
}

// Panneau de chat. Le provider est **toujours** « Claude Code (CLI local) » : on
// délègue au binaire `claude` que l'utilisateur a installé/authentifié (son
// abonnement ou sa clé). On expose le choix du **modèle** et de l'**effort**.
// Le texte de l'assistant arrive via l'event `assistant_text` ; `op_applied`
// marque une frontière de tour. Erreurs → toast global (event `chat_error`).

type Block = { type: string; text?: string; name?: string };
type ChatMessage = { role: string; content: Block[] | unknown };
type Display = { role: "user" | "assistant"; text: string; tools: string[] };

const MODELS = [
  { value: "sonnet", label: "Sonnet" },
  { value: "opus", label: "Opus" },
  { value: "haiku", label: "Haiku" },
];
const EFFORTS = [
  { value: "low", label: "low" },
  { value: "medium", label: "medium" },
  { value: "high", label: "high" },
  { value: "xhigh", label: "xhigh" },
  { value: "max", label: "max" },
];

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
  if (text.trim() === "" && tools.length === 0) return null; // pas de bulle vide
  return { role: "assistant", text, tools };
}

function Bubble({ d }: { d: Display }) {
  const mine = d.role === "user";
  return (
    <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
      <div
        className={`max-w-[85%] rounded-row px-3 py-2 text-sm ${
          mine ? "bg-coral text-white" : "bg-card text-ink ring-1 ring-line"
        }`}
      >
        {d.text && <p className="whitespace-pre-wrap">{d.text}</p>}
        {d.tools.length > 0 && (
          <div className="mt-1.5 flex flex-wrap gap-1">
            {d.tools.map((t, i) => (
              <span
                key={i}
                className="rounded bg-coral-soft px-1.5 py-0.5 font-mono text-[11px] text-coral-ink"
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

/** Indicateur d'attente : la mascotte tourne + trois points qui rebondissent. */
function ThinkingBubble() {
  return (
    <div className="flex justify-start">
      <div className="flex items-center gap-2 rounded-row bg-card px-3 py-2 text-sm text-muted ring-1 ring-line">
        <Spark className="h-4 w-4 text-coral" spinning />
        <span>Réflexion</span>
        <span className="inline-flex gap-0.5">
          <span className="h-1 w-1 animate-bounce rounded-full bg-faint [animation-delay:-0.3s]" />
          <span className="h-1 w-1 animate-bounce rounded-full bg-faint [animation-delay:-0.15s]" />
          <span className="h-1 w-1 animate-bounce rounded-full bg-faint" />
        </span>
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
  const [cliAvailable, setCliAvailable] = useState(true);
  const [model, setModel] = useState(() => localStorage.getItem("plume.model") ?? "sonnet");
  const [effort, setEffort] = useState(() => localStorage.getItem("plume.effort") ?? "high");
  const streamingRef = useRef("");
  const scrollRef = useRef<HTMLDivElement | null>(null);

  const editor = useEditor();
  const focusId = editor?.focusId ?? null;
  const doc = editor?.doc;
  const focusPreview = useMemo(() => {
    if (!focusId || !doc) return null;
    const b = doc.blocks.find((x) => x.id === focusId);
    return b ? blockText(b.node) : null;
  }, [focusId, doc]);

  function resetLive() {
    streamingRef.current = "";
    setStreaming("");
    setLiveTurns([]);
  }

  function chooseModel(m: string) {
    setModel(m);
    localStorage.setItem("plume.model", m);
  }
  function chooseEffort(e: string) {
    setEffort(e);
    localStorage.setItem("plume.effort", e);
  }

  // Détecte si le binaire `claude` est présent (sinon on prévient).
  useEffect(() => {
    invoke<{ api_key: boolean; claude_cli: boolean }>("detect_chat_providers")
      .then((p) => setCliAvailable(p.claude_cli))
      .catch(() => {});
  }, []);

  useEffect(() => {
    const subs = [
      listen<{ text: string }>("assistant_text", (e) => {
        streamingRef.current += e.payload.text;
        setStreaming(streamingRef.current);
      }),
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
      const updated = await invoke<ChatMessage[]>("chat_send", {
        messages: next,
        provider: "cli",
        model,
        effort,
        focus: focusId,
      });
      setMessages(updated);
    } catch {
      // L'erreur est déjà signalée par l'event `chat_error` (toast global).
    } finally {
      setBusy(false);
      resetLive();
    }
  }

  const displays = messages.map(toDisplay).filter((d): d is Display => d !== null);
  const selectCls =
    "rounded-md border border-line bg-card px-1.5 py-1 font-mono text-xs text-muted outline-none focus:border-coral";

  return (
    <div className="flex h-full flex-col font-sans">
      <div className="border-b border-line px-4 py-2.5">
        <div className="flex items-center justify-between gap-2">
          <span className="font-serif text-sm font-medium text-ink">Assistant</span>
          <div className="flex items-center gap-1.5">
            <select value={model} onChange={(e) => chooseModel(e.target.value)} className={selectCls} title="Modèle">
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>
                  {m.label}
                </option>
              ))}
            </select>
            <select value={effort} onChange={(e) => chooseEffort(e.target.value)} className={selectCls} title="Effort">
              {EFFORTS.map((e) => (
                <option key={e.value} value={e.value}>
                  {e.label}
                </option>
              ))}
            </select>
          </div>
        </div>
        <p className="mt-1 text-[11px] text-faint">
          {cliAvailable
            ? "Via ton « claude » local (ton abonnement/auth) — vérifie les CGU pour ton usage."
            : "⚠ « claude » introuvable : installe Claude Code et relance."}
        </p>
      </div>

      <div ref={scrollRef} className="flex-1 space-y-3 overflow-y-auto p-4">
        {displays.length === 0 && !busy && (
          <p className="text-xs leading-relaxed text-faint">
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

        {busy &&
          (streaming.trim() !== "" ? (
            <Bubble d={{ role: "assistant", text: streaming, tools: [] }} />
          ) : (
            <ThinkingBubble />
          ))}
      </div>

      <div className="border-t border-line p-3">
        {focusId && (
          <div className="mb-2 flex items-center gap-1.5 rounded-row bg-coral-soft px-2 py-1 text-xs text-coral-ink">
            <span aria-hidden="true">🎯</span>
            <span className="truncate">
              Focus : {focusPreview?.slice(0, 60) || "(bloc ciblé)"}
            </span>
            <button
              type="button"
              onClick={() => editor?.setFocus(null)}
              title="Retirer le focus"
              className="ml-auto rounded px-1 hover:bg-coral/20"
            >
              ✕
            </button>
          </div>
        )}
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
          className="w-full resize-none rounded-row border border-line bg-card px-3 py-2 text-sm text-ink outline-none placeholder:text-faint focus:border-coral disabled:opacity-60"
        />
        <div className="mt-2 flex items-center justify-between">
          <span className="text-[11px] text-faint">Entrée pour envoyer · Maj+Entrée saut de ligne</span>
          <button
            type="button"
            onClick={() => void send()}
            disabled={busy || input.trim() === ""}
            className="rounded-pill bg-coral px-3.5 py-1.5 text-sm font-medium text-white transition hover:brightness-105 disabled:opacity-40"
          >
            {busy ? "…" : "Envoyer"}
          </button>
        </div>
      </div>
    </div>
  );
}
