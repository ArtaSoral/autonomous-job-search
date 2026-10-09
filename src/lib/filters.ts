import { Bank } from "./bank";
import { Extraction } from "./schemas";
export type Eligibility =
  "Eligible" | "Provisionally Eligible" | "Ineligible" | "Unresolved";
export type FilterResult = {
  passed: boolean;
  eligibility: Eligibility;
  failed_rules: {
    id: string;
    reason: string;
    posting_evidence: string;
    bank_field: string;
  }[];
  missing_fields: string[];
  flags: string[];
  exceptions: string[];
};
export function practicalFilters(
  x: Extraction,
  bank: Bank,
  listingStatus = "open",
): FilterResult {
  const p = bank.job_preferences;
  const failed: FilterResult["failed_rules"] = [];
  const missing: string[] = [];
  const flags: string[] = [];
  const exceptions: string[] = [];
  const fail = (id: string, reason: string, field: string) =>
    failed.push({
      id,
      reason,
      bank_field: field,
      posting_evidence:
        x.signal_evidence[id] ||
        x.signal_evidence[id.replace("db-", "")] ||
        x.signal_evidence[field] ||
        "Extracted posting signal; inspect original posting",
    });
  if (
    ["closed", "stale"].includes(listingStatus) ||
    (x.listing_status_text &&
      /^(?:closed|filled|expired|unavailable|no longer accepting applications)$/i.test(
        x.listing_status_text.trim(),
      ))
  )
    fail("listing-validity", "Listing is closed, expired or stale", "spec.26");
  const loc = x.location;
  if (
    loc.residency_states.length &&
    !loc.residency_states
      .map((s) => s.toUpperCase())
      .includes(p.location_rules.home_state)
  )
    fail(
      "residency",
      "Residency restrictions exclude the home state",
      "location_rules.home_state",
    );
  let arrangement = loc.arrangement;
  if (arrangement === "remote" && (loc.office_days_per_week || 0) > 0)
    arrangement = "hybrid";
  if (arrangement === "hybrid" || arrangement === "onsite") {
    const rules = p.location_rules[arrangement];
    if (!rules.allowed)
      fail("location", `${arrangement} is not allowed`, "location_rules");
    else if (!loc.office_locations.length) missing.push("office_location");
    else if (
      !loc.office_locations.some((o) =>
        rules.allowed_states.includes(o.state.toUpperCase()),
      )
    )
      fail(
        "location",
        "Office location falls outside allowed geography",
        `location_rules.${arrangement}.allowed_states`,
      );
  } else if (arrangement === "remote") {
    if (!p.location_rules.remote.allowed)
      fail("location", "Remote roles are not allowed", "location_rules.remote");
  } else missing.push("work_arrangement");
  if (loc.relocation_required)
    fail(
      "relocation",
      "The posting requires relocation",
      "location_rules.relocation",
    );
  if (
    x.salary.basis !== "base" ||
    x.salary.max === null ||
    x.salary.currency !== p.salary_currency
  ) {
    missing.push("base_salary");
    flags.push(
      "Base salary requires verification; bonus and equity do not count toward the floor",
    );
  } else if (x.salary.max < p.minimum_salary)
    fail(
      "salary",
      "Posted base range maximum is below the salary floor",
      "minimum_salary",
    );
  else if (x.salary.min === null || x.salary.min < p.minimum_salary)
    flags.push(
      "Salary range straddles the base floor; verify an offer meets the floor",
    );
  if (["NOT_STATED", "AMBIGUOUS"].includes(x.employment_type))
    missing.push("employment_type");
  else if (x.employment_type === "contract_to_hire") {
    if (!x.contract_to_hire_converts_at_hire)
      fail(
        "employment-type",
        "Contract-to-hire does not convert at hire",
        "employment_types",
      );
    else exceptions.push("Contract-to-hire converts to full-time at hire");
  } else if (
    !p.employment_types
      .map((t) => t.replaceAll("-", "_"))
      .includes(x.employment_type)
  )
    fail(
      "employment-type",
      "Employment type is not allowed",
      "employment_types",
    );
  const signals = x.dealbreaker_signals;
  const rules: Record<string, () => boolean> = {
    "db-defense": () => signals.defense_or_government_customers === "required",
    "db-agency": () =>
      x.is_agency &&
      !(
        x.client_hires_directly &&
        (x.employment_type === "full_time" ||
          (x.employment_type === "contract_to_hire" &&
            x.contract_to_hire_converts_at_hire === true))
      ),
    "db-scrum-master": () => signals.scrum_master_facilitation_share > 0.5,
    "db-pmo": () => signals.pmo_coordination_dominant,
    "db-people-management": () => signals.people_management_mandatory,
    "db-sales": () => signals.sales_primary_outcome,
    "db-consulting-delivery": () =>
      signals.consulting_delivery_without_ownership,
  };
  for (const d of p.structured_dealbreakers) {
    if (!rules[d.id])
      throw Error(
        `Unimplemented bank dealbreaker ${d.id}; review configuration before filtering`,
      );
    if (rules[d.id]()) fail(d.id, d.rule, `structured_dealbreakers.${d.id}`);
  }
  if (signals.security_clearance_required)
    fail("clearance", "Required security clearance is not evidenced", "spec.9");
  if (x.is_agency && x.employer_of_record === null)
    missing.push("employer_of_record");
  return {
    passed: !failed.length,
    eligibility: failed.length
      ? "Ineligible"
      : missing.length
        ? "Provisionally Eligible"
        : "Eligible",
    failed_rules: failed,
    missing_fields: [...new Set(missing)],
    flags,
    exceptions,
  };
}
