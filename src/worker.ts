import "dotenv/config";
import cron from "node-cron";
import { z } from "zod";
import { enqueue, ingestAll } from "./lib/ingest";
import { exec, row, transaction, now } from "./lib/db";
import { evaluateJob, reorderCheck } from "./lib/pipeline";
import { generateWeeklyReport } from "./lib/quality";
type Queued = { id: string; kind: string; payload: string; attempts: number };
const timezone = process.env.TIMEZONE || "America/New_York";
if (
  !row(
    "SELECT id FROM quality_reports WHERE period>=?",
    new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10),
  )
)
  enqueue("quality_report", {});
cron.schedule("0 3 * * *", () => enqueue("ingest", {}), { timezone });
cron.schedule("0 7 * * 1", () => enqueue("quality_report", {}), { timezone });
let working = false;
async function tick() {
  if (working) return;
  working = true;
  try {
    exec(
      "UPDATE queue SET status='pending',locked_at=NULL WHERE status='running' AND locked_at<?",
      new Date(Date.now() - 15 * 60000).toISOString(),
    );
    const job = transaction(() => {
      const q = row<Queued>(
        "SELECT * FROM queue WHERE status='pending' AND run_after<=? ORDER BY created_at LIMIT 1",
        now(),
      );
      if (q)
        exec(
          "UPDATE queue SET status='running',locked_at=?,attempts=attempts+1 WHERE id=?",
          now(),
          q.id,
        );
      return q;
    });
    if (!job) return;
    try {
      if (job.kind === "ingest") await ingestAll();
      else if (job.kind === "quality_report") generateWeeklyReport();
      else if (job.kind === "evaluate") {
        const { jobId, reorderCheck: sampled } = z
          .object({
            jobId: z.string().uuid(),
            reorderCheck: z.boolean().default(false),
          })
          .parse(JSON.parse(job.payload));
        const result = await evaluateJob(jobId);
        if (result.stage === "evaluated" && sampled) {
          try {
            await reorderCheck(jobId, result.computed!.total);
          } catch (error) {
            exec(
              "INSERT INTO quality_checks(id,job_id,kind,result,created_at) VALUES(?,?,?,?,?)",
              crypto.randomUUID(),
              jobId,
              "reorder",
              JSON.stringify({ passed: false, error: String(error) }),
              now(),
            );
          }
        }
      } else throw Error("Unknown queue task");
      exec(
        "UPDATE queue SET status='complete',locked_at=NULL WHERE id=?",
        job.id,
      );
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const retryableEvaluation =
        job.kind === "evaluate" && /timeout|temporarily unavailable|connection/i.test(message);
      exec(
        "UPDATE queue SET status=?,error=?,locked_at=NULL,run_after=? WHERE id=?",
        (job.kind !== "evaluate" && job.attempts < 1) ||
          (retryableEvaluation && job.attempts < 2)
          ? "pending"
          : "failed",
        message,
        new Date(Date.now() + 60000 * (job.attempts + 1)).toISOString(),
        job.id,
      );
    }
  } finally {
    working = false;
  }
}
const timer = setInterval(
  () => void tick().catch((e) => console.error("Worker error:", e.message)),
  1500,
);
void tick();
console.log(`Worker ready. Daily ingestion at 03:00 ${timezone}.`);
for (const event of ["SIGINT", "SIGTERM"] as const)
  process.on(event, () => {
    clearInterval(timer);
    cron.getTasks().forEach((task) => task.stop());
    process.exit(0);
  });
