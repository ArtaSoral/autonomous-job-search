import { z } from "zod";
import { rows, exec, uid, now } from "./db";
import { anchorsSchema } from "./evaluation";
import { computedSchema } from "./dashboard";
export const reportSchema = z.object({
  period: z.string(),
  generated_at: z.string(),
  excluded_sample: z.array(
    z.object({
      id: z.string(),
      employer: z.string(),
      title: z.string(),
      failed_rules: z.string(),
    }),
  ),
  reorder_tests: z.array(
    z.object({
      job_id: z.string().nullable(),
      result: z.record(z.string(), z.unknown()),
    }),
  ),
  distribution: z.record(z.string(), z.number()),
  missing_fields: z.record(z.string(), z.number()),
  extraction_errors: z.array(
    z.object({ job_id: z.string(), note: z.string(), created_at: z.string() }),
  ),
  calibration_review: z.array(
    z.object({ job_id: z.string(), reasons: z.array(z.string()) }),
  ),
});
export function generateWeeklyReport(date = new Date()) {
  const monday = new Date(date);
  monday.setUTCDate(date.getUTCDate() - ((date.getUTCDay() + 6) % 7));
  const period = monday.toISOString().slice(0, 10);
  const since = new Date(date.getTime() - 7 * 86400000).toISOString();
  const distribution: Record<string, number> = {};
  const missing: Record<string, number> = {};
  const calibration: { job_id: string; reasons: string[] }[] = [];
  for (const e of rows<{ job_id: string; anchors: string; computed: string }>(
    "SELECT * FROM evaluations WHERE is_current=1",
  )) {
    const a = anchorsSchema.parse(JSON.parse(e.anchors));
    const c = computedSchema.parse(JSON.parse(e.computed));
    const key = `${a.archetype} / ${c.classification}`;
    distribution[key] = (distribution[key] || 0) + 1;
    const reasons: string[] = [];
    if (c.total >= 78) {
      if (a.administrative_role_cap)
        reasons.push("High score with administrative role cap");
      if (a.categories.product_ownership.points < 6)
        reasons.push("High score with limited product authority");
      if (
        a.categories.workflow_automation.points >= 7 &&
        a.categories.core_responsibility.points < 22
      )
        reasons.push("Potential tool keyword inflation");
    }
    if (reasons.length) calibration.push({ job_id: e.job_id, reasons });
  }
  for (const f of rows<{ missing_fields: string }>(
    "SELECT missing_fields FROM filter_results",
  ))
    for (const field of z.array(z.string()).parse(JSON.parse(f.missing_fields)))
      missing[field] = (missing[field] || 0) + 1;
  const report = reportSchema.parse({
    period,
    generated_at: now(),
    excluded_sample: rows(
      "SELECT j.id,j.employer,j.title,f.failed_rules FROM jobs j JOIN filter_results f ON f.job_id=j.id WHERE f.passed=0 ORDER BY RANDOM() LIMIT 10",
    ),
    reorder_tests: rows<{ job_id: string | null; result: string }>(
      "SELECT job_id,result FROM quality_checks WHERE kind='reorder' AND created_at>=?",
      since,
    ).map((c) => ({ ...c, result: JSON.parse(c.result) })),
    distribution,
    missing_fields: missing,
    extraction_errors: rows(
      "SELECT job_id,note,created_at FROM feedback WHERE reason_tag='location or terms wrong' AND created_at>=?",
      since,
    ),
    calibration_review: calibration,
  });
  exec(
    "INSERT INTO quality_reports(id,period,content,created_at) VALUES(?,?,?,?) ON CONFLICT(period) DO UPDATE SET content=excluded.content,created_at=excluded.created_at",
    uid(),
    period,
    JSON.stringify(report),
    now(),
  );
  return report;
}
