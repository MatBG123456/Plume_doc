import type { Marks, Run } from "../bindings";
import { DEFAULT_MARKS, marksEqual } from "../render/marks";

// Logique d'édition **pure** (sans DOM) : conversion runs ⇄ caractères stylés,
// réconciliation du texte saisi avec le modèle, et découpe pour Entrée. Isolée
// ici pour être raisonnée et revue indépendamment de la glue contentEditable.

export type StyledChar = { ch: string; marks: Marks };

/** Aplati des runs en caractères (code points), chacun portant ses marques. */
export function runsToChars(runs: Run[]): StyledChar[] {
  const out: StyledChar[] = [];
  for (const run of runs) {
    for (const ch of Array.from(run.text)) out.push({ ch, marks: run.marks });
  }
  return out;
}

/** Recoalesce des caractères stylés en runs (fusionne les marques égales). */
export function charsToRuns(chars: StyledChar[]): Run[] {
  const out: Run[] = [];
  for (const sc of chars) {
    const last = out[out.length - 1];
    if (last && marksEqual(last.marks, sc.marks)) last.text += sc.ch;
    else out.push({ text: sc.ch, marks: sc.marks });
  }
  return out;
}

export function charsText(chars: StyledChar[]): string {
  return chars.map((c) => c.ch).join("");
}

/**
 * Réconcilie le texte issu du DOM avec les caractères du modèle, via un diff
 * **préfixe/suffixe commun** (robuste pour les éditions au caret : insertion,
 * suppression, remplacement de sélection, collage). Les caractères insérés
 * héritent des marques de leur voisin de gauche (ou de droite en tête de bloc).
 *
 * Renvoie les nouveaux caractères et l'offset de caret attendu (fin de
 * l'insertion), exprimé en code points.
 */
export function reconcile(
  oldChars: StyledChar[],
  newText: string,
): { chars: StyledChar[]; caret: number } {
  const next = Array.from(newText);
  const oldLen = oldChars.length;
  const newLen = next.length;

  let p = 0;
  while (p < oldLen && p < newLen && oldChars[p].ch === next[p]) p += 1;

  let s = 0;
  while (
    s < oldLen - p &&
    s < newLen - p &&
    oldChars[oldLen - 1 - s].ch === next[newLen - 1 - s]
  ) {
    s += 1;
  }

  const inherit: Marks =
    (p > 0 ? oldChars[p - 1]?.marks : oldChars[p]?.marks) ?? DEFAULT_MARKS;
  const middle: StyledChar[] = next
    .slice(p, newLen - s)
    .map((ch) => ({ ch, marks: inherit }));

  const chars = [...oldChars.slice(0, p), ...middle, ...oldChars.slice(oldLen - s)];
  return { chars, caret: p + middle.length };
}

/** Sépare les caractères en deux à l'offset `at` (pour la touche Entrée). */
export function splitChars(
  chars: StyledChar[],
  at: number,
): { left: StyledChar[]; right: StyledChar[] } {
  return { left: chars.slice(0, at), right: chars.slice(at) };
}
