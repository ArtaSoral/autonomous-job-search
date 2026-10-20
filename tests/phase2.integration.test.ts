import { beforeAll, describe, it, expect } from "vitest";
import { mkdirSync } from "node:fs";
import { loadInputs } from "../src/lib/bank";
import { addManualPosting, getJob } from "../src/lib/postings";
import {
  prepareDocuments,
  approveDocument,
  getDocument,
  saveApplication,
  selectBullets,
  documentLines,
  openingTense,
  requiredTense,
  generateDocumentDrafts,
} from "../src/lib/documents";
import { row } from "../src/lib/db";
import { ModelCall } from "../src/lib/model";
import { extractionSchema } from "../src/lib/schemas";
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
  else if (task === "rank usable bullets for relevance") {
    expect((data as { full_posting: string }).full_posting).toBeTruthy();
    result = {
      resume_plan: {
        positioning: "Product requirements and operational workflows",
        role_leads: bank.experience.map((role) => ({
          role_id: role.id,
          source_id: selectBullets(bank, []).find(
            (bullet) => bullet.role_id === role.id,
          )!.id,
          reason: "Concrete scoped work",
          supporting_source_ids: [],
        })),
        priorities: selectBullets(bank, [])
          .slice(0, 2)
          .map((bullet) => ({
            need: "Scoped product delivery",
            source_ids: [bullet.id],
            gap: null,
          })),
      },
      ranks: bank.bullets
        .filter((b) => b.usable_in_generation)
        .map((b) => ({ id: b.id, score: 8, reason: "Recorded relevance" })),
    };
  } else if (task === "reword documents") {
    expect(
      (
        data as {
          background_metadata: {
            education: unknown[];
            certifications: unknown[];
          };
        }
      ).background_metadata,
    ).toEqual({
      education: bank.education,
      certifications: bank.certifications,
    });
    const selected = selectBullets(bank, []);
    const line = (b: (typeof selected)[number]) => ({
      text: b.text,
      source_ids: [b.id],
    });
    result = {
      summary: [line(selected[0])],
      skill_ids: (
        data as { skill_candidates: { id: string }[] }
      ).skill_candidates
        .slice(-2)
        .map((skill) => skill.id),
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
    expect(options?.bank).toHaveProperty("experience");
    expect((data as { full_posting: string }).full_posting).toBeTruthy();
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
  it("can audit a saved posting without changing documents or the application tracker", async () => {
    const id = addManualPosting(
      "Own a product workflow roadmap and translate operational requirements.",
    );
    const generated = await generateDocumentDrafts(
      getJob(id),
      mock,
      extractionSchema.parse(posting),
    );
    expect(generated.resume.experience.length).toBeGreaterThan(0);
    expect(generated.resume.skill_ids).toHaveLength(2);
    expect(
      row<{ count: number }>(
        "SELECT count(*) AS count FROM documents WHERE job_id=?",
        id,
      )?.count,
    ).toBe(0);
    expect(
      row<{ count: number }>(
        "SELECT count(*) AS count FROM applications WHERE job_id=?",
        id,
      )?.count,
    ).toBe(0);
  });
  it("honors an explicitly empty skills selection instead of filling it with fallback skills", async () => {
    const id = addManualPosting(
      "Define technical requirements and prioritize an operational product roadmap.",
    );
    const omitSkills: ModelCall = async (task, schema, data, options) => {
      const result = await mock(task, schema, data, options);
      return task === "reword documents"
        ? schema.parse({ ...result, skill_ids: [] })
        : result;
    };
    const generated = await generateDocumentDrafts(
      getJob(id),
      omitSkills,
      extractionSchema.parse(posting),
    );
    expect(generated.resume.skill_ids).toEqual([]);
  });
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
