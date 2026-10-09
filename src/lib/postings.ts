import { sha256 } from "./bank";
import { exec, now, row, rows, uid } from "./db";
import { extractionSchema, Extraction } from "./schemas";
import { callModel, ModelCall } from "./model";
import { registeredInputs } from "./inputs";
import { modelName } from "./openai-auth";
import { normalize } from "./text";
export type Job = {
  id: string;
  employer: string;
  title: string;
  description: string;
  canonical_url: string | null;
  apply_url: string | null;
  posting_hash: string;
  listing_status: string;
  aggregator_only: number;
  official_verified: number;
  location_text: string;
  requisition_id: string | null;
  posted_at: string | null;
  first_seen: string;
  last_seen: string;
  appearance_count: number;
  features: string;
  review_error: string | null;
};
export const getJob = (id: string) => {
  const j = row<Job>("SELECT * FROM jobs WHERE id=?", id);
  if (!j) throw Error("Job not found");
  return j;
};
export async function extractPosting(
  job: Job,
  model: ModelCall = callModel,
  signal?: AbortSignal,
) {
  const i = registeredInputs();
  const key = sha256(
    job.posting_hash + i.specHash + modelName(),
  );
  const cached = row<{ structured: string }>(
    "SELECT structured FROM extractions WHERE input_hash=? ORDER BY created_at DESC LIMIT 1",
    key,
  );
  const x = cached
    ? extractionSchema.parse(JSON.parse(cached.structured))
    : await model(
        "extract posting",
        extractionSchema,
        {
          posting: job.description,
          url: job.canonical_url,
          source_metadata: {
            employer:
              job.employer === "Awaiting extraction" ? null : job.employer,
            title: job.title === "New manual posting" ? null : job.title,
            location: job.location_text,
          },
          instructions:
            "Normalize states to USPS codes. Annualize hourly base salary only when explicit annual hours are supplied. Distinguish base from total pay. Include quoted triggering text in signal_evidence for every practical field or dealbreaker. Do not infer salary, employment type, or open status.",
        },
        {
          sections: [9, 12, 16, 22, 26],
          bank: { job_preferences: i.bank.job_preferences },
          signal,
        },
      );
  exec(
    "INSERT INTO extractions(id,job_id,model,input_hash,structured,created_at) VALUES(?,?,?,?,?,?)",
    uid(),
    job.id,
    modelName() || "injected",
    key,
    JSON.stringify(x),
    now(),
  );
  exec(
    "UPDATE jobs SET employer=?,normalized_employer=?,title=?,normalized_title=?,location_text=?,requisition_id=?,is_agency=? WHERE id=?",
    x.employer,
    normalize(x.employer),
    x.title,
    x.title.toLowerCase(),
    x.location.office_locations
      .map((o) => `${o.city}, ${o.state}`)
      .join("; ") || x.location.arrangement,
    x.requisition_id,
    x.is_agency ? 1 : 0,
    job.id,
  );
  return x;
}
export function currentExtraction(id: string): Extraction | undefined {
  const r = row<{ structured: string }>(
    "SELECT structured FROM extractions WHERE job_id=? ORDER BY created_at DESC LIMIT 1",
    id,
  );
  return r ? extractionSchema.parse(JSON.parse(r.structured)) : undefined;
}
export function addManualPosting(text: string, url?: string) {
  const id = uid();
  const t = now();
  exec(
    "INSERT INTO jobs(id,employer,title,normalized_title,canonical_url,apply_url,first_seen,last_seen,fingerprint,description,posting_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?)",
    id,
    "Awaiting extraction",
    "New manual posting",
    "new manual posting",
    url || null,
    url || null,
    t,
    t,
    sha256(text + (url || "")),
    text,
    sha256(text),
  );
  if (url)
    exec(
      "INSERT INTO job_sources(job_id,source,url,first_seen,last_seen) VALUES(?,?,?,?,?)",
      id,
      "manual",
      url,
      t,
      t,
    );
  return id;
}
export const allJobs = () =>
  rows<Job>("SELECT * FROM jobs ORDER BY first_seen DESC");
