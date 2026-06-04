import { describe, expect, it } from "vitest";
import { newTable, withColAdded, withColRemoved, withRowAdded, withRowRemoved } from "./tableOps";

describe("tableOps", () => {
  it("newTable crée une grille rectangulaire de cellules vides", () => {
    const t = newTable(2, 3);
    expect(t.rows).toHaveLength(2);
    expect(t.rows.every((r) => r.length === 3)).toBe(true);
    expect(t.rows[0][0].runs).toEqual([]);
  });

  it("ajoute/retire une ligne en conservant la largeur", () => {
    const t = newTable(2, 3);
    const added = withRowAdded(t);
    expect(added.rows).toHaveLength(3);
    expect(added.rows[2]).toHaveLength(3);
    expect(withRowRemoved(added).rows).toHaveLength(2);
  });

  it("ajoute/retire une colonne sur toutes les lignes", () => {
    const t = newTable(2, 2);
    const added = withColAdded(t);
    expect(added.rows.every((r) => r.length === 3)).toBe(true);
    expect(withColRemoved(added).rows.every((r) => r.length === 2)).toBe(true);
  });

  it("garde au moins une ligne et une colonne", () => {
    const t = newTable(1, 1);
    expect(withRowRemoved(t).rows).toHaveLength(1);
    expect(withColRemoved(t).rows[0]).toHaveLength(1);
  });

  it("reste rectangulaire après plusieurs opérations", () => {
    let t = newTable(2, 2);
    t = withRowAdded(withColAdded(t));
    const w = t.rows[0].length;
    expect(t.rows.every((r) => r.length === w)).toBe(true);
  });
});
