import { fixtureAnchors } from "./helpers/anchors";
import { describe, it, expect } from "vitest";
import { loadInputs } from "../src/lib/bank";
import { extractionSchema } from "../src/lib/schemas";
import { practicalFilters } from "../src/lib/filters";
import {
  anchorsSchema,
  Anchors,
  categoryKeys,
  computeEvaluation,
  validateAnchors,
  dedupeCoreMatches,
} from "../src/lib/evaluation";
import scoring from "../config/scoring.json";
import posting from "./fixtures/manual-posting.json";
import golden from "./fixtures/golden-postings.json";
const { bank } = loadInputs();
const x = () => extractionSchema.parse(structuredClone(posting));
const context = {
  official: true,
  aggregatorOnly: false,
  requiredPreferredDistinguished: true,
};
describe("Phase 4 practical filters", () => {
  it.each([
    "residency",
    "office",
    "salary",
    "agency",
    "defense",
    "scrum",
    "contract",
  ])("rejects %s fixture", (kind) => {
    const p = x();
    if (kind === "residency") {
      p.location.arrangement = "remote";
      p.location.residency_states = ["CA"];
    }
    if (kind === "office")
      p.location.office_locations = [{ city: "Boston", state: "MA" }];
    if (kind === "salary")
      p.salary = { min: 90000, max: 98000, basis: "base", currency: "USD" };
    if (kind === "agency") {
      p.is_agency = true;
      p.client_disclosed = false;
      p.client_hires_directly = false;
    }
    if (kind === "defense")
      p.dealbreaker_signals.defense_or_government_customers = "required";
    if (kind === "scrum")
      p.dealbreaker_signals.scrum_master_facilitation_share = 0.9;
    if (kind === "contract") p.employment_type = "contract";
    expect(practicalFilters(p, bank).eligibility).toBe("Ineligible");
  });
  it("keeps unstated and straddling base salary, flags verification and reports schedule", () => {
    const p = x();
    p.salary = { min: null, max: null, basis: "NOT_STATED", currency: "USD" };
    p.schedule_notes = ["Weekend on-call"];
    expect(practicalFilters(p, bank).passed).toBe(true);
    expect(practicalFilters(p, bank).missing_fields).toContain("base_salary");
    p.salary = { min: 85000, max: 120000, basis: "base", currency: "USD" };
    expect(practicalFilters(p, bank).eligibility).toBe("Eligible");
    expect(practicalFilters(p, bank).flags).not.toHaveLength(0);
  });
  it("does not count bonus/total compensation or reject merely preferred defense", () => {
    const p = x();
    p.salary.basis = "total";
    p.dealbreaker_signals.defense_or_government_customers = "preferred";
    expect(practicalFilters(p, bank).passed).toBe(true);
    expect(practicalFilters(p, bank).missing_fields).toContain("base_salary");
  });
  it("handles contract conversion at hire", () => {
    const p = x();
    p.employment_type = "contract_to_hire";
    expect(practicalFilters(p, bank).passed).toBe(false);
    p.contract_to_hire_converts_at_hire = true;
    expect(practicalFilters(p, bank).passed).toBe(true);
  });
});
describe("Phase 4 golden scoring and citations", () => {
  it("removes repeated core-match variants without adding replacement evidence", () => {
    const a = fixtureAnchors();
    a.core_matches[1].bank_ids.push(a.core_matches[0].bank_ids[0]);
    const normalized = dedupeCoreMatches(a, bank);
    expect(normalized.core_matches[1].bank_ids).not.toContain(
      a.core_matches[0].bank_ids[0],
    );
    expect(() => validateAnchors(normalized, bank)).not.toThrow();
  });
  it("positive example is 92, High, Eligible, Excellent", () => {
    const a = fixtureAnchors();
    validateAnchors(a, bank);
    const c = computeEvaluation(a, practicalFilters(x(), bank), context);
    expect(c.total).toBe(92);
    expect(c.confidence).toBe("High");
    expect(c.classification).toBe("Excellent");
    expect(c.eligibility).toBe("Eligible");
  });
  it("borderline example is 76, provisional and Stretch with the manageable-gap flag", () => {
    const a = fixtureAnchors("borderline");
    const p = x();
    p.salary = { min: null, max: null, basis: "NOT_STATED", currency: "USD" };
    const c = computeEvaluation(a, practicalFilters(p, bank), context);
    expect(c.total).toBe(76);
    expect(c.classification).toBe("Stretch");
    expect(c.confidence).toBe("Medium");
    expect(c.eligibility).toBe("Provisionally Eligible");
    expect(c.flags).toContain("PROMISING WITH ONE MANAGEABLE GAP");
  });
  it("Stretch takes precedence over the ordinary Strong score band", () => {
    const a = fixtureAnchors();
    a.gap_clusters = fixtureAnchors("borderline").gap_clusters;
    expect(
      computeEvaluation(a, practicalFilters(x(), bank), context).classification,
    ).toBe("Stretch");
  });
  it("negative example is Weak or Disqualified for a nonwaivable central requirement", () => {
    const a = fixtureAnchors("negative");
    expect(
      computeEvaluation(a, practicalFilters(x(), bank), context).classification,
    ).toBe("Weak");
    a.requirements = [
      {
        text: "Direct planner management mandatory",
        required: true,
        status: "Unmet",
        bank_ids: [],
        central: true,
        nonwaivable: true,
        exception_language: null,
      },
    ];
    expect(
      computeEvaluation(a, practicalFilters(x(), bank), context).classification,
    ).toBe("Disqualified");
  });
  it("rejects nonexistent citations and forbidden claims", () => {
    const a = fixtureAnchors();
    a.categories.product_ownership.bank_ids = ["missing"];
    expect(() => validateAnchors(a, bank)).toThrow("citation");
    a.categories.product_ownership.bank_ids = [bank.bullets[0].id];
    a.categories.product_ownership.candidate_claims = [
      "Shipped a production AI product",
    ];
    expect(() => validateAnchors(a, bank)).toThrow("guardrailed");
  });
  it("caps confidence after three reductions and caps weak core despite high totals", () => {
    const a = fixtureAnchors();
    a.seniority_inferable = false;
    const p = x();
    p.salary.max = null;
    const c = computeEvaluation(a, practicalFilters(p, bank), {
      ...context,
      official: false,
      aggregatorOnly: true,
      requiredPreferredDistinguished: false,
    });
    expect(c.confidence).toBe("Low");
    expect(c.classification).toBe("Possible");
    a.categories.core_responsibility.points = 17;
    expect(
      computeEvaluation(a, practicalFilters(x(), bank), context).classification,
    ).toBe("Weak");
  });
});
