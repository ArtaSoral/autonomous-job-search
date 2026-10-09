import { z } from "zod";
import { mkdirSync, writeFileSync } from "node:fs";
import { registeredInputs } from "./inputs";
import { validateBank, sha256 } from "./bank";
import { exec, row, now, uid } from "./db";
import { callModel, ModelCall } from "./model";
import { verifyLines } from "./documents";
import { artifactDirectory } from "./storage";
import { join } from "node:path";
const growthSchema = z.object({
  text: z.string().min(1),
  label: z.string(),
  skill_ids: z.array(z.string()),
  supported_by_answer: z.boolean(),
  guardrails_violated: z.array(z.string()),
});
const storedDraftSchema = growthSchema.extend({
  role_id: z.string(),
  team_id: z.string().nullable(),
  source_id: z.string(),
  bank_hash: z.string(),
  spec_hash: z.string(),
  verification_status: z.literal("draft_pending_approval"),
  usable_in_generation: z.literal(false),
});
type Question = {
  id: string;
  job_id: string | null;
  question: string;
  answer: string | null;
  draft: string | null;
  status: string;
};
export async function answerBankQuestion(
  id: string,
  answer: string,
  roleId: string,
  teamId: string | null,
  model: ModelCall = callModel,
) {
  const q = row<Question>("SELECT * FROM bank_questions WHERE id=?", id);
  if (!q) throw Error("Question not found");
  const i = registeredInputs();
  const role = i.bank.experience.find((r) => r.id === roleId);
  if (!role || (teamId && !role.teams.some((t) => t.id === teamId)))
    throw Error("Choose a valid role and its team");
  const draft = await model(
    "draft new bank evidence and a conservative bullet from a user answer",
    growthSchema,
    {
      question: q.question,
      answer,
      role,
      team_id: teamId,
      required_tense:
        role.is_current &&
        (!teamId ||
          role.teams.find((t) => t.id === teamId)?.display_end === "Present")
          ? "present"
          : "past",
      instructions:
        "Only the answer establishes new facts. Do not add numbers, outcomes, ownership or tools. Follow required_tense. Return a draft_pending_approval bullet. If the answer conflicts with an existing guardrail, list that guardrail; do not bypass it.",
    },
    {
      strong: true,
      bank: {
        skills: i.bank.skills,
        guardrails: i.bank.guardrails,
        generation_policy: i.bank.generation_policy,
      },
      validate: (d) => {
        for (const id of d.skill_ids)
          if (!i.bank.skills.some((s) => s.id === id))
            throw Error(`Unknown draft skill ${id}`);
      },
    },
  );
  const validationBank = structuredClone(i.bank);
  const answerId = `answer-source-${id}`;
  validationBank.bullets.push({
    id: answerId,
    role_id: roleId,
    accomplishment_id: "answer-source",
    text: answer,
    skill_ids: [],
    related_evidence: [],
    verification_status: "confirmed",
    usable_in_generation: true,
    variant_group: answerId,
    team_id: teamId,
    team_ids: [],
  });
  const deterministic = verifyLines(
    [{ text: draft.text, source_ids: [answerId] }],
    validationBank,
  );
  const judgment = await model(
    "verify new bank draft against the user answer",
    z.object({
      supported: z.boolean(),
      guardrails_violated: z.array(z.string()),
      reason: z.string(),
    }),
    {
      answer,
      draft,
      instructions:
        "Reject any fact, number, tool, scope or outcome unsupported by the answer; respect existing guardrails.",
    },
    {
      bank: {
        guardrails: i.bank.guardrails,
        generation_policy: i.bank.generation_policy,
      },
    },
  );
  draft.supported_by_answer =
    draft.supported_by_answer &&
    judgment.supported &&
    !deterministic.some((f) => f.severity === "error");
  draft.guardrails_violated = [
    ...new Set([
      ...draft.guardrails_violated,
      ...judgment.guardrails_violated,
      ...deterministic
        .filter((f) => /^g-\d+/.test(f.reason))
        .map((f) => f.reason.split(":")[0]),
    ]),
  ];
  const stored = storedDraftSchema.parse({
    ...draft,
    role_id: roleId,
    team_id: teamId,
    source_id: `answer-${id}`,
    bank_hash: i.bankHash,
    spec_hash: i.specHash,
    verification_status: "draft_pending_approval",
    usable_in_generation: false,
  });
  exec(
    "UPDATE bank_questions SET answer=?,draft=?,status='answered' WHERE id=?",
    answer,
    JSON.stringify(stored),
    id,
  );
  return stored;
}
export function exportBankQuestion(
  id: string,
  version: string,
  approved: boolean,
) {
  const q = row<Question>("SELECT * FROM bank_questions WHERE id=?", id);
  if (!q?.answer || !q.draft)
    throw Error("Answer and draft the question before exporting");
  const draft = storedDraftSchema.parse(JSON.parse(q.draft));
  const i = registeredInputs();
  if (draft.bank_hash !== i.bankHash || draft.spec_hash !== i.specHash)
    throw Error(
      "Inputs changed since the draft. Save the answer again before export.",
    );
  if (
    !/^\d+\.\d+$/.test(version) ||
    version.split(".").map(Number)[0] <
      i.bankVersion.split(".").map(Number)[0] ||
    (version.split(".").map(Number)[0] ===
      i.bankVersion.split(".").map(Number)[0] &&
      version.split(".").map(Number)[1] <=
        i.bankVersion.split(".").map(Number)[1])
  )
    throw Error("Choose a new numeric bank version");
  if (
    approved &&
    (!draft.supported_by_answer || draft.guardrails_violated.length)
  )
    throw Error("Resolve the flagged draft before approving it");
  const bank = structuredClone(i.bank);
  const suffix = uid();
  const evidenceId = `evidence-${suffix}`;
  const bulletId = `bullet-${suffix}`;
  const accomplishmentId = `acc-${suffix}`;
  const bullet = {
    id: bulletId,
    role_id: draft.role_id,
    accomplishment_id: accomplishmentId,
    source_id: draft.source_id,
    text: draft.text,
    skill_ids: draft.skill_ids,
    related_evidence: [evidenceId],
    verification_status: approved ? "confirmed" : "draft_pending_approval",
    usable_in_generation: approved,
    variant_group: `vg-${suffix}`,
    team_id: draft.team_id,
    team_ids: [],
    review_note: null,
    severity: null,
    suggested_revision: null,
  };
  bank.evidence.push({
    id: evidenceId,
    role_id: draft.role_id,
    accomplishment_id: accomplishmentId,
    source_id: draft.source_id,
    kind: "fact",
    text: q.answer,
    skill_ids: draft.skill_ids,
    resume_usable: false,
  });
  bank.accomplishments.push({
    id: accomplishmentId,
    role_id: draft.role_id,
    label: draft.label,
    bullet_ids: [bulletId],
    evidence_ids: [evidenceId],
    variant_groups: [bullet.variant_group],
  });
  bank.bullets.push(bullet);
  if (approved) {
    const flags = verifyLines(
      [{ text: draft.text, source_ids: [bulletId] }],
      bank,
      true,
    );
    if (flags.some((f) => f.severity === "error"))
      throw Error(flags.map((f) => f.reason).join("; "));
  }
  bank.schema_version = version;
  bank.last_updated = now().slice(0, 10);
  bank.sources = [
    ...(bank.sources as unknown[]),
    {
      id: draft.source_id,
      label: `User answer to ${q.question}`,
      status: "confirmed",
      notes: q.answer,
    },
  ];
  bank.changelog = [
    ...(bank.changelog as string[]),
    `v${version} (${now().slice(0, 10)}): Added answer-backed evidence ${evidenceId} and ${approved ? "approved" : "pending"} bullet ${bulletId}.`,
  ];
  validateBank(bank);
  const outputDirectory = artifactDirectory("exports");
  mkdirSync(outputDirectory, { recursive: true });
  const filename = `resume_bank_v${version}_${suffix}.json`;
  writeFileSync(join(outputDirectory, filename), JSON.stringify(bank, null, 2));
  exec("UPDATE bank_questions SET status='exported' WHERE id=?", id);
  return { filename, sha256: sha256(JSON.stringify(bank, null, 2)), approved };
}
