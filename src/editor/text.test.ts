import { describe, expect, it } from "vitest";
import type { Marks, Run } from "../bindings";
import { DEFAULT_MARKS } from "../render/marks";
import { charsText, charsToRuns, reconcile, runsToChars, splitChars } from "./text";

function marks(p: Partial<Marks> = {}): Marks {
  return { ...DEFAULT_MARKS, ...p };
}
function run(text: string, p: Partial<Marks> = {}): Run {
  return { text, marks: marks(p) };
}

describe("runsToChars / charsToRuns", () => {
  it("aplati puis recoalesce (round-trip)", () => {
    const runs = [run("ab"), run("cd", { bold: true })];
    const chars = runsToChars(runs);
    expect(chars).toHaveLength(4);
    expect(charsText(chars)).toBe("abcd");
    expect(charsToRuns(chars)).toEqual(runs);
  });

  it("fusionne les runs adjacents de mêmes marques", () => {
    expect(charsToRuns(runsToChars([run("a"), run("b")]))).toEqual([run("ab")]);
  });

  it("sépare sur un changement de marques", () => {
    const back = charsToRuns(runsToChars([run("a"), run("b", { italic: true })]));
    expect(back).toEqual([run("a"), run("b", { italic: true })]);
  });

  it("compte par code points (emoji hors BMP)", () => {
    expect(runsToChars([run("a😀b")]).map((c) => c.ch)).toEqual(["a", "😀", "b"]);
  });
});

describe("reconcile", () => {
  const base = runsToChars([run("hello", { bold: true })]);

  it("insertion au milieu hérite des marques de gauche", () => {
    const { chars, caret } = reconcile(base, "helXlo");
    expect(charsText(chars)).toBe("helXlo");
    expect(chars[3].marks.bold).toBe(true);
    expect(caret).toBe(4);
  });

  it("insertion en tête hérite des marques de droite", () => {
    const { chars } = reconcile(base, "Xhello");
    expect(charsText(chars)).toBe("Xhello");
    expect(chars[0].marks.bold).toBe(true);
  });

  it("suppression d'un caractère final", () => {
    expect(charsText(reconcile(base, "hell").chars)).toBe("hell");
  });

  it("remplacement d'une sélection interne", () => {
    const { chars, caret } = reconcile(base, "heYYo");
    expect(charsText(chars)).toBe("heYYo");
    expect(caret).toBe(4);
  });

  it("vide tout", () => {
    expect(reconcile(base, "").chars).toHaveLength(0);
  });

  it("préserve les marques des préfixe/suffixe inchangés", () => {
    const mixed = runsToChars([run("ab", { bold: true }), run("cd", { italic: true })]);
    const { chars } = reconcile(mixed, "abXcd"); // insertion à la frontière
    expect(charsText(chars)).toBe("abXcd");
    expect(chars[0].marks.bold).toBe(true);
    expect(chars[4].marks.italic).toBe(true);
  });
});

describe("splitChars", () => {
  it("coupe à l'offset (touche Entrée)", () => {
    const chars = runsToChars([run("abcd")]);
    const { left, right } = splitChars(chars, 2);
    expect(charsText(left)).toBe("ab");
    expect(charsText(right)).toBe("cd");
  });
});
