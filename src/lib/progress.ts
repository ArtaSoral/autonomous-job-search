import { now, row, rows } from "./db";

export function jobProgress() {
  const states = rows<{
    id: string;
    employer: string;
    title: string;
    error: string | null;
    status: "pending" | "running" | "complete" | "failed" | "unqueued";
  }>(`
    WITH tasks AS (
      SELECT *, json_extract(payload,'$.jobId') AS job_id, ROW_NUMBER() OVER (
        PARTITION BY json_extract(payload,'$.jobId')
        ORDER BY created_at DESC, rowid DESC
      ) AS position FROM queue WHERE kind='evaluate'
    ), results AS (
      SELECT *, ROW_NUMBER() OVER (
        PARTITION BY job_id ORDER BY created_at DESC, rowid DESC
      ) AS position FROM evaluations
    )
    SELECT j.id,j.employer,j.title,COALESCE(q.error,j.review_error) AS error,
      CASE
        WHEN q.status IN ('pending','running') THEN q.status
        WHEN e.is_current=1 AND j.review_error IS NULL
          AND (q.id IS NULL OR e.created_at>=q.created_at) THEN 'complete'
        ELSE COALESCE(q.status,CASE WHEN e.id IS NOT NULL THEN 'complete' ELSE 'unqueued' END)
      END AS status
    FROM jobs j
    LEFT JOIN tasks q ON q.job_id=j.id AND q.position=1
    LEFT JOIN results e ON e.job_id=j.id AND e.position=1
  `);
  const counts = {
    pending: 0,
    running: 0,
    complete: 0,
    failed: 0,
    unqueued: 0,
  };
  for (const job of states) counts[job.status]++;
  const latestFetch = row<{
    id: string;
    status: "pending" | "running" | "complete" | "failed";
    created_at: string;
  }>(
    "SELECT id,status,created_at FROM queue WHERE kind='ingest' ORDER BY created_at DESC,rowid DESC LIMIT 1",
  );
  const fetched = latestFetch
    ? row<{
        pulled: number;
        added: number;
        finished: number;
        failed: number;
        startedAt: string | null;
      }>(
        `
        SELECT COALESCE(SUM(CAST(json_extract(counts,'$.fetched') AS INTEGER)),0) AS pulled,
          COALESCE(SUM(CAST(json_extract(counts,'$.created') AS INTEGER)),0) AS added,
          COUNT(CASE WHEN status IN ('success','failed') THEN 1 END) AS finished,
          COUNT(CASE WHEN status='failed' THEN 1 END) AS failed,
          MIN(started_at) AS startedAt
        FROM ingest_runs WHERE started_at>=?
      `,
        latestFetch.created_at,
      )!
    : null;
  return {
    updatedAt: now(),
    totalJobs: states.length,
    scheduled: states.length - counts.unqueued,
    ...counts,
    runningJobs: states.filter((job) => job.status === "running"),
    failedJobs: states.filter((job) => job.status === "failed"),
    latestFetch: latestFetch && fetched ? { ...latestFetch, ...fetched } : null,
  };
}
