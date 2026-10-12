import { z } from "zod";
import { callModel, ModelCall } from "./model";
import { modelName } from "./openai-auth";
import { registeredInputs } from "./inputs";
import { getJob, extractPosting, Job } from "./postings";
import { practicalFilters } from "./filters";
import {
  anchorsSchema,
  validateAnchors,
  dedupeCoreMatches,
  normalizeGuardrailReferences,
  computeEvaluation,
  Anchors,
  scoringRubric,
  categoryKeys,
} from "./evaluation";
import { exec, now, transaction, uid } from "./db";
import { careerTenure } from "./tenure";
import { scoringContext } from "./scoring-context";
const triageSchema = z.object({
  archetype: z.string(),
  core_alignment_estimate: z.number().min(0).max(1),
  keep: z.boolean(),
  reason: z.string(),
  clear_weak_or_excluded: z.boolean(),
});
export async function evaluateJob(id: string, model: ModelCall = callModel) {
  const i = registeredInputs();
  const job = getJob(id);
  try {
    const extraction = await extractPosting(job, model);
    // A successful retry supersedes transient provider errors from a prior run.
    exec("UPDATE jobs SET review_error=NULL WHERE id=?", id);
    const filter = practicalFilters(extraction, i.bank, job.listing_status);
    exec(
      "INSERT INTO filter_results(job_id,passed,failed_rules,practical_eligibility,missing_fields,flags) VALUES(?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET passed=excluded.passed,failed_rules=excluded.failed_rules,practical_eligibility=excluded.practical_eligibility,missing_fields=excluded.missing_fields,flags=excluded.flags",
      id,
      filter.passed ? 1 : 0,
      JSON.stringify(filter.failed_rules),
      filter.eligibility,
      JSON.stringify(filter.missing_fields),
      JSON.stringify(filter.flags),
    );
    if (!filter.passed) {
      exec("UPDATE evaluations SET is_current=0 WHERE job_id=?", id);
      return { stage: "filtered", filter };
    }
    const triage = await model(
      "triage responsibilities; drop only clearly Weak or excluded work, keep uncertainty",
      triageSchema,
      { posting: job.description, extraction },
      {
        sections: [4, 7, 12, 32],
        bank: {
          bullets: i.bank.bullets.filter((b) => b.usable_in_generation),
          job_preferences: i.bank.job_preferences,
        },
      },
    );
    const keep = triage.keep || !triage.clear_weak_or_excluded;
    exec(
      "INSERT INTO triage_results(job_id,archetype,core_alignment_estimate,keep,reason) VALUES(?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET archetype=excluded.archetype,core_alignment_estimate=excluded.core_alignment_estimate,keep=excluded.keep,reason=excluded.reason",
      id,
      triage.archetype,
      triage.core_alignment_estimate,
      keep ? 1 : 0,
      triage.reason,
    );
    if (!keep) {
      exec("UPDATE evaluations SET is_current=0 WHERE job_id=?", id);
      return { stage: "triaged", triage };
    }
    const anchors = await fullEvaluation(job, extraction, i, model);
    const computed = computeEvaluation(anchors, filter, {
      official: !!job.official_verified,
      aggregatorOnly: !!job.aggregator_only,
      requiredPreferredDistinguished:
        extraction.required_preferred_distinguished,
    });
    const current = registeredInputs();
    if (current.bankHash !== i.bankHash || current.specHash !== i.specHash)
      throw Error("Inputs changed during evaluation");
    const evaluationId = uid();
    const output = {
      canonical: {
        employer: job.employer,
        title: job.title,
        url: job.canonical_url,
        requisition_id: job.requisition_id,
        posted_at: job.posted_at,
        last_verified: job.last_seen,
        listing_status: job.listing_status,
      },
      role: {
        archetype: anchors.archetype,
        title_family: anchors.title_family,
        product_authority: anchors.product_authority,
        primary_user: anchors.primary_user,
        product_type: anchors.product_type,
      },
      ...computed,
      filter,
      anchors,
      practical_terms: extraction,
      duplicate_history: {
        appearance_count: job.appearance_count,
        aggregator_only: !!job.aggregator_only,
      },
      provenance: {
        bank_version: i.bankVersion,
        spec_version: i.specVersion,
        bank_hash: i.bankHash,
        spec_hash: i.specHash,
        posting_hash: job.posting_hash,
        model: modelName(true) || "injected",
      },
    };
    const features = [
      `archetype:${anchors.archetype}`,
      `title_family:${anchors.title_family}`,
      ...(anchors.domain_tag ? [`domain:${anchors.domain_tag}`] : []),
      ...(anchors.company_type ? [`company_type:${anchors.company_type}`] : []),
    ];
    transaction(() => {
      exec("UPDATE evaluations SET is_current=0 WHERE job_id=?", id);
      exec(
        "INSERT INTO evaluations(id,job_id,bank_version,spec_version,bank_hash,spec_hash,posting_hash,model,anchors,computed,full_output,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
        evaluationId,
        id,
        i.bankVersion,
        i.specVersion,
        i.bankHash,
        i.specHash,
        job.posting_hash,
        modelName(true) || "injected",
        JSON.stringify(anchors),
        JSON.stringify(computed),
        JSON.stringify(output),
        now(),
      );
      exec(
        "UPDATE jobs SET features=?,review_error=NULL WHERE id=?",
        JSON.stringify(features),
        id,
      );
      for (const question of anchors.questions_before_applying)
        exec(
          "INSERT INTO bank_questions(id,job_id,question,created_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT id FROM bank_questions WHERE job_id=? AND question=?)",
          uid(),
          id,
          question,
          now(),
          id,
          question,
        );
    });
    return { stage: "evaluated", anchors, computed };
  } catch (e) {
    exec(
      "UPDATE jobs SET review_error=? WHERE id=?",
      e instanceof Error ? e.message : String(e),
      id,
    );
    throw e;
  }
}
async function fullEvaluation(
  job: Job,
  extraction: unknown,
  i: ReturnType<typeof registeredInputs>,
  model: ModelCall,
) {
  const context = scoringContext(i.bank, job.description);
  let verified: Anchors | undefined;
  const anchors = await model(
    "select evidence-backed scoring anchors, not classifications",
    anchorsSchema,
    {
      posting: job.description,
      extraction,
      scoring_rubric: scoringRubric,
      allowed_guardrail_ids: i.bank.guardrails.map((guardrail) => guardrail.id),
      instructions:
        "Every credited candidate_claim must be supported by bank IDs and respect all guardrails. Cite exact IDs of the supplied bank records; career_tenure is a computed summary, not a citation ID, so cite its underlying experience records instead. Select the evidence tier from the supporting facts first. For every category, points must be no greater than scoring_rubric[category].max_points_by_evidence_tier[evidence_tier]. These are whole-point ceilings rounded down, even when a listed anchor is higher. Choose an allowed anchor and explain intermediate points; never upgrade an evidence tier merely to fit a score. Only direct or adjacent evidence may support a core match with positive work_share; omit contextual, listed_only and title_only evidence from substantive core matches. Core matches must cover different substantive responsibilities and may not reuse the same variant_group in separate core matches. If posting evidence is reused in another category, that category needs a double_count_justification explaining its independent credit. Workflow-tooling evidence used in more than two categories needs distinct justifications in every such category. Guardrail references must be exact IDs from allowed_guardrail_ids (for example g-02), with no explanation appended to the ID. Group related gaps; preserve mandatory versus preferred and centrality. Never convert contextual exposure to ownership. domain_tag and company_type describe posting facts only, never invent a preference.",
    },
    {
      strong: true,
      sections: [2, 3, 19, 20, 21, 23, 24, 25],
      bank: { ...context, career_tenure: careerTenure(i.bank) },
      timeoutMs: 120000,
      validate: async (a) => {
        const normalized = normalizeGuardrailReferences(
          dedupeCoreMatches(a, i.bank),
          i.bank,
        );
        validateAnchors(normalized, i.bank);
        const judgmentSchema = z.object({
          categories: z
            .array(
              z.object({
                key: z.enum(categoryKeys),
                supported: z.boolean(),
                guardrails_violated: z.array(z.string()),
                reason: z.string(),
              }),
            )
            .length(categoryKeys.length),
        });
        const judgment = await model(
          "verify evaluation credit against bank and guardrails",
          judgmentSchema,
          {
            categories: normalized.categories,
            requirements: normalized.requirements,
            core_matches: normalized.core_matches,
            scoring_rubric: scoringRubric,
            instructions:
              "Return exactly one judgment for each allowed_category_keys entry. requirements and core_matches provide context only; do not return them as categories.",
            allowed_category_keys: categoryKeys,
          },
          {
            sections: [2, 8, 25],
            bank: context,
            validate: (r) => {
              if (
                r.categories.length !== categoryKeys.length ||
                new Set(r.categories.map((c) => c.key)).size !==
                  categoryKeys.length ||
                r.categories.some((c) => !(c.key in a.categories))
              )
                throw Error(
                  `Judge must cover each scoring category exactly once: ${categoryKeys.join(", ")}. Received: ${r.categories.map((c) => c.key).join(", ")}. Do not include requirements or core_matches as categories.`,
                );
            },
          },
        );
        const errors = judgment.categories.filter(
          (c) => !c.supported || c.guardrails_violated.length,
        );
        if (!errors.length) {
          verified = normalized;
          return;
        }
        const rejected = new Map<string, (typeof errors)[number]>(
          errors.map((error) => [error.key, error]),
        );
        const categories = Object.fromEntries(
          Object.entries(normalized.categories).map(([key, category]) => {
            const rejection = rejected.get(key);
            if (!rejection) return [key, category];
            return [
              key,
              {
                ...category,
                points: 0,
                anchor: 0,
                between_anchors_reason: null,
                posting_evidence: [],
                bank_ids: [],
                withheld_reason:
                  `Independent evidence check: ${rejection.reason} ${rejection.guardrails_violated.join(",")}`.trim(),
                clearly_supported_by_posting: false,
                evidence_tier: "title_only" as const,
                candidate_claims: [],
                double_count_justification: null,
              },
            ];
          }),
        ) as Anchors["categories"];
        verified = { ...normalized, categories };
        validateAnchors(verified, i.bank);
      },
    },
  );
  return (
    verified ||
    normalizeGuardrailReferences(dedupeCoreMatches(anchors, i.bank), i.bank)
  );
}
export async function reorderCheck(
  jobId: string,
  firstTotal: number,
  model: ModelCall = callModel,
) {
  const job = getJob(jobId);
  const i = registeredInputs();
  const extraction = await extractPosting(job, model);
  const reordered = {
    ...job,
    description: job.description.split(/\n+/).reverse().join("\n\n"),
  };
  const anchors = await fullEvaluation(reordered, extraction, i, model);
  const filter = practicalFilters(extraction, i.bank, job.listing_status);
  const second = computeEvaluation(anchors, filter, {
    official: !!job.official_verified,
    aggregatorOnly: !!job.aggregator_only,
    requiredPreferredDistinguished: extraction.required_preferred_distinguished,
  });
  const diff = Math.abs(firstTotal - second.total);
  exec(
    "INSERT INTO quality_checks(id,job_id,kind,result,created_at) VALUES(?,?,?,?,?)",
    uid(),
    jobId,
    "reorder",
    JSON.stringify({
      first: firstTotal,
      second: second.total,
      difference: diff,
      passed: diff <= 2,
    }),
    now(),
  );
}
