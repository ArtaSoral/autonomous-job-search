import { beforeAll, afterEach, describe, it, expect, vi } from "vitest";
import { mkdirSync } from "node:fs";
import { fetchAtsPosting, revalidateJob } from "../src/lib/listing";
import { addManualPosting, getJob } from "../src/lib/postings";
import { fetchSource } from "../src/lib/safe-fetch";
import fixtures from "./fixtures/sources.json";
beforeAll(() => {
  mkdirSync("data/tests", { recursive: true });
  process.env.DATABASE_PATH = `data/tests/listing-${process.pid}-${Date.now()}.sqlite`;
});
afterEach(() => vi.unstubAllGlobals());
describe("Listing validation and source URL safety", () => {
  it("finds Ashby jobs without an id field and refreshes posting content", async () => {
    vi.stubGlobal(
      "fetch",
      vi
        .fn()
        .mockImplementation(
          async () => new Response(JSON.stringify(fixtures.ashby)),
        ),
    );
    const url = fixtures.ashby.jobs[0].jobUrl;
    expect((await fetchAtsPosting(url))?.open).toBe(true);
    const id = addManualPosting(
      "An earlier description of a public Ashby posting, with outdated responsibilities.",
      url,
    );
    const hash = getJob(id).posting_hash;
    await revalidateJob(id);
    expect(getJob(id).posting_hash).not.toBe(hash);
    expect(getJob(id).description).toContain("Own product requirements");
  });
  it("refuses preparation when the official endpoint returns 404", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("", { status: 404 })),
    );
    const id = addManualPosting(
      "A job that was open earlier but is now unavailable at its official employer board.",
      "https://job-boards.greenhouse.io/fixture/jobs/101",
    );
    await expect(revalidateJob(id, true)).rejects.toThrow("closed");
    expect(getJob(id).listing_status).toBe("closed");
  });
  it.each([
    "http://boards-api.greenhouse.io/jobs",
    "https://127.0.0.1/secret",
    "https://example.com/",
    "https://boards-api.greenhouse.io:444/jobs",
    "https://user:pass@api.lever.co/jobs",
  ])("rejects unauthorized source URL %s", async (url) => {
    await expect(fetchSource(url)).rejects.toThrow("Unsupported source URL");
  });
});
