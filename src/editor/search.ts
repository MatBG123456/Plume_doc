import type { StyledChar } from "./text";
import { DEFAULT_MARKS } from "../render/marks";

// Logique **pure** de recherche / remplacement (sans DOM), pour être testée
// isolément : recherche d'occurrences en code points (insensible à la casse) et
// remplacement de plages dans une suite de caractères stylés.

/** Occurrences (offsets en code points) de `query` dans `text`, insensible à la casse. */
export function occurrences(text: string, query: string): { start: number; end: number }[] {
  const hay = Array.from(text.toLowerCase());
  const needle = Array.from(query.toLowerCase());
  const out: { start: number; end: number }[] = [];
  if (needle.length === 0) return out;
  for (let i = 0; i + needle.length <= hay.length; i += 1) {
    let ok = true;
    for (let j = 0; j < needle.length; j += 1) {
      if (hay[i + j] !== needle[j]) {
        ok = false;
        break;
      }
    }
    if (ok) out.push({ start: i, end: i + needle.length });
  }
  return out;
}

/**
 * Remplace des plages (triées, disjointes) de caractères par `replacement`. Les
 * caractères insérés héritent des marques du voisin de gauche (ou de droite en
 * tête de bloc). Les plages qui se chevauchent (ex. « aa » dans « aaa ») sont
 * ignorées pour ne pas dupliquer le remplacement.
 */
export function replaceRanges(
  chars: StyledChar[],
  ranges: { start: number; end: number }[],
  replacement: string,
): StyledChar[] {
  const repl = Array.from(replacement);
  const out: StyledChar[] = [];
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue;
    for (let i = cursor; i < r.start; i += 1) out.push(chars[i]);
    const inherit = (r.start > 0 ? chars[r.start - 1]?.marks : chars[r.end]?.marks) ?? DEFAULT_MARKS;
    for (const ch of repl) out.push({ ch, marks: inherit });
    cursor = r.end;
  }
  for (let i = cursor; i < chars.length; i += 1) out.push(chars[i]);
  return out;
}
