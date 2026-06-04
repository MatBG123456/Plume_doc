import { describe, expect, it } from "vitest";
import type { Marks, Run } from "../bindings";
import { DEFAULT_MARKS } from "../render/marks";
import { occurrences, replaceRanges } from "./search";
import { charsText, charsToRuns, runsToChars } from "./text";

function run(text: string, p: Partial<Marks> = {}): Run {
  return { text, marks: { ...DEFAULT_MARKS, ...p } };
}

describe("occurrences", () => {
  it("trouve toutes les occurrences, insensible à la casse", () => {
    expect(occurrences("AbaBa", "ba")).toEqual([
      { start: 1, end: 3 },
      { start: 3, end: 5 },
    ]);
  });

  it("query vide → aucune", () => {
    expect(occurrences("abc", "")).toEqual([]);
  });

  it("offsets en code points (emoji hors BMP)", () => {
    expect(occurrences("a😀b", "b")).toEqual([{ start: 2, end: 3 }]);
  });
});

describe("replaceRanges", () => {
  it("remplace une plage interne", () => {
    const out = replaceRanges(runsToChars([run("hello")]), [{ start: 1, end: 4 }], "X");
    expect(charsText(out)).toBe("hXo");
  });

  it("remplace plusieurs plages disjointes", () => {
    const c = runsToChars([run("a.a.a")]);
    expect(charsText(replaceRanges(c, occurrences("a.a.a", "a"), "b"))).toBe("b.b.b");
  });

  it("ignore les plages chevauchantes (« aa » dans « aaa »)", () => {
    const c = runsToChars([run("aaa")]);
    expect(charsText(replaceRanges(c, occurrences("aaa", "aa"), "X"))).toBe("Xa");
  });

  it("le texte inséré hérite des marques du voisin de gauche", () => {
    const c = runsToChars([run("ab", { bold: true }), run("cd")]);
    const runs = charsToRuns(replaceRanges(c, [{ start: 2, end: 3 }], "X"));
    expect(runs.map((r) => r.text).join("")).toBe("abXd");
    expect(runs.find((r) => r.text.includes("X"))?.marks.bold).toBe(true);
  });
});
