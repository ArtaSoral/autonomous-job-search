import { z } from "zod";
import { exec, rows, row, now, uid, transaction } from "./db";
import { getJob } from "./postings";
import { latestEvaluation } from "./dashboard";
import { reasonTags } from "./schemas";
import { mkdirSync, writeFileSync } from "node:fs";
import { artifactDirectory } from "./storage";
import { join } from "node:path";
type Feedback = {
  id: string;
  job_id: string;
  thumb: string;
  reason_tag: string;
  note: string;
  features: string;
  classification_at_time: string | null;
  created_at: string;
};
export function recordFeedback(
  jobId: string,
  thumb: "up" | "down",
  reason: (typeof reasonTags)[number],
  note = "",
) {
  if (reason === "other" && !note.trim())
    throw Error("Include a note for Other feedback");
  const job = getJob(jobId);
  const features = z.array(z.string()).parse(JSON.parse(job.features));
  const classification =
    latestEvaluation(jobId)?.computed.classification || null;
  return transaction(() => {
    const id = uid();
    exec(
      "INSERT INTO feedback(id,job_id,thumb,reason_tag,note,classification_at_time,features,created_at) VALUES(?,?,?,?,?,?,?,?)",
      id,
      jobId,
      thumb,
      reason,
      note,
      classification,
      JSON.stringify(features),
      now(),
    );
    if (reason === "location or terms wrong") return id;
    for (const feature of features)
      exec(
        "INSERT INTO preference_signal(feature,weight,updated_at) VALUES(?,?,?) ON CONFLICT(feature) DO UPDATE SET weight=weight+excluded.weight,updated_at=excluded.updated_at",
        feature,
        thumb === "up" ? 1 : -1,
        now(),
      );
    const feedback = rows<Feedback>(
      "SELECT * FROM feedback WHERE reason_tag=?",
      reason,
    );
    for (const feature of features) {
      const matching = feedback.filter((f) =>
        z.array(z.string()).parse(JSON.parse(f.features)).includes(feature),
      );
      const ids = [...new Set(matching.map((f) => f.job_id))];
      if (ids.length >= 5) {
        const pattern = JSON.stringify({ feature, reason });
        const suggestedRules: Record<string, string> = {
          "great fit": `Add ${feature} to the responsibility patterns to prioritize for review within its capability classification. Keep practical terms and bank-evidence gates unchanged.`,
          "too administrative": `For ${feature}, add a triage review trigger when coordination, status reporting or routine administration account for at least 40% of recurring work. Require explicit authority over roadmap, prioritization, requirements or product outcomes before advancing.`,
          "wrong seniority": `For ${feature}, require explicit verification of decision authority, scope and day-one expectations before surfacing roles whose level cannot be inferred from responsibilities.`,
          "domain not interesting": `Treat ${feature} as a lower display priority within its capability classification, subject to confirmation that these examples represent the intended direction. Do not change capability points or practical eligibility.`,
          "not product work": `For ${feature}, require observable product decisions or workflow ownership to advance beyond triage; coordination or platform keywords alone are insufficient.`,
          other: `Add a manual review trigger for ${feature} based on the recorded notes from these examples; document a responsibility-based exception before changing a gate.`,
        };
        exec(
          "INSERT OR IGNORE INTO spec_change_proposals(id,pattern,example_job_ids,proposed_change) VALUES(?,?,?,?)",
          uid(),
          pattern,
          JSON.stringify(ids),
          `${ids.length} distinct jobs share ${feature} and feedback reason "${reason}". Proposed rule: ${suggestedRules[reason]} Capability weights remain unchanged.`,
        );
      }
    }
    return id;
  });
}
export function decideProposal(id: string, decision: "accepted" | "rejected") {
  const proposal = row<{
    id: string;
    status: string;
    proposed_change: string;
    pattern: string;
    example_job_ids: string;
  }>("SELECT * FROM spec_change_proposals WHERE id=?", id);
  if (!proposal) throw Error("Proposal not found");
  if (proposal.status !== "open")
    throw Error("Proposal has already been decided");
  const patch = `# Specification change proposal\nDate: ${now().slice(0, 10)}\nDecision: ${decision}\nPattern: ${proposal.pattern}\nExamples: ${proposal.example_job_ids}\n\n${proposal.proposed_change}\n\nDecision log row:\n| ${now().slice(0, 10)} | ${proposal.proposed_change.replaceAll("|", "/")} | ${decision} | User feedback on five or more distinct jobs |\n`;
  transaction(() => {
    exec(
      "UPDATE spec_change_proposals SET status=?,decided_at=? WHERE id=?",
      decision,
      now(),
      id,
    );
    exec(
      "INSERT INTO decision_log(id,proposal_id,decision,patch,created_at) VALUES(?,?,?,?,?)",
      uid(),
      id,
      decision,
      patch,
      now(),
    );
  });
  if (decision === "accepted") {
    const outputDirectory = artifactDirectory("exports");
    mkdirSync(outputDirectory, { recursive: true });
    writeFileSync(join(outputDirectory, `spec-proposal-${id}.md`), patch);
  }
  return patch;
}
