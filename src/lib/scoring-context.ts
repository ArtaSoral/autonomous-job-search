import { Bank } from "./bank";
import { normalize } from "./text";

const stopWords = new Set(
  "a an and are as at be by for from in is it its of on or that the to with you your will we our this these those have has role work team job experience years required preferred".split(
    " ",
  ),
);

function terms(text: string) {
  return new Set(
    normalize(text)
      .split(" ")
      .filter((word) => word.length > 2 && !stopWords.has(word)),
  );
}

function relevance(text: string, postingTerms: Set<string>) {
  const words = terms(text);
  let score = 0;
  for (const word of words) if (postingTerms.has(word)) score++;
  return score;
}

/**
 * Keeps final scoring grounded in the bank without sending the whole bank on
 * every request. Local validation still checks every returned citation against
 * the complete immutable bank.
 */
export function scoringContext(bank: Bank, posting: string) {
  const postingTerms = terms(posting);
  const bullets = bank.bullets
    .filter((bullet) => bullet.usable_in_generation)
    .map((bullet) => ({
      bullet,
      score: relevance(
        `${bullet.text} ${bullet.skill_ids.join(" ")} ${bullet.related_evidence.join(" ")}`,
        postingTerms,
      ),
    }))
    .sort((a, b) => b.score - a.score || a.bullet.id.localeCompare(b.bullet.id))
    .slice(0, 12)
    .map(({ bullet }) => bullet);
  const bulletIds = new Set(bullets.map((bullet) => bullet.id));
  const evidenceIds = new Set(bullets.flatMap((bullet) => bullet.related_evidence));
  const accomplishmentIds = new Set(bullets.map((bullet) => bullet.accomplishment_id));
  for (const accomplishment of bank.accomplishments)
    if (accomplishmentIds.has(accomplishment.id))
      for (const id of accomplishment.evidence_ids) evidenceIds.add(id);
  const roleIds = new Set(bullets.map((bullet) => bullet.role_id));
  const skillIds = new Set(bullets.flatMap((bullet) => bullet.skill_ids));
  for (const evidence of bank.evidence)
    if (evidenceIds.has(evidence.id))
      for (const id of evidence.skill_ids) skillIds.add(id);

  return {
    evidence_selection_note:
      "These are locally selected, potentially relevant bank records. Credit only the records that directly support the posting; report other needs as gaps or unknowns.",
    bullets: bullets.map((bullet) => ({
      id: bullet.id,
      text: bullet.text,
      role_id: bullet.role_id,
      accomplishment_id: bullet.accomplishment_id,
      skill_ids: bullet.skill_ids,
      related_evidence: bullet.related_evidence,
      variant_group: bullet.variant_group,
    })),
    evidence: bank.evidence
      .filter((evidence) => evidenceIds.has(evidence.id))
      .map(({ id, text, skill_ids }) => ({ id, text, skill_ids })),
    accomplishments: bank.accomplishments
      .filter((accomplishment) => accomplishmentIds.has(accomplishment.id))
      .map(({ id, role_id, bullet_ids, evidence_ids }) => ({
        id,
        role_id,
        bullet_ids: bullet_ids.filter((id) => bulletIds.has(id)),
        evidence_ids: evidence_ids.filter((id) => evidenceIds.has(id)),
      })),
    skills: bank.skills
      .filter((skill) => skillIds.has(skill.id))
      .map(({ id, name, aliases, evidence_level }) => ({
        id,
        name,
        aliases,
        evidence_level,
      })),
    strengths: bank.strengths
      .filter((strength) => strength.usable_in_generation)
      .filter((strength) => relevance(strength.text, postingTerms) > 0)
      .map(({ id, text, skill_ids }) => ({ id, text, skill_ids })),
    experience: bank.experience
      .filter((role) => roleIds.has(role.id))
      .map(({ id, title, company, display_start, display_end, is_current }) => ({
        id,
        title,
        company,
        display_start,
        display_end,
        is_current,
      })),
    // Every guardrail and practical constraint stays in every final review.
    guardrails: bank.guardrails.map(({ id, rule, evidence_ids }) => ({
      id,
      rule,
      evidence_ids,
    })),
    job_preferences: {
      target_titles: bank.job_preferences.target_titles,
      career_direction:
        bank.job_preferences.confirmed_constraints.career_direction,
      minimum_salary: bank.job_preferences.minimum_salary,
      employment_types: bank.job_preferences.employment_types,
    },
    education: bank.education.map(({ id, ...rest }) => ({ id, ...rest })),
    certifications: bank.certifications.map(({ id, ...rest }) => ({ id, ...rest })),
  };
}
