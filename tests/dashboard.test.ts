import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync } from "node:fs";
import { rankJobs, RankedJob, dashboardJobs } from "../src/lib/dashboard";
import { addManualPosting } from "../src/lib/postings";
import { classificationOrder } from "../src/lib/evaluation";
import { transaction, exec, uid, now } from "../src/lib/db";
import { loadInputs } from "../src/lib/bank";
import { fixtureAnchors } from "./helpers/anchors";
import { computeEvaluation } from "../src/lib/evaluation";
import { practicalFilters } from "../src/lib/filters";
import { extractionSchema } from "../src/lib/schemas";
import posting from "./fixtures/manual-posting.json";
beforeAll(() => {
  mkdirSync("data/tests", { recursive: true });
  process.env.DATABASE_PATH = `data/tests/dashboard-${process.pid}-${Date.now()}.sqlite`;
});
describe("Phase 5 dashboard acceptance", () => {
  it("classification always outranks preference adjustment", () => {
    const jobs = classificationOrder.map(
      (classification, n) =>
        ({
          id: String(n),
          classification,
          computed: { total: n === 0 ? 88 : 100 },
          adjustment: n === 0 ? -5 : 5,
          first_seen: "2026-10-08",
        }) as RankedJob,
    );
    expect(rankJobs(jobs.reverse()).map((j) => j.classification)).toEqual(
      classificationOrder,
    );
  });
  it("ranks 2,000 stored jobs in less than two seconds", () => {
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
    transaction(() => {
      for (let n = 0; n < 2000; n++) {
        const id = addManualPosting(
          `Fixture job ${n}: own roadmap and translate product requirements for engineering.`,
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
          "{}",
          now(),
        );
      }
    });
    const start = performance.now();
    expect(dashboardJobs()).toHaveLength(2000);
    expect(performance.now() - start).toBeLessThan(2000);
  });
});
