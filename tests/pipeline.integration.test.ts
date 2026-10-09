import { beforeAll, describe, it, expect, vi, afterEach } from "vitest";
import { mkdirSync } from "node:fs";
import { z } from "zod";
import { ModelCall, callModel } from "../src/lib/model";
import { fixtureAnchors } from "./helpers/anchors";
import { evaluateJob, reorderCheck } from "../src/lib/pipeline";
import { addManualPosting, getJob, extractPosting } from "../src/lib/postings";
import { row, rows, exec } from "../src/lib/db";
import { loadInputs } from "../src/lib/bank";
import { registeredInputs } from "../src/lib/inputs";
import posting from "./fixtures/manual-posting.json";
import { streamResult } from "./helpers/openai";
beforeAll(() => {
  mkdirSync("data/tests", { recursive: true });
  process.env.DATABASE_PATH = `data/tests/pipeline-${process.pid}-${Date.now()}.sqlite`;
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function fixtureModel(counter: Record<string, number> = {}): ModelCall {
  return async (task, schema, data, options) => {
    counter[task] = (counter[task] || 0) + 1;
    let result: unknown;
    if (task === "extract posting") result = posting;
    else if (task.startsWith("triage"))
      result = {
        archetype: "Internal Tools Product Manager",
        core_alignment_estimate: 0.8,
        keep: true,
        reason: "Substantive product work",
        clear_weak_or_excluded: false,
      };
    else if (task.startsWith("select evidence")) result = fixtureAnchors();
    else if (task === "verify evaluation credit against bank and guardrails")
      result = {
        categories: Object.keys(fixtureAnchors().categories).map((key) => ({
          key,
          supported: true,
          guardrails_violated: [],
          reason: "Source-backed recorded judgment",
        })),
      };
    else throw Error(`Unexpected task ${task}`);
    const parsed = schema.parse(result);
    await options?.validate?.(parsed);
    return parsed;
  };
}
describe("Evaluation integration and provider failure handling", () => {
  it("stores complete provenance, caches extraction and logs independent reorder checks", async () => {
    const id = addManualPosting(
      "Own a workflow roadmap.\n\nTranslate requirements for engineering.\n\nConfigure intake automation and define KPIs.",
    );
    exec(
      "UPDATE jobs SET listing_status='open',official_verified=1 WHERE id=?",
      id,
    );
    const counts: Record<string, number> = {};
    const model = fixtureModel(counts);
    const result = await evaluateJob(id, model);
    expect(result.stage).toBe("evaluated");
    expect(result.computed?.classification).toBe("Excellent");
    const record = row<{
      bank_hash: string;
      spec_hash: string;
      anchors: string;
      model: string;
    }>("SELECT * FROM evaluations WHERE job_id=?", id)!;
    expect(record.bank_hash).toBe(loadInputs().bankHash);
    expect(record.spec_hash).toBe(loadInputs().specHash);
    expect(record.model).toBeTruthy();
    await extractPosting(getJob(id), model);
    expect(counts["extract posting"]).toBe(1);
    await reorderCheck(id, 92, model);
    const check = row<{ result: string }>(
      "SELECT * FROM quality_checks WHERE job_id=?",
      id,
    )!;
    expect(JSON.parse(check.result).passed).toBe(true);
    exec(
      "UPDATE evaluations SET bank_hash=? WHERE job_id=?",
      "old-input-hash",
      id,
    );
    registeredInputs();
    expect(
      row<{ is_current: number }>(
        "SELECT is_current FROM evaluations WHERE job_id=?",
        id,
      )!.is_current,
    ).toBe(0);
  });
  it("retries invalid citations exactly once, preserves failed call logs, then succeeds", async () => {
    vi.stubEnv("OPENAI_AUTH_MODE", "api");
    vi.stubEnv("OPENAI_API_KEY", "test-only-placeholder");
    vi.stubEnv("MODEL_FAST", "test-model");
    const source = loadInputs().bank.bullets.find(
      (b) => b.usable_in_generation,
    )!.id;
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(streamResult({ source: "missing" }))
      .mockResolvedValueOnce(streamResult({ source }));
    vi.stubGlobal("fetch", fetcher);
    const task = "citation retry fixture";
    const result = await callModel(
      task,
      z.object({ source: z.string() }),
      {},
      {
        validate: (r) => {
          if (r.source !== source) throw Error("Unknown bank citation");
        },
      },
    );
    expect(result.source).toBe(source);
    expect(fetcher).toHaveBeenCalledTimes(2);
    const calls = rows<{ error: string | null; bank_hash: string }>(
      "SELECT * FROM llm_calls WHERE task=? ORDER BY created_at",
      task,
    );
    expect(calls).toHaveLength(2);
    expect(calls[0].error).toContain("Unknown bank citation");
    expect(calls[1].error).toBeNull();
  });
  it("marks failed evaluation for review without storing invalid credit", async () => {
    const id = addManualPosting(
      "Fixture invalid credit: product roadmap, requirements and workflow responsibilities.",
    );
    const good = fixtureModel();
    const bad: ModelCall = async (task, schema, data, options) => {
      if (task.startsWith("select evidence")) {
        const a = fixtureAnchors();
        a.categories.product_ownership.bank_ids = ["nonexistent"];
        const result = schema.parse(a);
        await options?.validate?.(result);
        return result;
      }
      return good(task, schema, data, options);
    };
    await expect(evaluateJob(id, bad)).rejects.toThrow("citation");
    expect(
      row<{ review_error: string }>(
        "SELECT review_error FROM jobs WHERE id=?",
        id,
      )?.review_error,
    ).toContain("citation");
    expect(rows("SELECT * FROM evaluations WHERE job_id=?", id)).toHaveLength(
      0,
    );
  });
});
