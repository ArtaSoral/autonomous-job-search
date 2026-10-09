import { sha256 } from "./bank";
import { exec, row, rows, transaction, now, uid } from "./db";
import {
  Posting,
  Company,
  fetchCompany,
  fetchAggregator,
  buildQueries,
} from "./sources";
import { Job } from "./postings";
import { registeredInputs } from "./inputs";
import { normalize } from "./text";
export { normalize } from "./text";
export function similarity(a: string, b: string) {
  const words = (text: string) => normalize(text).split(" ").filter(Boolean);
  const shingles = (text: string) => {
    const w = words(text);
    return new Set(
      w.length < 3
        ? w
        : w.slice(0, -2).map((_, i) => w.slice(i, i + 3).join(" ")),
    );
  };
  const x = shingles(a),
    y = shingles(b);
  if (!x.size || !y.size) return 0;
  return (2 * [...x].filter((s) => y.has(s)).length) / (x.size + y.size);
}
export function isDuplicate(
  a: {
    employer: string;
    title: string;
    location: string;
    requisitionId: string | null;
    url?: string;
  },
  b: {
    employer: string;
    title: string;
    location: string;
    requisitionId: string | null;
    url?: string;
  },
  score: number,
) {
  if (normalize(a.employer) !== normalize(b.employer)) return false;
  if (a.requisitionId && a.requisitionId === b.requisitionId) return true;
  if (a.url && a.url === b.url) return true;
  return (
    score >= 0.92 ||
    (normalize(a.title) === normalize(b.title) &&
      normalize(a.location) === normalize(b.location) &&
      score >= 0.85)
  );
}
export function ingestPosting(p: Posting) {
  const time = now();
  return transaction(() => {
    exec(
      "INSERT INTO raw_postings(id,source,source_job_id,url,fetched_at,payload,payload_hash) VALUES(?,?,?,?,?,?,?)",
      uid(),
      p.source,
      p.sourceId,
      p.url,
      time,
      JSON.stringify(p.payload),
      sha256(JSON.stringify(p.payload)),
    );
    const known = row<Job>(
      "SELECT j.* FROM jobs j JOIN job_sources s ON s.job_id=j.id WHERE s.source=? AND s.url=? LIMIT 1",
      p.source,
      p.url,
    );
    const candidates = known
      ? [known]
      : rows<Job>(
          "SELECT * FROM jobs WHERE normalized_employer=?",
          normalize(p.employer),
        );
    const match =
      known ||
      candidates.find((j) =>
        isDuplicate(
          {
            employer: p.employer,
            title: p.title,
            location: p.location,
            requisitionId: p.requisitionId,
            url: p.url,
          },
          {
            employer: j.employer,
            title: j.title,
            location: j.location_text,
            requisitionId: j.requisition_id,
            url: j.canonical_url || undefined,
          },
          similarity(p.description, j.description),
        ),
      );
    const id = match?.id || uid();
    const fingerprint = sha256(
      [
        normalize(p.employer),
        normalize(p.title),
        normalize(p.location),
        p.requisitionId || "",
        p.url,
      ].join("|"),
    );
    const hash = sha256(p.description);
    if (match) {
      const prefer = p.official || !match.official_verified;
      const changed = prefer && match.posting_hash !== hash;
      exec(
        "UPDATE jobs SET last_seen=?,appearance_count=appearance_count+1 WHERE id=?",
        time,
        id,
      );
      if (prefer) {
        exec(
          "UPDATE jobs SET employer=?,title=?,normalized_title=?,location_text=?,requisition_id=COALESCE(?,requisition_id),canonical_url=?,apply_url=?,description=?,posting_hash=?,aggregator_only=?,official_verified=?,listing_status=?,posted_at=COALESCE(?,posted_at) WHERE id=?",
          p.employer,
          p.title,
          normalize(p.title),
          p.location,
          p.requisitionId,
          p.url,
          p.applyUrl,
          p.description,
          hash,
          p.official ? 0 : match.aggregator_only,
          p.official ? 1 : match.official_verified,
          p.official ? "open" : match.listing_status,
          p.postedAt,
          id,
        );
      }
      if (changed) {
        exec("UPDATE evaluations SET is_current=0 WHERE job_id=?", id);
        exec(
          "UPDATE jobs SET material_changes=? WHERE id=?",
          JSON.stringify([
            { at: time, previous_hash: match.posting_hash, new_hash: hash },
          ]),
          id,
        );
      }
    } else {
      exec(
        "INSERT INTO jobs(id,employer,title,normalized_title,location_text,requisition_id,canonical_url,apply_url,posted_at,first_seen,last_seen,listing_status,fingerprint,aggregator_only,official_verified,description,posting_hash) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)",
        id,
        p.employer,
        p.title,
        normalize(p.title),
        p.location,
        p.requisitionId,
        p.url,
        p.applyUrl,
        p.postedAt,
        time,
        time,
        p.official ? "open" : "unverified",
        fingerprint,
        p.official ? 0 : 1,
        p.official ? 1 : 0,
        p.description,
        hash,
      );
      enqueue("evaluate", { jobId: id });
    }
    if (p.official)
      exec(
        "UPDATE jobs SET last_verified_at=?,normalized_employer=? WHERE id=?",
        time,
        normalize(p.employer),
        id,
      );
    else if (!match)
      exec(
        "UPDATE jobs SET normalized_employer=? WHERE id=?",
        normalize(p.employer),
        id,
      );
    exec(
      "INSERT INTO job_sources(job_id,source,url,first_seen,last_seen) VALUES(?,?,?,?,?) ON CONFLICT(job_id,source,url) DO UPDATE SET last_seen=excluded.last_seen",
      id,
      p.source,
      p.url,
      time,
      time,
    );
    return { id, created: !match };
  });
}
export function enqueue(kind: string, payload: unknown) {
  const serialized = JSON.stringify(payload);
  if (
    kind === "evaluate" &&
    payload &&
    typeof payload === "object" &&
    "jobId" in payload &&
    row(
      "SELECT id FROM queue WHERE kind='evaluate' AND json_extract(payload,'$.jobId')=? AND status IN ('pending','running')",
      String(payload.jobId),
    )
  )
    return;
  if (
    row(
      "SELECT id FROM queue WHERE kind=? AND payload=? AND status IN ('pending','running')",
      kind,
      serialized,
    )
  )
    return;
  exec(
    "INSERT INTO queue(id,kind,payload,run_after,created_at) VALUES(?,?,?,?,?)",
    uid(),
    kind,
    serialized,
    now(),
    now(),
  );
}
export async function isolatedRun(
  source: string,
  fetcher: () => Promise<Posting[]>,
) {
  const id = uid();
  exec(
    "INSERT INTO ingest_runs(id,started_at,source,status) VALUES(?,?,?,?)",
    id,
    now(),
    source,
    "running",
  );
  try {
    const postings = await fetcher();
    let created = 0;
    const createdIds: string[] = [];
    for (const p of postings) {
      const result = ingestPosting(p);
      if (result.created) {
        created++;
        createdIds.push(result.id);
      }
    }
    const shuffled = [...createdIds];
    for (let n = shuffled.length - 1; n > 0; n--) {
      const pick = Math.floor(Math.random() * (n + 1));
      [shuffled[n], shuffled[pick]] = [shuffled[pick], shuffled[n]];
    }
    const sample = shuffled.slice(0, Math.ceil(createdIds.length * 0.1));
    for (const jobId of sample)
      exec(
        "UPDATE queue SET payload=? WHERE kind='evaluate' AND json_extract(payload,'$.jobId')=? AND status='pending'",
        JSON.stringify({ jobId, reorderCheck: true }),
        jobId,
      );
    exec(
      "UPDATE ingest_runs SET finished_at=?,status=?,counts=? WHERE id=?",
      now(),
      "success",
      JSON.stringify({
        fetched: postings.length,
        created,
        updated: postings.length - created,
      }),
      id,
    );
    return { ok: true, postings };
  } catch (e) {
    exec(
      "UPDATE ingest_runs SET finished_at=?,status=?,errors=? WHERE id=?",
      now(),
      "failed",
      JSON.stringify([e instanceof Error ? e.message : String(e)]),
      id,
    );
    return { ok: false, postings: [] };
  }
}
export async function ingestAll() {
  const i = registeredInputs();
  const companies = rows<Company>("SELECT * FROM companies WHERE active=1");
  for (const company of companies) {
    const result = await isolatedRun(
      `${company.ats}:${company.board_token}`,
      () => fetchCompany(company),
    );
    if (result.ok) {
      const urls = new Set(result.postings.map((p) => p.url));
      for (const job of rows<{ id: string; canonical_url: string }>(
        "SELECT DISTINCT j.id,j.canonical_url FROM jobs j JOIN job_sources s ON s.job_id=j.id WHERE s.source=? AND j.official_verified=1",
        company.ats,
      )) {
        if (
          job.canonical_url.includes(`/${company.board_token}/`) &&
          !urls.has(job.canonical_url)
        )
          exec("UPDATE jobs SET listing_status='closed' WHERE id=?", job.id);
      }
    }
  }
  const cap = Math.max(0, Number(process.env.AGGREGATOR_DAILY_REQUESTS || 0));
  const date = now().slice(0, 10);
  const used = row<{ n: number }>(
    "SELECT COUNT(*) n FROM ingest_runs WHERE source LIKE 'aggregator:%' AND started_at>=?",
    date + "T00:00:00.000Z",
  )!.n;
  let remaining = Math.max(0, cap - used);
  const queries = buildQueries(i.bank, i.spec);
  const responsibilityQueries = queries.filter((q) => q.responsibilityBased);
  const titleQueries = queries.filter((q) => !q.responsibilityBased);
  const offset = row<{ n: number }>(
    "SELECT COUNT(*) n FROM ingest_runs WHERE source LIKE 'aggregator:%'",
  )!.n;
  for (let n = 0; remaining > 0 && n < queries.length; n++) {
    const group = n % 2 === 0 ? responsibilityQueries : titleQueries;
    const q = group[Math.floor((n + offset) / 2) % group.length];
    for (const source of ["jsearch", "adzuna"] as const) {
      if (remaining <= 0) break;
      if (
        (source === "jsearch" && !process.env.JSEARCH_API_KEY) ||
        (source === "adzuna" &&
          (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY))
      )
        continue;
      remaining--;
      await isolatedRun(
        `aggregator:${source}:${q.responsibilityBased ? "responsibility" : "title"}`,
        () => fetchAggregator(source, q.text),
      );
    }
  }
  exec(
    "UPDATE jobs SET listing_status='stale' WHERE listing_status<>'closed' AND ((official_verified=0 AND COALESCE(posted_at,first_seen) < ?) OR (official_verified=1 AND COALESCE(last_verified_at,first_seen) < ?))",
    new Date(Date.now() - 30 * 86400000).toISOString(),
    new Date(Date.now() - 30 * 86400000).toISOString(),
  );
}
