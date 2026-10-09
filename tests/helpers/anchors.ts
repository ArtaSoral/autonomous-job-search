import { loadInputs } from "../../src/lib/bank";
import { anchorsSchema, Anchors, categoryKeys } from "../../src/lib/evaluation";
import scoring from "../../config/scoring.json";
import posting from "../fixtures/manual-posting.json";
import golden from "../fixtures/golden-postings.json";
const { bank } = loadInputs();
export function fixtureAnchors(
  kind: "positive" | "borderline" | "negative" = "positive",
): Anchors {
  const selected = bank.bullets.filter((b) => b.usable_in_generation);
  const groups = [
    ...new Map(selected.map((b) => [b.variant_group, b])).values(),
  ];
  const categories = Object.fromEntries(
    categoryKeys.map((key, n) => {
      const points = golden[kind].points[n];
      const anchors = scoring.categories[key].anchors;
      return [
        key,
        {
          points,
          anchor: anchors.find((a) => a <= points) || 0,
          between_anchors_reason:
            "Intermediate capability between the documented anchors",
          posting_evidence: [`Independent recurring responsibility ${n + 1}`],
          bank_ids: [groups[n].id],
          withheld_reason:
            points < scoring.categories[key].weight
              ? "Limited scope or outcome evidence"
              : null,
          clearly_supported_by_posting: true,
          evidence_tier: "direct",
          candidate_claims: [groups[n].text],
          double_count_justification: null,
        },
      ];
    }),
  );
  return anchorsSchema.parse({
    archetype: "Internal Tools Product Manager",
    categories,
    core_matches: groups.slice(0, 4).map((b, n) => ({
      responsibility: posting.responsibilities[n].text,
      work_share: 0.2,
      bank_ids: [b.id],
      evidence_tier: "direct",
    })),
    requirements: [],
    gap_clusters:
      kind === "borderline"
        ? [
            {
              description: "Prior production-AI delivery",
              severity: "material",
              central: false,
              manageable: true,
              reason: "Learnable production delivery gap with product bridge",
            },
          ]
        : [],
    seniority_inferable: true,
    guardrails_consulted: bank.guardrails.map((g) => g.id),
    guardrail_blocked_credit: [],
    career_direction:
      kind === "borderline" ? "Potentially Divergent" : "Confirmed Desirable",
    warning_signs: [],
    missing_facts: [],
    reasons: ["Responsibility match", "Workflow evidence", "Terms to verify"],
    questions_before_applying: [],
    unsupported_central_work_share: kind === "negative" ? 0.7 : 0,
    administrative_role_cap: false,
    explicit_exclusion: false,
    material_contradiction: false,
    decisive_evidence_shallow: false,
    product_authority: "Roadmap and requirements",
    primary_user: "Operations",
    product_type: "Internal tools",
    title_family: "Product Manager",
    domain_tag: null,
    company_type: null,
  });
}
