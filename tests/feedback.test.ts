import { beforeAll, describe, it, expect } from "vitest";
import { mkdirSync } from "node:fs";
import { recordFeedback } from "../src/lib/feedback";
import { generateWeeklyReport } from "../src/lib/quality";
import { addManualPosting } from "../src/lib/postings";
import { exec, rows, row, uid, now } from "../src/lib/db";
import { fixtureAnchors } from "./helpers/anchors";
import { computeEvaluation } from "../src/lib/evaluation";
import { practicalFilters } from "../src/lib/filters";
import { extractionSchema } from "../src/lib/schemas";
import posting from "./fixtures/manual-posting.json";
import { loadInputs } from "../src/lib/bank";
beforeAll(() => {
  mkdirSync("data/tests", { recursive: true });
  process.env.DATABASE_PATH = `data/tests/feedback-${process.pid}-${Date.now()}.sqlite`;
});
describe("Phase 6 feedback acceptance", () => {
  it("never changes any stored evaluation score, classification or eligibility", () => {
    const id = addManualPosting(
      "Own internal product roadmap and translate requirements for engineering.",
    );
    exec(
      "UPDATE jobs SET features=? WHERE id=?",
      JSON.stringify(["archetype:Product Operations"]),
      id,
    );
    const inputs = loadInputs();
    const anchors = fixtureAnchors();
    const computed = computeEvaluation(
      anchors,
      practicalFilters(extractionSchema.parse(posting), inputs.bank),
      {
        official: true,
        aggregatorOnly: false,
        requiredPreferredDistinguished: true,
      },
    );
    exec(
      "INSERT INTO evaluations(id,job_id,bank_version,spec_version,bank_hash,spec_hash,posting_hash,model,anchors,computed,full_output,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
      uid(),
      id,
      inputs.bankVersion,
      inputs.specVersion,
      inputs.bankHash,
      inputs.specHash,
      "fixture",
      "fixture",
      JSON.stringify(anchors),
      JSON.stringify(computed),
      JSON.stringify({ anchors, computed }),
      now(),
    );
    const before = rows("SELECT * FROM evaluations");
    expect(before).toHaveLength(1);
    recordFeedback(id, "up", "great fit");
    expect(rows("SELECT * FROM evaluations")).toEqual(before);
    expect(
      row<{ weight: number }>(
        "SELECT weight FROM preference_signal WHERE feature=?",
        "archetype:Product Operations",
      )?.weight,
    ).toBe(1);
  });
  it("creates exactly one proposal after five distinct jobs, ignoring repeat votes for the count", () => {
    const ids = Array.from({ length: 5 }, (_, n) =>
      addManualPosting(
        `Product Operations role ${n}: improve product operating practices and workflows.`,
      ),
    );
    for (const id of ids)
      exec(
        "UPDATE jobs SET features=? WHERE id=?",
        JSON.stringify(["archetype:Product Operations"]),
        id,
      );
    for (let n = 0; n < 5; n++)
      recordFeedback(ids[0], "down", "too administrative");
    expect(rows("SELECT * FROM spec_change_proposals")).toHaveLength(0);
    for (const id of ids.slice(1))
      recordFeedback(id, "down", "too administrative");
    recordFeedback(ids[4], "down", "too administrative");
    expect(rows("SELECT * FROM spec_change_proposals")).toHaveLength(1);
  });
  it("routes factual errors to extraction review without preference weights", () => {
    const id = addManualPosting(
      "A fixture posting with location information needing review for accuracy.",
    );
    exec(
      "UPDATE jobs SET features=? WHERE id=?",
      JSON.stringify(["archetype:Error Fixture"]),
      id,
    );
    recordFeedback(
      id,
      "down",
      "location or terms wrong",
      "Office location is incorrect",
    );
    expect(
      row(
        "SELECT * FROM preference_signal WHERE feature=?",
        "archetype:Error Fixture",
      ),
    ).toBeUndefined();
    const report = generateWeeklyReport();
    expect(report.extraction_errors.some((e) => e.job_id === id)).toBe(true);
    expect(rows("SELECT * FROM quality_reports")).toHaveLength(1);
  });
});
