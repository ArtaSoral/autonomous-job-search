# Project scope

## Objective

Build a fully autonomous job-finding tool that discovers suitable roles on the web, evaluates them against the candidate's experience, and prepares job-specific resumes and cover letters.

## Confirmed scope

- Autonomous web discovery of relevant jobs.
- Matching against the candidate's documented experience.
- Customized resumes for selected jobs.
- Customized cover letters for selected jobs.

## Proposed foundations

- Preserve source URLs and retrieval times for job descriptions.
- Keep a traceable candidate evidence bank for tailoring documents.
- Explain match decisions and identify unsupported or missing qualifications.
- Tailor wording and emphasis while keeping claims grounded in candidate evidence.
- Deduplicate postings and keep generated documents associated with their jobs.
- Keep personal data and credentials outside version control.

## Details to define next

- Target roles, industries, seniority, geography, work arrangements, salary, and other constraints.
- Discovery sources, search frequency, and freshness checks.
- Match scoring, selection thresholds, and handling of incomplete postings.
- Resume and cover letter formats, templates, and quality checks.
- Runtime, model provider, budget, scheduling, and deployment.
- How results and generated documents are presented to the candidate.
- Whether application submission, recruiter outreach, and follow-up are included; these have not yet been requested.

## Starting data

The local candidate resume bank was copied from the existing `ai-job-application-bot` project. Review its experience and preferences before using it for autonomous decisions. The original project remains separate.
