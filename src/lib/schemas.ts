import { z } from "zod";
const strings = z.array(z.string());
export const extractionSchema = z
  .object({
    employer: z.string(),
    employer_of_record: z.string().nullable(),
    client_disclosed: z.boolean().nullable(),
    title: z.string(),
    requisition_id: z.string().nullable(),
    location: z.object({
      arrangement: z.enum([
        "remote",
        "hybrid",
        "onsite",
        "AMBIGUOUS",
        "NOT_STATED",
      ]),
      office_locations: z.array(
        z.object({ city: z.string(), state: z.string() }),
      ),
      residency_states: strings,
      office_days_per_week: z.number().min(0).max(7).nullable(),
      relocation_required: z.boolean().nullable(),
    }),
    salary: z.object({
      min: z.number().nonnegative().nullable(),
      max: z.number().nonnegative().nullable(),
      basis: z.enum(["base", "total", "NOT_STATED"]),
      currency: z.string(),
    }),
    employment_type: z.enum([
      "full_time",
      "part_time",
      "contract",
      "contract_to_hire",
      "temporary",
      "AMBIGUOUS",
      "NOT_STATED",
    ]),
    contract_to_hire_converts_at_hire: z.boolean().nullable(),
    travel: z.string(),
    schedule_notes: strings,
    dealbreaker_signals: z.object({
      defense_or_government_customers: z.enum([
        "required",
        "preferred",
        "none",
      ]),
      scrum_master_facilitation_share: z.number().min(0).max(1),
      pmo_coordination_dominant: z.boolean(),
      people_management_mandatory: z.boolean(),
      sales_primary_outcome: z.boolean(),
      consulting_delivery_without_ownership: z.boolean(),
      security_clearance_required: z.boolean(),
    }),
    responsibilities: z.array(
      z.object({
        text: z.string(),
        estimated_work_share: z.number().min(0).max(1),
      }),
    ),
    required_qualifications: strings,
    preferred_qualifications: strings,
    required_preferred_distinguished: z.boolean(),
    named_tools: strings,
    listing_status_text: z.string().nullable(),
    is_agency: z.boolean().default(false),
    client_hires_directly: z.boolean().default(false),
    signal_evidence: z.record(z.string(), z.string()).default({}),
  })
  .superRefine((x, ctx) => {
    if (
      x.salary.min !== null &&
      x.salary.max !== null &&
      x.salary.min > x.salary.max
    )
      ctx.addIssue({ code: "custom", message: "Salary min exceeds max" });
    if (
      x.responsibilities.reduce((n, r) => n + r.estimated_work_share, 0) > 1.02
    )
      ctx.addIssue({
        code: "custom",
        message: "Responsibility shares exceed 100%",
      });
  });
export type Extraction = z.infer<typeof extractionSchema>;
export const lineSchema = z.object({
  text: z.string().min(1).max(2000),
  source_ids: strings.min(1),
});
export const draftSchema = z.object({
  questions_before_applying: z.array(z.string()).default([]),
  skill_ids: z.array(z.string()).max(12).optional(),
  summary: z.array(lineSchema).min(1).max(3),
  experience: z.array(lineSchema).min(1),
  cover_letter: z
    .array(z.object({ sentences: z.array(lineSchema).min(1).max(5) }))
    .min(3)
    .max(4),
});
export type Draft = z.infer<typeof draftSchema>;
export const judgeSchema = z.object({
  lines: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      verdict: z.enum(["supported", "partially supported", "unsupported"]),
      guardrails_violated: strings,
      reason: z.string(),
    }),
  ),
});
export const statuses = [
  "Saved",
  "Preparing",
  "Applied",
  "Interviewing",
  "Offer",
  "Rejected",
  "Withdrawn",
  "Closed",
] as const;
export const reasonTags = [
  "great fit",
  "too administrative",
  "wrong seniority",
  "domain not interesting",
  "location or terms wrong",
  "not product work",
  "other",
] as const;
