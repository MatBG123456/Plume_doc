import type { ReactNode } from "react";
import type { Run } from "../bindings";
import { markClass, markStyle } from "./marks";

// Rendu inline (lecture seule) d'une suite de `Run` : texte + marks. C'est
// l'atome partagé par tous les blocs porteurs de texte. La surface éditable
// (Wave 4) réutilise le **même** mapping de marques (`./marks`).

/** Un segment de texte stylé, éventuellement enveloppé dans un lien. */
function RunView({ run }: { run: Run }): ReactNode {
  const { marks } = run;
  const span = (
    <span className={markClass(marks)} style={markStyle(marks)}>
      {run.text}
    </span>
  );

  if (marks.link !== null) {
    // Pas de décoration figée : le soulignement suit `marks.underline` et la
    // couleur `marks.color` (via le span). Bleu seulement si aucune couleur.
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
