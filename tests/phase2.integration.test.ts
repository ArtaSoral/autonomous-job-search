import { beforeAll, describe, it, expect } from "vitest";
import { mkdirSync } from "node:fs";
import { loadInputs } from "../src/lib/bank";
import { addManualPosting } from "../src/lib/postings";
import {
  prepareDocuments,
  approveDocument,
  getDocument,
  saveApplication,
  selectBullets,
  documentLines,
  openingTense,
  requiredTense,
} from "../src/lib/documents";
import { row } from "../src/lib/db";
import { ModelCall } from "../src/lib/model";
import posting from "./fixtures/manual-posting.json";
beforeAll(() => {
  mkdirSync("data/tests", { recursive: true });
  process.env.DATABASE_PATH = `data/tests/phase2-${process.pid}-${Date.now()}.sqlite`;
  process.env.TEST_ARTIFACT_DIR = process.env.DATABASE_PATH.replace(
    ".sqlite",
    "-artifacts",
  );
});
const mock: ModelCall = async (task, schema, data, options) => {
  const { bank } = loadInputs();
  let result: unknown;
  if (task === "extract posting") result = posting;
  else if (task === "rank usable bullets for relevance")
    result = {
      ranks: bank.bullets
        .filter((b) => b.usable_in_generation)
        .map((b) => ({ id: b.id, score: 8, reason: "Recorded relevance" })),
    };
  else if (task === "reword documents") {
    const selected = selectBullets(bank, []);
    const line = (b: (typeof selected)[number]) => ({
      text: b.text,
      source_ids: [b.id],
    });
    result = {
      summary: [line(selected[0])],
      experience: selected.map((b) => {
        const result = line(b);
        result.text = openingTense(result.text, requiredTense(result, bank)!);
        return result;
      }),
      cover_letter: [
        { sentences: [line(selected[0])] },
        { sentences: [line(selected[1])] },
        { sentences: [line(selected[2])] },
      ],
    };
  } else if (task.startsWith("verify every")) {
    const lines = (data as { lines: { index: number }[] }).lines;
    result = {
      lines: lines.map((l) => ({
        index: l.index,
        verdict: "supported",
        guardrails_violated: [],
        reason: "Recorded source unchanged",
      })),
    };
  } else throw Error(`Unexpected task ${task}`);
  const value = schema.parse(result);
  options?.validate?.(value);
  return value;
};
describe("Phase 2 full workflow with recorded model results", () => {
  it("prepares, verifies, exports and records the exact sent versions in under 60 seconds", async () => {
    const id = addManualPosting(
      "Own a product workflow roadmap, translate operational requirements for engineering, configure intake automation and help define KPIs. Full time in Newark NJ.",
    );
    const started = Date.now();
    const documents = await prepareDocuments(id, true, mock);
    expect(Date.now() - started).toBeLessThan(60000);
    const resume = getDocument(documents.resumeId);
    expect(documentLines(resume).every((l) => l.source_ids.length > 0)).toBe(
      true,
    );
    await approveDocument(documents.resumeId);
    await approveDocument(documents.coverId);
    saveApplication(id, {
      status: "Applied",
      resume_document_id: documents.resumeId,
      cover_document_id: documents.coverId,
    });
    const app = row<{
      status: string;
      resume_document_id: string;
      cover_document_id: string;
      status_history: string;
    }>("SELECT * FROM applications WHERE job_id=?", id)!;
    expect(app.status).toBe("Applied");
    expect(app.resume_document_id).toBe(documents.resumeId);
    expect(app.cover_document_id).toBe(documents.coverId);
    expect(JSON.parse(app.status_history).at(-1).resume_document_id).toBe(
      documents.resumeId,
    );
  });
  it("rejects preparing closed listings even with a manual confirmation", async () => {
    const id = addManualPosting(
      "A closed role with responsibilities for product roadmaps and workflow automation.",
    );
    const { exec } = await import("../src/lib/db");
    exec("UPDATE jobs SET listing_status='closed' WHERE id=?", id);
    await expect(prepareDocuments(id, true, mock)).rejects.toThrow("closed");
  });
});
