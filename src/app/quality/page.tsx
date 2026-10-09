import Link from "next/link";
import ActionForm from "@/components/action-form";
import { rows, row } from "@/lib/db";
import { reportSchema } from "@/lib/quality";
import { registeredInputs } from "@/lib/inputs";
export const dynamic = "force-dynamic";
export default function Quality() {
  const { bank } = registeredInputs();
  const report = row<{ content: string }>(
    "SELECT content FROM quality_reports ORDER BY created_at DESC LIMIT 1",
  );
  const data = report ? reportSchema.parse(JSON.parse(report.content)) : null;
  const proposals = rows<{
    id: string;
    proposed_change: string;
    status: string;
    pattern: string;
  }>("SELECT * FROM spec_change_proposals ORDER BY status");
  const questions = rows<{
    id: string;
    job_id: string;
    question: string;
    answer: string | null;
    status: string;
    draft: string | null;
  }>("SELECT * FROM bank_questions ORDER BY created_at DESC");
  return (
    <>
      <h1>Quality & feedback</h1>
      <p className="subtitle">
        Learn from your choices while keeping capability scores stable.
      </p>
      <section className="panel">
        <h2>Weekly quality report</h2>
        <ActionForm action="quality_report" label="Generate report now" />
        {data ? (
          <>
            <p className="muted">
              Week of {data.period} · Generated {data.generated_at}
            </p>
            <div className="grid">
              <div>
                <h3>Classification distribution</h3>
                {Object.entries(data.distribution).map(([key, count]) => (
                  <p key={key}>
                    {key}: {count}
                  </p>
                ))}
              </div>
              <div>
                <h3>Missing fields</h3>
                {Object.entries(data.missing_fields).map(([key, count]) => (
                  <p key={key}>
                    {key}: {count}
                  </p>
                ))}
              </div>
            </div>
            <h3>Filtered-out sample</h3>
            {data.excluded_sample.map((j) => (
              <p key={j.id}>
                <Link href={`/jobs/${j.id}`}>
                  {j.employer} · {j.title}
                </Link>
                <span className="muted"> {j.failed_rules}</span>
              </p>
            ))}
            <details>
              <summary>
                Reorder checks, calibration and extraction errors
              </summary>
              <pre>
                {JSON.stringify(
                  {
                    reorder: data.reorder_tests,
                    calibration: data.calibration_review,
                    extraction_errors: data.extraction_errors,
                  },
                  null,
                  2,
                )}
              </pre>
            </details>
          </>
        ) : (
          <p className="muted">
            The worker creates a report every Monday at 7:00 a.m. Generate one
            now to see current data.
          </p>
        )}
      </section>
      <section className="panel">
        <h2>Extraction review</h2>
        {rows<{ job_id: string; note: string; created_at: string }>(
          "SELECT job_id,note,created_at FROM feedback WHERE reason_tag='location or terms wrong' ORDER BY created_at DESC",
        ).map((f, n) => (
          <p key={n}>
            <Link href={`/jobs/${f.job_id}`}>Review posting</Link> ·{" "}
            {f.note || "Location or practical terms reported incorrect"} ·{" "}
            {f.created_at}
          </p>
        ))}
      </section>
      <section className="panel">
        <h2>Proposed specification changes</h2>
        <p className="muted">
          Patterns need feedback on at least five distinct jobs. Accepting
          exports a proposed text patch and records the decision; apply the
          patch to your specification and reload it when ready.
        </p>
        {proposals.length ? (
          proposals.map((p) => (
            <div className="line" key={p.id}>
              <p>{p.proposed_change}</p>
              <span className="badge">{p.status}</span>
              {p.status === "open" ? (
                <div className="row">
                  <ActionForm
                    action="proposal"
                    values={{ proposalId: p.id, decision: "accepted" }}
                    label="Accept & export patch"
                  />
                  <ActionForm
                    action="proposal"
                    values={{ proposalId: p.id, decision: "rejected" }}
                    label="Reject"
                  />
                </div>
              ) : (
                p.status === "accepted" && (
                  <p>
                    <a href={`/api/exports/spec-proposal-${p.id}.md`}>
                      Download proposed patch
                    </a>
                  </p>
                )
              )}
            </div>
          ))
        ) : (
          <p className="muted">No repeated patterns yet.</p>
        )}
      </section>
      <section className="panel">
        <h2>Bank questions</h2>
        {questions.length ? (
          questions.map((q) => (
            <div className="line" key={q.id}>
              <h3>{q.question}</h3>
              <span className="badge">{q.status}</span>
              {q.job_id && (
                <p>
                  <Link href={`/jobs/${q.job_id}`}>Related job</Link>
                </p>
              )}
              <ActionForm
                action="bank_answer"
                values={{ questionId: q.id }}
                label="Save answer & draft evidence"
              >
                <label>Role this answer belongs to</label>
                <select name="role_id">
                  {bank.experience.map((r) => (
                    <option key={r.id} value={r.id}>
                      {r.company} · {r.title}
                    </option>
                  ))}
                </select>
                <label>Team (optional)</label>
                <select name="team_id">
                  <option value="">Role-level / no team attribution</option>
                  {bank.experience.flatMap((r) =>
                    r.teams.map((t) => (
                      <option key={t.id} value={t.id}>
                        {r.company} · {t.name}
                      </option>
                    )),
                  )}
                </select>
                <label>Your factual answer</label>
                <textarea
                  name="answer"
                  required
                  defaultValue={q.answer || ""}
                />
              </ActionForm>
              {q.draft && (
                <>
                  <pre>{JSON.stringify(JSON.parse(q.draft), null, 2)}</pre>
                  <ActionForm
                    action="bank_export"
                    values={{ questionId: q.id, approved: true }}
                    label="Approve draft & export new bank"
                  >
                    <label>New bank version</label>
                    <input
                      name="version"
                      placeholder="3.4"
                      required
                      pattern="[0-9]+\.[0-9]+"
                    />
                  </ActionForm>
                  <p className="muted">
                    Exported banks pass the same integrity checks. Update
                    BANK_PATH in .env and restart to load an exported version.
                  </p>
                </>
              )}
            </div>
          ))
        ) : (
          <p className="muted">
            Questions appear when an evaluation identifies missing candidate
            evidence.
          </p>
        )}
      </section>
      <section className="panel">
        <h2>Worker queue</h2>
        {rows<{
          id: string;
          kind: string;
          status: string;
          error: string | null;
        }>("SELECT * FROM queue ORDER BY created_at DESC LIMIT 30").map((q) => (
          <p key={q.id}>
            {q.kind} · <span className="badge">{q.status}</span>
            {q.error && <span className="muted"> {q.error}</span>}
          </p>
        ))}
      </section>
    </>
  );
}
