import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { mkdirSync } from "node:fs";
import { jobProgress } from "../src/lib/progress";
import { exec, uid, transaction } from "../src/lib/db";
import { addManualPosting } from "../src/lib/postings";

beforeAll(() => {
  mkdirSync("data/tests", { recursive: true });
  process.env.DATABASE_PATH = `data/tests/progress-${process.pid}-${Date.now()}.sqlite`;
});
beforeEach(() => {
  for (const table of ["queue", "ingest_runs", "evaluations", "jobs"])
    exec(`DELETE FROM ${table}`);
});
function task(jobId: string, status: string, createdAt: string) {
  exec(
    "INSERT INTO queue(id,kind,payload,status,run_after,created_at) VALUES(?,?,?,?,?,?)",
    uid(),
    "evaluate",
    JSON.stringify({ jobId }),
    status,
    createdAt,
    createdAt,
  );
}
function evaluation(jobId: string, createdAt: string) {
  exec(
    "INSERT INTO evaluations(id,job_id,bank_version,spec_version,bank_hash,spec_hash,posting_hash,model,anchors,computed,full_output,created_at) VALUES(?,?,'fixture','fixture','fixture','fixture','fixture','fixture','{}','{}','{}',?)",
    uid(),
    jobId,
    createdAt,
  );
}
describe("Job search progress", () => {
  it("counts a large backlog quickly without counting historical retries twice", () => {
    transaction(() => {
      for (let n = 0; n < 2000; n++) {
        const id = addManualPosting(`Backlog fixture ${n}`);
        task(id, "failed", "2026-10-10T01:00:00Z");
        task(id, n % 2 ? "complete" : "pending", "2026-10-10T02:00:00Z");
      }
    });
    const start = performance.now();
    expect(jobProgress()).toMatchObject({
      totalJobs: 2000,
      scheduled: 2000,
      complete: 1000,
      pending: 1000,
      failed: 0,
    });
    expect(performance.now() - start).toBeLessThan(1500);
  });
  it("shows an empty queue without inventing a fetch", () => {
    expect(jobProgress()).toMatchObject({
      totalJobs: 0,
      scheduled: 0,
      pending: 0,
      running: 0,
      complete: 0,
      failed: 0,
      unqueued: 0,
      latestFetch: null,
      runningJobs: [],
    });
  });
  it("counts each job once using its latest task, including retried failures", () => {
    const retry = addManualPosting("Retried job");
    task(retry, "failed", "2026-10-10T01:00:00Z");
    task(retry, "pending", "2026-10-10T02:00:00Z");
    const running = addManualPosting("Running job");
    task(running, "running", "2026-10-10T02:00:00Z");
    const done = addManualPosting("Filtered-out job, no full score");
    task(done, "complete", "2026-10-10T02:00:00Z");
    const failed = addManualPosting("Failed job");
    task(failed, "failed", "2026-10-10T02:00:00Z");
    exec(
      "UPDATE queue SET error='Evaluation timed out' WHERE json_extract(payload,'$.jobId')=?",
      failed,
    );
    addManualPosting("Manual job not queued yet");
    expect(jobProgress()).toMatchObject({
      totalJobs: 5,
      scheduled: 4,
      pending: 1,
      running: 1,
      complete: 1,
      failed: 1,
      unqueued: 1,
      runningJobs: [{ id: running, status: "running" }],
      failedJobs: [
        { id: failed, status: "failed", error: "Evaluation timed out" },
      ],
    });
    expect(jobProgress().failedJobs).toHaveLength(1);
  });
  it("recognizes a newer successful direct evaluation but keeps queued re-evaluations waiting", () => {
    const recovered = addManualPosting("Recovered evaluation");
    task(recovered, "failed", "2026-10-10T01:00:00Z");
    evaluation(recovered, "2026-10-10T02:00:00Z");
    expect(jobProgress()).toMatchObject({ complete: 1, failed: 0 });
    task(recovered, "pending", "2026-10-10T03:00:00Z");
    expect(jobProgress()).toMatchObject({ complete: 0, pending: 1 });
  });
  it("shows a current review error even when an older queued task completed", () => {
    const id = addManualPosting(
      "Failed direct retry after an older completed task",
    );
    task(id, "complete", "2026-10-10T01:00:00Z");
    evaluation(id, "2026-10-10T02:00:00Z");
    exec(
      "UPDATE jobs SET review_error='Current evaluation timed out' WHERE id=?",
      id,
    );
    expect(jobProgress()).toMatchObject({
      complete: 0,
      failed: 1,
      failedJobs: [{ id, error: "Current evaluation timed out" }],
    });
    task(id, "pending", "2026-10-10T03:00:00Z");
    expect(jobProgress()).toMatchObject({ failed: 0, pending: 1 });
  });
  it("aggregates only the latest fetch, separating pulled postings from new jobs", () => {
    exec(
      "INSERT INTO queue(id,kind,payload,status,run_after,created_at) VALUES(?,'ingest','{}','complete',?,?)",
      uid(),
      "2026-10-10T03:00:00Z",
      "2026-10-10T03:00:00Z",
    );
    for (const [at, status, counts] of [
      ["2026-10-09T03:00:00Z", "success", { fetched: 999, created: 999 }],
      ["2026-10-10T03:01:00Z", "success", { fetched: 100, created: 10 }],
      ["2026-10-10T03:02:00Z", "success", { fetched: 50, created: 5 }],
      ["2026-10-10T03:03:00Z", "failed", {}],
    ] as const) {
      exec(
        "INSERT INTO ingest_runs(id,source,status,started_at,counts) VALUES(?,'fixture',?,?,?)",
        uid(),
        status,
        at,
        JSON.stringify(counts),
      );
    }
    expect(jobProgress().latestFetch).toMatchObject({
      status: "complete",
      pulled: 150,
      added: 15,
      finished: 3,
      failed: 1,
    });
    exec(
      "INSERT INTO queue(id,kind,payload,status,run_after,created_at) VALUES(?,'ingest','{}','pending',?,?)",
      uid(),
      "2026-10-11T03:00:00Z",
      "2026-10-11T03:00:00Z",
    );
    expect(jobProgress().latestFetch).toMatchObject({
      status: "pending",
      pulled: 0,
      added: 0,
      finished: 0,
      failed: 0,
    });
  });
});
