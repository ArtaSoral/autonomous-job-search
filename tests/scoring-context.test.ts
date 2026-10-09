import { describe, expect, it } from "vitest";
import { loadInputs } from "../src/lib/bank";
import { scoringContext } from "../src/lib/scoring-context";

describe("scoring context", () => {
  it("keeps constraints while selecting a bounded, role-relevant evidence set", () => {
    const { bank } = loadInputs();
    const context = scoringContext(
      bank,
      "Own workflow automation, requirements, prioritization, Jira and product operations.",
    );
    expect(context.bullets.length).toBeLessThanOrEqual(12);
    expect(context.bullets.some((bullet) => bullet.text.match(/Jira|workflow/i))).toBe(true);
    expect(context.guardrails).toHaveLength(bank.guardrails.length);
    expect(context.job_preferences.career_direction).toBe(
      bank.job_preferences.confirmed_constraints.career_direction,
    );
    expect(JSON.stringify(context).length).toBeLessThan(JSON.stringify(bank).length / 2);
  });
});
