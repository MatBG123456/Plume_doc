import type { Run } from "../bindings";
import { markClass, markDecoration } from "../render/marks";

// Sérialise des runs en HTML pour la surface éditable (rempli via innerHTML).
// On réutilise le mapping de marques de l'affichage pour que le texte édité ait
// exactement le même rendu qu'en lecture seule. Dans l'éditable, un lien est un
// `<span>` (pas un `<a>`) pour rester éditable sans navigation parasite.

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function styleAttr(run: Run): string {
  const d = markDecoration(run.marks);
  const parts: string[] = [];
  if (d.textDecorationLine) parts.push(`text-decoration-line:${d.textDecorationLine}`);
  if (d.color) parts.push(`color:${d.color}`);
  return parts.length > 0 ? ` style="${parts.join(";")}"` : "";
}

function classAttr(run: Run): string {
  const classes = [markClass(run.marks)];
  // Affordance lien : bleu par défaut quand aucune couleur n'est fixée.
  if (run.marks.link !== null && run.marks.color === null) classes.push("text-blue-600");
  const cn = classes.filter(Boolean).join(" ");
  return cn ? ` class="${cn}"` : "";
}

/** Rend une suite de runs en HTML. Un bloc vide rend un `<br>` éditable. */
export function runsToHtml(runs: Run[]): string {
  if (runs.length === 0) return "<br>";
  return runs
    .map((run) => {
      const link = run.marks.link !== null ? ` data-link="${escapeHtml(run.marks.link)}"` : "";
      return `<span${classAttr(run)}${styleAttr(run)}${link}>${escapeHtml(run.text)}</span>`;
    })
    .join("");
}
