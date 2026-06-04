import type { CSSProperties } from "react";
import type { Marks } from "../bindings";

// Rendu des marques, **partagé** entre l'affichage React (RunsView) et la
// surface éditable (qui sérialise les runs en HTML). Une seule source de vérité
// pour le mapping `Marks` → styles garantit que lecture et édition coïncident.

export const DEFAULT_MARKS: Marks = {
  bold: false,
  italic: false,
  underline: false,
  strike: false,
  code: false,
  link: null,
  color: null,
};

export function marksEqual(a: Marks, b: Marks): boolean {
  return (
    a.bold === b.bold &&
    a.italic === b.italic &&
    a.underline === b.underline &&
    a.strike === b.strike &&
    a.code === b.code &&
    a.link === b.link &&
    a.color === b.color
  );
}

/** Classes Tailwind structurelles (gras, italique, code). */
export function markClass(marks: Marks): string {
  return [
    marks.bold && "font-bold",
    marks.italic && "italic",
    marks.code &&
      "rounded bg-ink/[0.06] px-1 py-0.5 font-mono text-[0.9em] text-ink",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Décoration de texte + couleur, sous forme brute. Soulignement et barré
 * partagent `text-decoration-line` : on les combine pour qu'ils coexistent.
 */
export function markDecoration(marks: Marks): { textDecorationLine?: string; color?: string } {
  const lines: string[] = [];
  if (marks.underline) lines.push("underline");
  if (marks.strike) lines.push("line-through");

  const out: { textDecorationLine?: string; color?: string } = {};
  if (lines.length > 0) out.textDecorationLine = lines.join(" ");
  if (marks.color !== null) out.color = marks.color;
  return out;
}

/** Variante objet de style pour React (`undefined` si aucun style inline). */
export function markStyle(marks: Marks): CSSProperties | undefined {
  const d = markDecoration(marks);
  return d.textDecorationLine || d.color ? d : undefined;
}
