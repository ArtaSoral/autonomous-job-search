import "dotenv/config";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { loadInputs, sha256 } from "../src/lib/bank";
import { rows } from "../src/lib/db";
import { extractPosting, getJob } from "../src/lib/postings";
import { modelName } from "../src/lib/openai-auth";
import { extractionSchema } from "../src/lib/schemas";
import {
  generateDocumentDrafts,
  renderDocx,
  DocumentRecord,
} from "../src/lib/documents";
import { callModel, type ModelCall } from "../src/lib/model";

// Uses the configured models, saved postings, and current evaluation threshold.
// Drafts stay in the audit directory; approval and application records stay intact.
async function main() {
  const [label = "review", ...args] = process.argv.slice(2);
  const reuse = args
    .find((arg) => arg.startsWith("--ranks-from="))
    ?.slice("--ranks-from=".length);
  if (reuse && !/^[a-z0-9-]+$/i.test(reuse))
    throw Error("Use a simple ranking source label");
  const reviewStale = args.includes("--review-stale");
  const jobIds = args.filter(
    (arg) => !arg.startsWith("--ranks-from=") && arg !== "--review-stale",
  );
  if (reviewStale && !jobIds.length)
    throw Error("Stale-evaluation review requires explicit job IDs");
  if (!/^[a-z0-9-]+$/i.test(label)) throw Error("Use a simple audit label");
  const directory = resolve("data/diagnostics/resume-audit", label);
  mkdirSync(directory, { recursive: true });
  const { bank, bankHash, specHash } = loadInputs();
  const candidates = rows<{
    id: string;
    score: number;
    classification: string;
    evaluation_current: number;
    evaluated_posting_hash: string;
  }>(
    `SELECT j.id, e.is_current AS evaluation_current, e.posting_hash AS evaluated_posting_hash, json_extract(e.computed,'$.total') AS score,
      json_extract(e.computed,'$.classification') AS classification
      FROM jobs j JOIN evaluations e ON e.job_id=j.id
      JOIN filter_results f ON f.job_id=j.id
      WHERE ((e.is_current=1 AND e.posting_hash=j.posting_hash) OR ?=1)
      AND e.bank_hash=? AND e.spec_hash=? AND f.passed=1
      AND e.id=(SELECT latest.id FROM evaluations latest WHERE latest.job_id=j.id ORDER BY latest.created_at DESC LIMIT 1)
      AND json_extract(e.computed,'$.total')>=?
      AND json_extract(e.computed,'$.classification') NOT IN ('Weak','Disqualified')
      ORDER BY score DESC`,
    reviewStale ? 1 : 0,
    bankHash,
    specHash,
    bank.job_preferences.match_score_threshold,
  );
  const chosen = jobIds.length
    ? jobIds.map((id) => {
        const candidate = candidates.find((job) => job.id === id);
        if (!candidate)
          throw Error(`Job ${id} does not pass the current evaluation`);
        return candidate;
      })
    : candidates.slice(0, 3);
  if (!chosen.length)
    throw Error("No jobs pass the current evaluation threshold");
  writeFileSync(join(directory, "bank.json"), JSON.stringify(bank, null, 2));
  const results: unknown[] = [];
  for (const candidate of chosen) {
    const job = getJob(candidate.id);
    // The most recent extraction can describe an older posting. Reuse only the
    // exact posting/spec/model cache entry, including in historical reviews.
    const saved = rows<{ structured: string }>(
      "SELECT structured FROM extractions WHERE job_id=? AND input_hash=? ORDER BY created_at DESC LIMIT 1",
      job.id,
      sha256(job.posting_hash + specHash + modelName()),
    )[0];
    const extraction = saved
      ? extractionSchema.parse(JSON.parse(saved.structured))
      : await extractPosting(job);
    const stem = `${job.employer}-${job.title}`
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .slice(0, 95);
    writeFileSync(
      join(directory, `${stem}-input.json`),
      JSON.stringify({ job, evaluation: candidate, extraction }, null, 2),
    );
    console.log(
      `Generating ${job.employer}: ${job.title} (${candidate.evaluation_current ? "" : "historical "}${candidate.score}, ${candidate.classification})`,
    );
    try {
      const trace: unknown[] = [];
      const auditModel: ModelCall = async (task, schema, data, options) => {
        const started = Date.now();
        try {
          let output;
          if (reuse && task === "rank usable bullets for relevance") {
            const previousDirectory = resolve(
              "data/diagnostics/resume-audit",
              reuse,
            );
            const previous = JSON.parse(
              readFileSync(join(previousDirectory, `${stem}.json`), "utf8"),
            );
            const previousInput = JSON.parse(
              readFileSync(
                join(previousDirectory, `${stem}-input.json`),
                "utf8",
              ),
            );
            if (
              previous.provenance.bank_hash !== bankHash ||
              previous.provenance.spec_hash !== specHash ||
              previousInput.job.posting_hash !== job.posting_hash
            )
              throw Error("Saved rankings do not match current inputs");
            const previousTrace = JSON.parse(
              readFileSync(
                join(previousDirectory, `${stem}-trace.json`),
                "utf8",
              ),
            ) as { task: string; output: unknown }[];
            output = schema.parse(
              previousTrace.find((entry) => entry.task === task)?.output,
            );
            await options?.validate?.(output);
          } else {
            output = await callModel(task, schema, data, options);
          }
          trace.push({
            task,
            input: data,
            output,
            durationMs: Date.now() - started,
            ...(reuse && task === "rank usable bullets for relevance"
              ? { reusedFrom: reuse }
              : {}),
          });
          return output;
        } catch (error) {
          trace.push({
            task,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        } finally {
          writeFileSync(
            join(directory, `${stem}-trace.json`),
            JSON.stringify(trace, null, 2),
          );
        }
      };
      const generated = await generateDocumentDrafts(
        job,
        auditModel,
        extraction,
      );
      writeFileSync(
        join(directory, `${stem}.json`),
        JSON.stringify(generated, null, 2),
      );
      const record = {
        kind: "resume",
        content: JSON.stringify(generated.resume),
      } as DocumentRecord;
      writeFileSync(
        join(directory, `${stem}.docx`),
        await renderDocx(bank, record, job.employer, job.title),
      );
      const markdown = [
        `# ${bank.contact.full_name}`,
        `Audit draft for ${job.title} at ${job.employer}`,
        "## Summary",
        ...generated.resume.summary.map(
          (line) => `${line.text}\n\nSources: ${line.source_ids.join(", ")}`,
        ),
        "## Experience",
        ...bank.experience.flatMap((role) => {
          const lines = generated.resume.experience.filter((line) =>
            bank.bullets.some(
              (bullet) =>
                bullet.id === line.source_ids[0] && bullet.role_id === role.id,
            ),
          );
          if (!lines.length) return [];
          const teams = [...role.teams].sort(
            (a, b) =>
              Number(b.display_end === "Present") -
                Number(a.display_end === "Present") ||
              Date.parse(b.display_start) - Date.parse(a.display_start),
          );
          return [
            `### ${role.title} | ${role.company}`,
            `${role.display_start} – ${role.display_end}`,
            ...[null, ...teams.map((team) => team.id)].flatMap((teamId) => {
              const group = lines.filter(
                (line) =>
                  bank.bullets.find(
                    (bullet) => bullet.id === line.source_ids[0],
                  )?.team_id === teamId,
              );
              if (!group.length) return [];
              const team = teams.find((team) => team.id === teamId);
              return [
                ...(team
                  ? [
                      `#### ${team.name}`,
                      `${team.display_start} – ${team.display_end}`,
                    ]
                  : []),
                ...group.map(
                  (line) =>
                    `- ${line.text}\n  Sources: ${line.source_ids.join(", ")}`,
                ),
              ];
            }),
          ];
        }),
        "## Skills",
        generated.resume.skill_ids
          .map((id) => bank.skills.find((skill) => skill.id === id)?.name)
          .join(" · "),
        "## Education",
        ...bank.education.map(
          (item) =>
            `${item.degree} | ${item.institution} | ${item.graduation_date}`,
        ),
        "## Certifications",
        ...bank.certifications.map(
          (item) => `${item.name} | ${item.issuer} | ${item.date}`,
        ),
        "## Verification",
        JSON.stringify(generated.resumeFlags, null, 2),
      ].join("\n\n");
      writeFileSync(join(directory, `${stem}.md`), markdown);
      results.push({
        ...candidate,
        employer: job.employer,
        title: job.title,
        stem,
        durationMs: generated.durationMs,
        resumeFlags: generated.resumeFlags,
        coverFlags: generated.coverFlags,
        summaryWords: generated.resume.summary
          .map((line) => line.text)
          .join(" ")
          .trim()
          .split(/\s+/).length,
        experienceBullets: generated.resume.experience.length,
        skillCount: generated.resume.skill_ids.length,
      });
      console.log(
        `Saved ${stem}; ${generated.resume.experience.length} bullets, ${generated.resumeFlags.length} resume flags, ${generated.coverFlags.length} cover flags`,
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      results.push({ ...candidate, error: message });
      console.error(message);
      process.exitCode = 1;
    }
    writeFileSync(
      join(directory, "results.json"),
      JSON.stringify(results, null, 2),
    );
  }
}
main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
