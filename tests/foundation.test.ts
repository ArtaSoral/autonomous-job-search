import { describe, it, expect } from "vitest";
import { loadInputs, validateBank } from "../src/lib/bank";
import scoring from "../config/scoring.json";
describe("Phase 1 acceptance", () => {
  it("loads v3.3 with 47 usable and four retired bullets", () => {
    const { bank } = loadInputs();
    expect(bank.schema_version).toBe("3.3");
    expect(bank.bullets.filter((b) => b.usable_in_generation)).toHaveLength(47);
    expect(
      bank.bullets.filter((b) => b.verification_status === "retired"),
    ).toHaveLength(4);
  });
  it("names broken references and their field", () => {
    const bank = structuredClone(loadInputs().bank);
    bank.bullets[0].skill_ids.push("missing");
    expect(() => validateBank(bank)).toThrow(`${bank.bullets[0].id}.skill_ids`);
  });
  it("rejects retired usable bullets and broken reciprocal membership", () => {
    const bank = structuredClone(loadInputs().bank);
    bank.bullets[0].verification_status = "retired";
    expect(() => validateBank(bank)).toThrow("verification_status");
    bank.bullets[0].verification_status = "confirmed";
    bank.accomplishments[0].bullet_ids = [];
    expect(() => validateBank(bank)).toThrow("reciprocal");
  });
  it("matches the nine specification weights and anchors", () => {
    const { spec } = loadInputs();
    const weights = Object.values(scoring.categories).map((c) => c.weight);
    expect(weights.reduce((a, b) => a + b, 0)).toBe(100);
    const section = spec.split("# 19 ")[1].split("# 20 ")[0];
    const rows = section
      .split("\n")
      .filter((line) => /^\|[^|]+\|\s*\d+\s*\|/.test(line));
    expect(rows).toHaveLength(9);
    Object.values(scoring.categories).forEach((category, index) => {
      const cells = rows[index].split("|");
      expect(Number(cells[2].trim())).toBe(category.weight);
      const anchors = [...cells[3].trim().matchAll(/(?:^|;\s*)(\d+):/g)].map(
        (match) => Number(match[1]),
      );
      expect(anchors).toEqual(category.anchors);
    });
  });
});
