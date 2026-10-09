import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { z } from "zod";
import "dotenv/config";

const ids = z.array(z.string());
const item = z.object({ id: z.string() }).passthrough();
const bullet = item.extend({
  role_id: z.string(),
  accomplishment_id: z.string(),
  text: z.string(),
  skill_ids: ids,
  related_evidence: ids,
  verification_status: z.string(),
  usable_in_generation: z.boolean(),
  variant_group: z.string(),
  team_id: z.string().nullable(),
  team_ids: ids,
});
const team = item.extend({
  name: z.string(),
  display_start: z.string(),
  display_end: z.string(),
});
const role = item.extend({
  title: z.string(),
  company: z.string(),
  display_start: z.string(),
  display_end: z.string(),
  is_current: z.boolean(),
  teams: z.array(team).default([]),
});
const skill = item.extend({
  name: z.string(),
  aliases: ids,
  evidence_level: z.enum(["direct", "adjacent", "contextual", "listed_only"]),
});
export const bankSchema = z
  .object({
    schema_version: z.string(),
    last_updated: z.string(),
    contact: z
      .object({
        full_name: z.string(),
        email: z.string(),
        phone: z.string(),
        linkedin_url: z.string(),
      })
      .passthrough(),
    experience: z.array(role),
    bullets: z.array(bullet),
    evidence: z.array(item.extend({ text: z.string(), skill_ids: ids })),
    guardrails: z.array(item.extend({ rule: z.string(), evidence_ids: ids })),
    accomplishments: z.array(
      item.extend({ role_id: z.string(), bullet_ids: ids, evidence_ids: ids }),
    ),
    skills: z.array(skill),
    strengths: z.array(
      item.extend({
        text: z.string(),
        usable_in_generation: z.boolean(),
        verification_status: z.string(),
        skill_ids: ids,
      }),
    ),
    generation_policy: z
      .object({ tense: z.string(), date_format: z.string() })
      .passthrough(),
    job_preferences: z
      .object({
        minimum_salary: z.number(),
        salary_currency: z.string(),
        salary_basis: z.string(),
        employment_types: ids,
        target_titles: ids,
        match_score_threshold: z.number(),
        career_direction_confirmed: z.boolean(),
        confirmed_constraints: z.record(z.string(), z.unknown()),
        location_rules: z
          .object({
            home_state: z.string(),
            home_city: z.string(),
            relocation: z.string(),
            remote: z.object({ allowed: z.boolean() }).passthrough(),
            hybrid: z.object({ allowed: z.boolean(), allowed_states: ids }),
            onsite: z.object({ allowed: z.boolean(), allowed_states: ids }),
          })
          .passthrough(),
        structured_dealbreakers: z.array(item.extend({ rule: z.string() })),
      })
      .passthrough(),
    education: z.array(item),
    certifications: z.array(item),
    review_queue: z.array(z.unknown()),
    portfolio_links: z.array(z.unknown()).default([]),
  })
  .passthrough();
export type Bank = z.infer<typeof bankSchema>;
export type Bullet = Bank["bullets"][number];
export const sha256 = (text: string) =>
  createHash("sha256").update(text).digest("hex");
export function validateBank(value: unknown): Bank {
  const bank = bankSchema.parse(value);
  const collections = [
    bank.experience,
    bank.bullets,
    bank.evidence,
    bank.accomplishments,
    bank.skills,
    bank.guardrails,
    bank.strengths,
    bank.experience.flatMap((r) => r.teams),
  ];
  const all = new Set<string>();
  for (const collection of collections)
    for (const row of collection) {
      if (all.has(row.id)) throw Error(`${row.id}: duplicate id`);
      all.add(row.id);
    }
  const sets = {
    skill_ids: new Set(bank.skills.map((x) => x.id)),
    related_evidence: new Set(bank.evidence.map((x) => x.id)),
    evidence_ids: new Set(bank.evidence.map((x) => x.id)),
    accomplishment_id: new Set(bank.accomplishments.map((x) => x.id)),
    role_id: new Set(bank.experience.map((x) => x.id)),
    team_id: new Set(bank.experience.flatMap((x) => x.teams.map((t) => t.id))),
    team_ids: new Set(bank.experience.flatMap((x) => x.teams.map((t) => t.id))),
    bullet_ids: new Set(bank.bullets.map((x) => x.id)),
  };
  const walk = (obj: unknown, owner = "bank"): void => {
    if (Array.isArray(obj)) {
      obj.forEach((x) => walk(x, owner));
      return;
    }
    if (!obj || typeof obj !== "object") return;
    const o = obj as Record<string, unknown>;
    const id = typeof o.id === "string" ? o.id : owner;
    for (const [field, v] of Object.entries(o)) {
      if (field in sets && v !== null) {
        const refs = Array.isArray(v) ? v : [v];
        for (const ref of refs)
          if (!sets[field as keyof typeof sets].has(String(ref)))
            throw Error(`${id}.${field}: unresolved reference ${ref}`);
      } else if (typeof v === "object") walk(v, id);
    }
  };
  walk(bank);
  for (const b of bank.bullets) {
    const acc = bank.accomplishments.find((a) => a.id === b.accomplishment_id)!;
    if (!acc.bullet_ids.includes(b.id))
      throw Error(`${b.id}.accomplishment_id: missing reciprocal bullet_ids`);
    if (
      b.usable_in_generation &&
      !["confirmed", "no_known_conflict"].includes(b.verification_status)
    )
      throw Error(`${b.id}.verification_status: unusable status marked usable`);
    const role = bank.experience.find((r) => r.id === b.role_id)!;
    for (const t of [...b.team_ids, ...(b.team_id ? [b.team_id] : [])])
      if (!role.teams.some((x) => x.id === t))
        throw Error(`${b.id}.team_id: team belongs to another role`);
  }
  for (const a of bank.accomplishments)
    for (const id of a.bullet_ids)
      if (bank.bullets.find((b) => b.id === id)?.accomplishment_id !== a.id)
        throw Error(
          `${a.id}.bullet_ids: reciprocal accomplishment mismatch ${id}`,
        );
  return bank;
}
export function loadInputs() {
  const bankText = readFileSync(
    /* turbopackIgnore: true */
    process.env.BANK_PATH || "data/inputs/resume_bank_v3.3.json",
    "utf8",
  );
  const spec = readFileSync(
    /* turbopackIgnore: true */
    process.env.SPEC_PATH ||
      "data/inputs/Personal_Job_Finder_Search_and_Evaluation_Specification_v2_2.md",
    "utf8",
  );
  const bank = validateBank(JSON.parse(bankText));
  const specVersion = spec.match(/Version\s+([\d.]+)/)?.[1];
  if (!specVersion) throw Error("Specification version not found");
  return {
    bank,
    spec,
    bankText,
    bankVersion: bank.schema_version,
    specVersion,
    bankHash: sha256(bankText),
    specHash: sha256(spec),
  };
}
export function specSections(spec: string, numbers: number[]) {
  return spec
    .split(/(?=^# \d+ )/m)
    .filter((s) => numbers.includes(Number(s.match(/^# (\d+)/)?.[1])))
    .join("\n");
}
