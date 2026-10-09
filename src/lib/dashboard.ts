import { z } from "zod";
import { rows, row } from "./db";
import { Job } from "./postings";
import {
  Anchors,
  anchorsSchema,
  classificationOrder,
  Classification,
} from "./evaluation";
import { registeredInputs } from "./inputs";
export const computedSchema = z.object({
  total: z.number().int().min(0).max(100),
  coverage: z.number().min(0).max(1),
  confidence: z.enum(["High", "Medium", "Low"]),
  confidence_reductions: z.array(z.string()),
  classification: z.enum([
    "Excellent",
    "Strong",
    "Provisional Strong",
    "Stretch",
    "Possible",
    "Weak",
    "Disqualified",
  ]),
  eligibility: z.enum([
    "Eligible",
    "Provisionally Eligible",
    "Ineligible",
    "Unresolved",
  ]),
  career_direction: z.string(),
  matched_work_share: z.number(),
  core_matches: z.number(),
  flags: z.array(z.string()),
  caps: z.array(z.string()),
  ledger: z.array(
    z
      .object({
        key: z.string(),
        weight: z.number(),
        points: z.number(),
        anchor: z.number(),
        posting_evidence: z.array(z.string()),
        bank_ids: z.array(z.string()),
        withheld_reason: z.string().nullable(),
      })
      .passthrough(),
  ),
});
export type EvaluationRecord = {
  id: string;
  job_id: string;
  computed: string;
  anchors: string;
  is_current: number;
  bank_version: string;
  spec_version: string;
  created_at: string;
  bank_hash: string;
  spec_hash: string;
  full_output: string;
};
export function latestEvaluation(jobId: string) {
  const record = row<EvaluationRecord>(
    "SELECT * FROM evaluations WHERE job_id=? ORDER BY created_at DESC LIMIT 1",
    jobId,
  );
  return record
    ? {
        record,
        computed: computedSchema.parse(JSON.parse(record.computed)),
        anchors: anchorsSchema.parse(JSON.parse(record.anchors)),
      }
    : null;
}
export type RankedJob = Job & {
  computed?: z.infer<typeof computedSchema>;
  anchors?: Anchors;
  stale: boolean;
  adjustment: number;
  preferenceReasons: string[];
  classification: Classification | "Awaiting evaluation";
};
export function displayAdjustment(
  features: string[],
  weights: Map<string, number>,
) {
  const reasons = features
    .filter((f) => weights.has(f))
    .map(
      (f) =>
        `${(weights.get(f) || 0) > 0 ? "+" : ""}${weights.get(f)} from feedback on ${f.replace(":", ": ")}`,
    );
  const adjustment = Math.max(
    -5,
    Math.min(
      5,
      features.reduce((n, f) => n + (weights.get(f) || 0), 0),
    ),
  );
  return { adjustment, reasons };
}
export function rankJobs(jobs: RankedJob[]) {
  return [...jobs].sort((a, b) => {
    const order = (c: RankedJob["classification"]) =>
      c === "Awaiting evaluation" ? 7 : classificationOrder.indexOf(c);
    return (
      order(a.classification) - order(b.classification) ||
      (b.computed?.total || 0) +
        b.adjustment -
        ((a.computed?.total || 0) + a.adjustment) ||
      b.first_seen.localeCompare(a.first_seen)
    );
  });
}
export function dashboardJobs(
  options: { showHidden?: boolean; threshold?: number } = {},
) {
  const i = registeredInputs();
  const weights = new Map(
    rows<{ feature: string; weight: number }>(
      "SELECT * FROM preference_signal",
    ).map((r) => [r.feature, r.weight]),
  );
  const data = rows<
    Job & {
      computed: string | null;
      anchors: string | null;
      is_current: number | null;
      filter_passed: number | null;
      triage_keep: number | null;
    }
  >(
    "SELECT j.*,e.computed,e.anchors,e.is_current,f.passed AS filter_passed,t.keep AS triage_keep FROM jobs j LEFT JOIN evaluations e ON e.id=(SELECT id FROM evaluations ev WHERE ev.job_id=j.id ORDER BY created_at DESC LIMIT 1) LEFT JOIN filter_results f ON f.job_id=j.id LEFT JOIN triage_results t ON t.job_id=j.id",
  );
  const jobs: RankedJob[] = data.map((r) => {
    const computed = r.computed
      ? computedSchema.parse(JSON.parse(r.computed))
      : undefined;
    const anchors = r.anchors
      ? anchorsSchema.parse(JSON.parse(r.anchors))
      : undefined;
    const features = z.array(z.string()).parse(JSON.parse(r.features));
    const preference = displayAdjustment(features, weights);
    const classification: RankedJob["classification"] =
      r.filter_passed === 0 || ["closed", "stale"].includes(r.listing_status)
        ? "Disqualified"
        : r.triage_keep === 0
          ? "Weak"
          : computed?.classification || "Awaiting evaluation";
    return {
      ...r,
      computed,
      anchors,
      stale: r.is_current === 0,
      classification,
      adjustment: preference.adjustment,
      preferenceReasons: preference.reasons,
    };
  });
  return rankJobs(
    jobs.filter(
      (j) =>
        options.showHidden ||
        (!["Weak", "Disqualified"].includes(j.classification) &&
          (!j.computed ||
            j.computed.total >=
              (options.threshold ??
                i.bank.job_preferences.match_score_threshold))),
    ),
  );
}
