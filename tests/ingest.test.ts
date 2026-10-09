import { describe, it, expect, beforeAll } from "vitest";
import { mkdirSync } from "node:fs";
import {
  normalizeResponse,
  sourceNames,
  Company,
  buildQueries,
  fetchCompany,
} from "../src/lib/sources";
import { ingestPosting, isDuplicate, isolatedRun } from "../src/lib/ingest";
import { loadInputs } from "../src/lib/bank";
import { row, rows } from "../src/lib/db";
import fixtures from "./fixtures/sources.json";
beforeAll(() => {
  mkdirSync("data/tests", { recursive: true });
  process.env.DATABASE_PATH = `data/tests/ingest-${process.pid}-${Date.now()}.sqlite`;
});
const company = {
  id: "fixture",
  name: "Fixture Manufacturing",
  ats: "greenhouse",
  board_token: "fixture",
  active: 1,
  archetype_tags: "[]",
  notes: "",
} as Company;
describe("Phase 3 ingestion acceptance", () => {
  it.each(sourceNames)("normalizes %s public response contract", (source) => {
    const jobs = normalizeResponse(
      source,
      fixtures[source],
      source === "jsearch" || source === "adzuna" ? undefined : company,
    );
    expect(jobs).toHaveLength(1);
    expect(jobs[0].description).toContain("product requirements");
    expect(jobs[0].title).toBe("Product Manager");
  });
  it("merges requisite and threshold cases without merging unrelated employers", () => {
    const a = {
      employer: "Example Inc",
      title: "Product Manager",
      location: "NJ",
      requisitionId: null,
    };
    expect(isDuplicate(a, a, 0.86)).toBe(true);
    expect(isDuplicate(a, a, 0.8)).toBe(false);
    expect(
      isDuplicate(a, { ...a, title: "Senior Product Manager" }, 0.93),
    ).toBe(true);
    expect(
      isDuplicate(
        { ...a, requisitionId: "X" },
        { ...a, requisitionId: "X" },
        0,
      ),
    ).toBe(true);
    expect(isDuplicate(a, { ...a, employer: "Other" }, 1)).toBe(false);
  });
  it("prefers the board, preserves sources and updates the same job on a repeat run", () => {
    const agg = normalizeResponse("jsearch", fixtures.jsearch)[0];
    const board = normalizeResponse(
      "greenhouse",
      fixtures.greenhouse,
      company,
    )[0];
    const first = ingestPosting(agg);
    expect(ingestPosting(board).id).toBe(first.id);
    const second = ingestPosting(board);
    expect(second.created).toBe(false);
    const job = row<{
      canonical_url: string;
      appearance_count: number;
      aggregator_only: number;
    }>("SELECT * FROM jobs WHERE id=?", first.id)!;
    expect(job.canonical_url).toBe(board.url);
    expect(job.aggregator_only).toBe(0);
    expect(job.appearance_count).toBe(3);
    expect(
      rows("SELECT * FROM job_sources WHERE job_id=?", first.id),
    ).toHaveLength(2);
  });
  it("isolates a failed source and continues the next one", async () => {
    expect(
      (
        await isolatedRun("failure", async () => {
          throw Error("429");
        })
      ).ok,
    ).toBe(false);
    expect(
      (
        await isolatedRun("healthy", async () =>
          normalizeResponse("greenhouse", fixtures.greenhouse, company),
        )
      ).ok,
    ).toBe(true);
  });
  it("uses at least 30 percent responsibility queries from runtime bank and spec", () => {
    const { bank, spec } = loadInputs();
    const queries = buildQueries(bank, spec);
    expect(
      queries.filter((q) => q.responsibilityBased).length / queries.length,
    ).toBeGreaterThanOrEqual(0.3);
  });
  it("reads full SmartRecruiters details and paginates through the board", async () => {
    const urls: string[] = [];
    const jobs = await fetchCompany(
      { ...company, ats: "smartrecruiters" },
      async (url) => {
        urls.push(url);
        return url.includes("offset=")
          ? fixtures.smartrecruiters
          : fixtures.smartrecruiters.content[0];
      },
    );
    expect(jobs[0].description).toContain("product requirements");
    expect(urls).toHaveLength(2);
  });
});
