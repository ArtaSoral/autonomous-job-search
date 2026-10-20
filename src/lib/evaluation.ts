import { z } from "zod";
import scoring from "../../config/scoring.json";
import { Bank } from "./bank";
import { FilterResult } from "./filters";
const strings = z.array(z.string());
export const categoryKeys = Object.keys(
  scoring.categories,
) as (keyof typeof scoring.categories)[];
export const scoringRubric = Object.fromEntries(
  categoryKeys.map((key) => {
    const category = scoring.categories[key];
    return [
      key,
      {
        ...category,
        max_points_by_evidence_tier: Object.fromEntries(
          Object.entries(scoring.evidence_tier_caps).map(([tier, cap]) => [
            tier,
            Math.floor(category.weight * cap),
          ]),
        ),
      },
    ];
  }),
);
const tier = z.enum([
  "direct",
  "adjacent",
  "contextual",
  "listed_only",
  "title_only",
]);
const category = z.object({
  points: z.number().int().nonnegative(),
  anchor: z.number().int().nonnegative(),
  between_anchors_reason: z.string().nullable(),
  posting_evidence: strings,
  bank_ids: strings,
  withheld_reason: z.string().nullable(),
  clearly_supported_by_posting: z.boolean(),
  evidence_tier: tier,
  candidate_claims: strings,
  double_count_justification: z.string().nullable(),
});
const categories = z.object(
  Object.fromEntries(categoryKeys.map((k) => [k, category])) as Record<
    keyof typeof scoring.categories,
    typeof category
  >,
);
export const anchorsSchema = z.object({
  archetype: z.string(),
  core_matches: z.array(
    z.object({
      responsibility: z.string(),
      work_share: z.number().min(0).max(1),
      bank_ids: strings.min(1),
      evidence_tier: tier,
    }),
  ),
  categories,
  requirements: z.array(
    z.object({
      text: z.string(),
      required: z.boolean(),
      status: z.enum([
        "Met",
        "Transferable",
        "Contextual only",
        "Unmet",
        "Unknown",
      ]),
      bank_ids: strings,
      central: z.boolean(),
      nonwaivable: z.boolean(),
      exception_language: z.string().nullable(),
    }),
  ),
  gap_clusters: z.array(
    z.object({
      description: z.string(),
      severity: z.enum(["material", "moderate"]),
      central: z.boolean(),
      manageable: z.boolean(),
      reason: z.string(),
    }),
  ),
  seniority_inferable: z.boolean(),
  guardrails_consulted: strings,
  guardrail_blocked_credit: z.array(
    z.object({ guardrail: z.string(), posting_requirement: z.string() }),
  ),
  career_direction: z.enum([
    "Confirmed Desirable",
    "Potentially Divergent",
    "Confirmed Undesirable",
    "Unresolved",
  ]),
  warning_signs: strings,
  missing_facts: strings,
  reasons: z.tuple([z.string(), z.string(), z.string()]),
  questions_before_applying: strings,
  unsupported_central_work_share: z.number().min(0).max(1),
  administrative_role_cap: z.boolean(),
  explicit_exclusion: z.boolean(),
  material_contradiction: z.boolean(),
  decisive_evidence_shallow: z.boolean(),
  product_authority: z.string(),
  primary_user: z.string(),
  product_type: z.string(),
  title_family: z.string(),
  domain_tag: z.string().nullable(),
  company_type: z.string().nullable(),
});
export type Anchors = z.infer<typeof anchorsSchema>;
/** Split only unambiguous lists of known IDs; preserve invalid text for validation. */
export function normalizeGuardrailReferences(a: Anchors, bank: Bank): Anchors {
  const allowed = new Set(bank.guardrails.map((guardrail) => guardrail.id));
  const split = (reference: string) => {
    const ids = reference
      .split(/\s*(?:[,/]|\band\b)\s*/)
      .map((id) => id.trim());
    return ids.length && ids.every((id) => allowed.has(id))
      ? [...new Set(ids)]
      : [reference];
  };
  return {
    ...a,
    guardrails_consulted: [...new Set(a.guardrails_consulted.flatMap(split))],
    guardrail_blocked_credit: a.guardrail_blocked_credit.flatMap((blocked) =>
      split(blocked.guardrail).map((guardrail) => ({ ...blocked, guardrail })),
    ),
  };
}
/** Remove repeated bullet variants from later core matches without adding credit. */
export function dedupeCoreMatches(a: Anchors, bank: Bank): Anchors {
  const seenGroups = new Set<string>();
  const core_matches = a.core_matches.flatMap((match) => {
    const bank_ids = match.bank_ids.filter((id) => {
      const group = bank.bullets.find(
        (bullet) => bullet.id === id,
      )?.variant_group;
      if (!group) return true;
      if (seenGroups.has(group)) return false;
      seenGroups.add(group);
      return true;
    });
    return bank_ids.length ? [{ ...match, bank_ids }] : [];
  });
  return { ...a, core_matches };
}
const confidenceLevels = ["Low", "Medium", "High"] as const;
export type Classification =
  | "Excellent"
  | "Strong"
  | "Provisional Strong"
  | "Stretch"
  | "Possible"
  | "Weak"
  | "Disqualified";
