import type { CSSProperties, ReactNode } from "react";
import type { Marks, Run } from "../bindings";

// Rendu inline d'une suite de `Run` : texte + marks. C'est l'atome partagé par
// tous les blocs porteurs de texte (paragraphes, titres, items de liste,
// citations, cellules de table). Le modèle Rust (`plume-core`) est la source de
// vérité ; on mappe ici **chaque** champ de `Marks` vers un rendu fidèle.

/** Classes Tailwind dérivées des marques structurelles (gras, italique, code). */
function markClass(marks: Marks): string {
  return [
    marks.bold && "font-bold",
    marks.italic && "italic",
    marks.code &&
      "rounded bg-neutral-100 px-1 py-0.5 font-mono text-[0.9em] text-neutral-800",
  ]
    .filter(Boolean)
    .join(" ");
}

/**
 * Style inline pour les marques qui ne s'expriment pas proprement en classes :
 * - soulignement et barré partagent `text-decoration-line` et doivent donc être
 *   combinés à la main pour pouvoir coexister ;
 * - la couleur est une valeur libre `#RRGGBB`.
 */
function markStyle(marks: Marks): CSSProperties | undefined {
  const lines: string[] = [];
  if (marks.underline) lines.push("underline");
  if (marks.strike) lines.push("line-through");

  const style: CSSProperties = {};
  if (lines.length > 0) style.textDecorationLine = lines.join(" ");
  if (marks.color !== null) style.color = marks.color;

  return Object.keys(style).length > 0 ? style : undefined;
}

/** Un segment de texte stylé, éventuellement enveloppé dans un lien. */
function RunView({ run }: { run: Run }): ReactNode {
  const { marks } = run;
  const span = (
    <span className={markClass(marks)} style={markStyle(marks)}>
      {run.text}
    </span>
  );

  if (marks.link !== null) {
    // Aucune décoration ni couleur figée : le soulignement reste piloté par
    // `marks.underline` et la couleur par `marks.color` (via le span interne).
    // Le bleu n'est qu'un repère visuel *par défaut*, appliqué uniquement quand
    // le modèle ne fixe pas de couleur (`color === null`).
    const linkClass =
      marks.color === null
        ? "text-blue-600 underline-offset-2 hover:text-blue-700"
        : "underline-offset-2 hover:opacity-80";
    return (
      <a href={marks.link} target="_blank" rel="noreferrer" className={linkClass}>
        {span}
      </a>
    );
  }
  return span;
}

/** Rend une suite de runs. Un bloc sans run rend une ligne vide visible. */
export function RunsView({ runs }: { runs: Run[] }): ReactNode {
  if (runs.length === 0) return <br />;
  return (
    <>
      {runs.map((run, i) => (
        <RunView key={i} run={run} />
      ))}
    </>
  );
}
