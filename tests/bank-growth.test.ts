import { beforeAll, describe, it, expect } from "vitest";
import { mkdirSync, readFileSync } from "node:fs";
import { answerBankQuestion, exportBankQuestion } from "../src/lib/bank-growth";
import { ModelCall } from "../src/lib/model";
import { loadInputs, validateBank } from "../src/lib/bank";
import { exec, uid, now } from "../src/lib/db";
import { artifactDirectory } from "../src/lib/storage";
import { join } from "node:path";
beforeAll(() => {
  mkdirSync("data/tests", { recursive: true });
  process.env.DATABASE_PATH = `data/tests/growth-${process.pid}-${Date.now()}.sqlite`;
  process.env.TEST_ARTIFACT_DIR = process.env.DATABASE_PATH.replace(
    ".sqlite",
    "-artifacts",
  );
});
const mock: ModelCall = async (task, schema, data, options) => {
  const value = schema.parse(
    task === "verify new bank draft against the user answer"
      ? {
          supported: true,
          guardrails_violated: [],
          reason: "Supported by the answer",
        }
      : {
          text: "Documented product requirements for an internal intake workflow.",
          label: "Internal intake requirements",
          skill_ids: [],
          supported_by_answer: true,
          guardrails_violated: [],
        },
  );
  await options?.validate?.(value);
  return value;
};
describe("Phase 7 bank growth", () => {
  it("leaves original unchanged, retains draft ineligible and exports only after approval", async () => {
    const original = loadInputs();
    const id = uid();
    exec(
      "INSERT INTO bank_questions(id,question,created_at) VALUES(?,?,?)",
      id,
      "Have you documented intake requirements?",
      now(),
    );
    await answerBankQuestion(
      id,
      "Documented product requirements for an internal intake workflow.",
      original.bank.experience[0].id,
      null,
      mock,
    );
    const pending = exportBankQuestion(id, "3.4", false);
    const draft = validateBank(
      JSON.parse(
        readFileSync(
          join(artifactDirectory("exports"), pending.filename),
          "utf8",
        ),
      ),
    );
    expect(draft.bullets.at(-1)?.usable_in_generation).toBe(false);
    expect(draft.bullets.at(-1)?.verification_status).toBe(
      "draft_pending_approval",
    );
    const exported = exportBankQuestion(id, "3.4", true);
    const bank = validateBank(
      JSON.parse(
        readFileSync(
          join(artifactDirectory("exports"), exported.filename),
          "utf8",
        ),
      ),
    );
    expect(bank.bullets.at(-1)?.usable_in_generation).toBe(true);
    expect(bank.bullets.at(-1)?.verification_status).toBe("confirmed");
    expect(loadInputs().bankHash).toBe(original.bankHash);
  });
});