export const classificationOrder: Classification[] = [
  "Excellent",
  "Strong",
  "Provisional Strong",
  "Stretch",
  "Possible",
  "Weak",
  "Disqualified",
];
// Guardrail phrases in explicit limitations are not positive capability claims.
// Keep the exception local to the matched phrase; a later clause can still
// contain a forbidden assertion. Ambiguous wording remains subject to review.
function assertsPattern(claim: string, pattern: RegExp) {
  // Overlapping matches keep a negated phrase from consuming a later positive
  // assertion matched by the same guardrail expression.
  for (const match of claim.matchAll(
    new RegExp(`(?=${pattern.source})`, "gi"),
  )) {
    const prefix = claim
      .slice(0, match.index)
      .split(/[,.;:!?\n]|\b(?:but|however|yet|and)\b/i)
      .at(-1)!;
    const negated =
      /\b(?:no|never|without|not(?!\s+(?:only|just|merely|simply)\b))(?:\s+[\w'-]+){0,5}\s+$/i.test(
        prefix,
      );
    if (!negated) return true;
  }
  return false;
}
export function validateAnchors(a: Anchors, bank: Bank) {
  const usable = [
    ...bank.bullets.filter((b) => b.usable_in_generation),
    ...bank.evidence,
    ...bank.accomplishments,
    ...bank.skills,
    ...bank.strengths.filter((s) => s.usable_in_generation),
    ...bank.education,
    ...bank.certifications,
    ...bank.experience,
  ];
  const ids = new Set(usable.map((b) => b.id));
  const validateIds = (refs: string[]) => {
    for (const id of refs)
      if (!ids.has(id))
        throw Error(`Unknown or retired evaluation citation ${id}`);
  };
  const seenGroups = new Set<string>();
  for (const m of a.core_matches) {
    validateIds(m.bank_ids);
    const groups = new Set(
      m.bank_ids.flatMap((id) =>
        bank.bullets.filter((b) => b.id === id).map((b) => b.variant_group),
      ),
    );
    for (const group of groups) {
      if (seenGroups.has(group))
        throw Error(`Core match double counts variant ${group}`);
      seenGroups.add(group);
    }
    if (
      ["contextual", "listed_only", "title_only"].includes(m.evidence_tier) &&
      m.work_share > 0
    )
      throw Error(
        "Shallow evidence cannot be credited as a substantive core match",
      );
  }
  if (a.core_matches.reduce((s, m) => s + m.work_share, 0) > 1.02)
    throw Error("Matched work shares exceed 100%");
  for (const key of categoryKeys) {
    const c = a.categories[key],
      config = scoring.categories[key];
    validateIds(c.bank_ids);
    if (c.points > config.weight || !config.anchors.includes(c.anchor))
      throw Error(`Invalid ${key} points or anchor`);
    if (c.points !== c.anchor && !c.between_anchors_reason)
      throw Error(`${key}: partial anchor score needs a reason`);
    const maxPoints = Math.floor(
      config.weight * scoring.evidence_tier_caps[c.evidence_tier],
    );
    if (c.points > maxPoints)
      throw Error(
        `${key}: evidence tier credit ceiling exceeded; ${c.evidence_tier} evidence allows at most ${maxPoints}/${config.weight} whole points, received ${c.points}. Reduce points to the allowed ceiling or below; do not upgrade the evidence tier without supporting bank facts.`,
      );
    if (
      c.points > 0 &&
      (!c.bank_ids.length ||
        !c.posting_evidence.length ||
        !c.candidate_claims.length)
    )
      throw Error(`${key}: credit lacks traceable evidence`);
    if (c.points < config.weight && !c.withheld_reason)
      throw Error(`${key}: withheld points need a reason`);
    for (const id of c.bank_ids) {
      const skill = bank.skills.find((s) => s.id === id);
      if (
        skill &&
        c.bank_ids.every((id) => bank.skills.some((s) => s.id === id)) &&
        scoring.evidence_tier_caps[c.evidence_tier] >
          Math.max(
            ...c.bank_ids.map(
              (id) =>
                scoring.evidence_tier_caps[
                  bank.skills.find((s) => s.id === id)!.evidence_level
                ],
            ),
          )
      )
        throw Error(`${key}: skill depth inflated`);
    }
    const patterns: Record<string, RegExp> = {
      "g-08": /(built|created|developed).{0,40}(Data Strategy|KPI) dashboard/i,
      "g-09": /advanced SQL|warehouse modeling|complex joins/i,
      "g-16": /organi[sz]ation[- ]wide|enterprise[- ]wide/i,
      "g-18": /Copilot|Gemini/i,
      "g-20":
        /API design|API ownership|integration engineering|production software engineering|MLOps|ML architecture/i,
      "g-22": /(shipped|production|launched).{0,30}AI product/i,
      "g-23": /Tableau|Power BI|Looker|Qlik|MicroStrategy|Domo|Sisense/i,
    };
    for (const g of bank.guardrails)
      if (
        patterns[g.id] &&
        c.candidate_claims.some((claim) =>
          assertsPattern(claim, patterns[g.id]),
        ) &&
        (g.id !== "g-23" || c.evidence_tier === "direct")
      )
        throw Error(`${key}: guardrailed credit ${g.id}`);
  }
  for (const r of a.requirements) {
    validateIds(r.bank_ids);
    if (
      ["Met", "Transferable", "Contextual only"].includes(r.status) &&
      !r.bank_ids.length
    )
      throw Error("Met requirement needs bank evidence");
  }
  for (const id of a.guardrails_consulted)
    if (!bank.guardrails.some((g) => g.id === id))
      throw Error(`Invalid guardrail ${id}`);
  for (const g of a.guardrail_blocked_credit)
    if (!bank.guardrails.some((b) => b.id === g.guardrail))
      throw Error(`Invalid guardrail ${g.guardrail}`);
  const uses = new Map<string, string[]>();
  for (const key of categoryKeys) {
    if (!a.categories[key].points) continue;
    for (const fact of new Set(a.categories[key].posting_evidence)) {
      const prior = uses.get(fact) || [];
      if (prior.length && !a.categories[key].double_count_justification)
        throw Error(
          "Repeated posting evidence needs an independent-category explanation",
        );
      uses.set(fact, [...prior, key]);
    }
  }
  const tooling = categoryKeys.filter(
    (key) =>
      a.categories[key].points > 0 &&
      a.categories[key].bank_ids.some((id) => {
        const b = bank.bullets.find((b) => b.id === id);
        return (
          b?.accomplishment_id === "acc-fab-work-mgmt" ||
          ["sk-jira", "sk-asana"].includes(id)
        );
      }),
  );
  if (
    tooling.length > 2 &&
    tooling.some((k) => !a.categories[k].double_count_justification)
  )
    throw Error(
      "Workflow tooling counted beyond two categories without distinct justification",
    );
}
export function computeEvaluation(
  a: Anchors,
  filter: FilterResult,
  context: {
    official: boolean;
    aggregatorOnly: boolean;
    requiredPreferredDistinguished: boolean;
  },
) {
  const total = categoryKeys.reduce((n, k) => n + a.categories[k].points, 0);
  const coverage =
    categoryKeys.reduce(
      (n, k) =>
        n +
        (a.categories[k].clearly_supported_by_posting
          ? scoring.categories[k].weight
          : 0),
      0,
    ) / 100;
  const reductions: string[] = [];
  if (!a.seniority_inferable) reductions.push("Seniority not inferable");
  if (!context.requiredPreferredDistinguished)
    reductions.push("Required/preferred qualifications mixed");
  if (context.aggregatorOnly && !context.official)
    reductions.push("Aggregator-only and employer unverified");
  if (filter.missing_fields.length)
    reductions.push("Material practical field missing");
  let confidenceIndex = coverage >= 0.85 ? 2 : coverage >= 0.65 ? 1 : 0;
  confidenceIndex = Math.max(0, confidenceIndex - reductions.length);
  if (
    reductions.length >= 3 ||
    a.material_contradiction ||
    a.decisive_evidence_shallow
  )
    confidenceIndex = 0;
  else if (!context.official) confidenceIndex = Math.min(confidenceIndex, 1);
  const confidence = confidenceLevels[confidenceIndex];
  const material = a.gap_clusters.filter((g) => g.severity === "material");
  const moderate = a.gap_clusters.filter((g) => g.severity === "moderate");
  const matches = a.core_matches.filter((m) =>
    ["direct", "adjacent"].includes(m.evidence_tier),
  );
  const workShare = matches.reduce((n, m) => n + m.work_share, 0);
  const core = a.categories.core_responsibility.points;
  const product = a.categories.functional_product_capability.points;
  const gapsManageable = a.gap_clusters.every(
    (g) => !g.central && g.manageable,
  );
  const stretchGaps =
    (material.length === 1 && moderate.length === 0) ||
    (material.length === 0 && moderate.length >= 1 && moderate.length <= 2);
  const gates = (kind: "excellent" | "strong" | "stretch") => {
    const g = scoring.classifications[kind];
    return (
      total >= g.min &&
      core >= g.core_min &&
      product >= g.product_min &&
      matches.length >= g.core_matches_min &&
      workShare + 1e-9 >= g.work_share_min
    );
  };
  const flags: string[] = [];
  const caps: string[] = [];
  let classification: Classification;
  if (
    !filter.passed ||
    a.explicit_exclusion ||
    a.requirements.some(
      (r) =>
        r.required &&
        r.central &&
        r.nonwaivable &&
        r.status === "Unmet" &&
        !r.exception_language,
    )
  )
    classification = "Disqualified";
  else if (
    core < 18 ||
    matches.length < 2 ||
    a.unsupported_central_work_share >= 0.4 ||
    a.administrative_role_cap ||
    a.career_direction === "Confirmed Undesirable"
  )
    classification = "Weak";
  else if (gates("stretch") && stretchGaps && gapsManageable) {
    classification = "Stretch";
    if (material.length === 1) flags.push("PROMISING WITH ONE MANAGEABLE GAP");
  } else if (
    gates("excellent") &&
    confidence === "High" &&
    !material.length &&
    filter.eligibility === "Eligible" &&
    a.career_direction === "Confirmed Desirable"
  )
    classification = "Excellent";
  else if (gates("strong") && confidence !== "Low" && !material.length)
    classification =
      filter.eligibility === "Provisionally Eligible"
        ? "Provisional Strong"
        : "Strong";
  else if (
    total >= scoring.classifications.possible.min &&
    matches.length >= 2 &&
    workShare + 1e-9 >= 0.4
  )
    classification = "Possible";
  else classification = "Weak";
  if (classification !== "Disqualified" && classification !== "Weak") {
    if (confidence === "Low" || coverage < 0.65) {
      classification = "Possible";
      caps.push("Low confidence or vague responsibilities cap at Possible");
    } else if (
      (filter.eligibility === "Provisionally Eligible" ||
        a.career_direction === "Potentially Divergent") &&
      ["Excellent", "Strong"].includes(classification)
    ) {
      classification = "Provisional Strong";
      caps.push("Provisional practical terms or divergent career direction");
    }
  }
  return {
    total,
    coverage,
    confidence,
    confidence_reductions: reductions,
    classification,
    eligibility: filter.eligibility,
    career_direction: a.career_direction,
    matched_work_share: workShare,
    core_matches: matches.length,
    flags,
    caps,
    ledger: categoryKeys.map((key) => ({
      key,
      weight: scoring.categories[key].weight,
      ...a.categories[key],
    })),
  };
}
export type Computed = ReturnType<typeof computeEvaluation>;
