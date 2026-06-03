import type { ReactNode } from "react";
import { useEditor } from "./EditorContext";
import {
  setBlockType,
  setColor,
  setLink,
  toggleBoolMark,
  type BlockKind,
  type BoolMark,
} from "./actions";

// Barre d'outils d'édition. Règle d'or : chaque contrôle utilise
// `onMouseDown` + `preventDefault` pour NE PAS voler le focus de l'éditable —
// sinon la sélection s'effondrerait avant l'action. Toutes les actions passent
// par le pipeline d'ops (ApplyMark / SetNode).

function Tool({
  title,
  onAction,
  children,
}: {
  title: string;
  onAction: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => {
        e.preventDefault();
        onAction();
      }}
      className="flex h-8 min-w-8 items-center justify-center rounded px-2 text-sm text-neutral-700 hover:bg-neutral-200"
    >
      {children}
    </button>
  );
}

function Separator() {
  return <span className="mx-1 h-5 w-px bg-neutral-200" />;
}

const BLOCK_KINDS: { kind: BlockKind; label: string; title: string }[] = [
  { kind: "paragraph", label: "¶", title: "Paragraphe" },
  { kind: "h1", label: "H1", title: "Titre 1" },
  { kind: "h2", label: "H2", title: "Titre 2" },
  { kind: "h3", label: "H3", title: "Titre 3" },
  { kind: "quote", label: "❝", title: "Citation" },
  { kind: "bullet", label: "•", title: "Liste à puces" },
  { kind: "number", label: "1.", title: "Liste numérotée" },
];

const MARKS: { mark: BoolMark; label: string; title: string; className: string }[] = [
  { mark: "bold", label: "B", title: "Gras (Ctrl/Cmd+B)", className: "font-bold" },
  { mark: "italic", label: "I", title: "Italique (Ctrl/Cmd+I)", className: "italic" },
  { mark: "underline", label: "U", title: "Souligné (Ctrl/Cmd+U)", className: "underline" },
  { mark: "strike", label: "S", title: "Barré", className: "line-through" },
  { mark: "code", label: "</>", title: "Code", className: "font-mono text-xs" },
];

const COLORS = ["#111827", "#DC2626", "#2563EB", "#16A34A", "#D97706"];

export function Toolbar() {
  const editor = useEditor();
  if (!editor) return null;

  return (
    <div className="sticky top-[49px] z-10 flex flex-wrap items-center gap-0.5 border-b border-neutral-200 bg-white/90 px-4 py-1.5 backdrop-blur">
      {BLOCK_KINDS.map((b) => (
        <Tool key={b.kind} title={b.title} onAction={() => setBlockType(editor, b.kind)}>
          {b.label}
        </Tool>
      ))}

      <Separator />

      {MARKS.map((m) => (
        <Tool key={m.mark} title={m.title} onAction={() => toggleBoolMark(editor, m.mark)}>
          <span className={m.className}>{m.label}</span>
        </Tool>
      ))}

      <Separator />

      <Tool title="Lien" onAction={() => setLink(editor)}>
        🔗
      </Tool>

      <Separator />

      {COLORS.map((c) => (
        <button
          key={c}
          type="button"
          title={`Couleur ${c}`}
          onMouseDown={(e) => {
            e.preventDefault();
            setColor(editor, c);
          }}
          className="h-5 w-5 rounded-full ring-1 ring-neutral-300"
          style={{ backgroundColor: c }}
        />
      ))}
      <Tool title="Retirer la couleur" onAction={() => setColor(editor, null)}>
        <span className="text-xs text-neutral-500">✕</span>
      </Tool>
    </div>
  );
}
