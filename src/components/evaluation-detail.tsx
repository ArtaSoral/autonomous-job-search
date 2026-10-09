import ActionForm from "./action-form";
import { latestEvaluation } from "@/lib/dashboard";
import { rows, row } from "@/lib/db";
import { reasonTags } from "@/lib/schemas";
export default function EvaluationDetail({ jobId }: { jobId: string }) {
  const e = latestEvaluation(jobId);
  const filters = row<{
    failed_rules: string;
    practical_eligibility: string;
    missing_fields: string;
    flags: string;
  }>("SELECT * FROM filter_results WHERE job_id=?", jobId);
  const triage = row<{ archetype: string; reason: string }>(
    "SELECT * FROM triage_results WHERE job_id=?",
    jobId,
  );
  return (
    <>
      <section className="panel">
        <h2>Fit evaluation</h2>
        <ActionForm
          action="evaluate"
          values={{ jobId }}
          label={e ? "Queue re-evaluation" : "Queue evaluation"}
        />
        <p className="muted">
          The worker processes evaluations. Input changes mark results stale and
          require an explicit re-evaluation.
        </p>
        {e && (
          <>
            <div className="row">
              <span className="score">{e.computed.total}/100</span>
              <span className="badge">{e.computed.classification}</span>
              <span className="badge">{e.computed.confidence} confidence</span>
              {!e.record.is_current && (
                <span className="badge warning">Stale</span>
              )}
            </div>
            <p>
              {e.computed.eligibility} · {e.computed.career_direction} ·
              Evidence coverage {Math.round(e.computed.coverage * 100)}%
            </p>
            {[
              ...e.computed.flags,
              ...e.computed.caps,
              ...e.computed.confidence_reductions,
            ].map((f, n) => (
              <p className="badge warning" key={n}>
                {f}
              </p>
            ))}
            <ul>
              {e.anchors.reasons.map((r, n) => (
                <li key={n}>{r}</li>
              ))}
            </ul>
            <p className="muted">
              {e.anchors.archetype} · {e.anchors.product_authority} · Primary
              user: {e.anchors.primary_user} · {e.anchors.product_type}
            </p>
          </>
        )}
        {!e && triage && (
          <p>
            {triage.archetype}: {triage.reason}
          </p>
        )}
        {filters && (
          <details>
            <summary>
              Practical filters: {filters.practical_eligibility}
            </summary>
            <pre>
              {JSON.stringify(
                {
                  failures: JSON.parse(filters.failed_rules),
                  missing: JSON.parse(filters.missing_fields),
                  flags: JSON.parse(filters.flags),
                },
                null,
                2,
              )}
            </pre>
          </details>
        )}
      </section>
      {e && (
        <>
          <section className="panel" id="ledger">
            <h2>Point ledger</h2>
            <p className="muted">
              Bank v{e.record.bank_version} · Spec v{e.record.spec_version} ·{" "}
              {e.record.created_at}
            </p>
            <table>
              <thead>
                <tr>
                  <th>Category</th>
                  <th>Points / weight</th>
                  <th>Posting evidence</th>
                  <th>Bank IDs & withheld points</th>
                </tr>
              </thead>
              <tbody>
                {e.computed.ledger.map((l) => (
                  <tr key={l.key}>
                    <td>{l.key.replaceAll("_", " ")}</td>
                    <td>
                      {l.points}/{l.weight}
                      <br />
                      Anchor {l.anchor}
                    </td>
                    <td>{l.posting_evidence.join(" · ")}</td>
                    <td>
                      {l.bank_ids.join(", ")}
                      <p className="muted">{l.withheld_reason}</p>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <section className="panel">
            <h2>Requirement review</h2>
            <table>
              <thead>
                <tr>
                  <th>Requirement</th>
                  <th>Level</th>
                  <th>Status</th>
                  <th>Evidence</th>
                </tr>
              </thead>
              <tbody>
                {e.anchors.requirements.map((r, n) => (
                  <tr key={n}>
                    <td>{r.text}</td>
                    <td>{r.required ? "Required" : "Preferred"}</td>
                    <td>{r.status}</td>
                    <td>{r.bank_ids.join(", ")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
          <div className="grid">
            <section className="panel">
              <h2>Gaps & warning signs</h2>
              {e.anchors.gap_clusters.map((g, n) => (
                <p key={n}>
                  {g.description} · {g.severity} ·{" "}
                  {g.manageable ? "Manageable" : "Not manageable"}
                  <br />
                  <span className="muted">{g.reason}</span>
                </p>
              ))}
              {e.anchors.warning_signs.map((w, n) => (
                <p key={n}>{w}</p>
              ))}
            </section>
            <section className="panel">
              <h2>Questions before applying</h2>
              {[
                ...e.anchors.missing_facts,
                ...e.anchors.questions_before_applying,
              ].map((q, n) => (
                <p key={n}>{q}</p>
              ))}
            </section>
          </div>
          <details className="panel">
            <summary>Full evaluation and provenance</summary>
            <pre>
              {JSON.stringify(JSON.parse(e.record.full_output), null, 2)}
            </pre>
          </details>
        </>
      )}
      <section className="panel">
        <h2>Your feedback</h2>
        <ActionForm
          action="feedback"
          values={{ jobId }}
          label="Record feedback"
        >
          <div className="row">
            <select name="thumb">
              <option value="up">Thumbs up</option>
              <option value="down">Thumbs down</option>
            </select>
            <select name="reason_tag">
              {reasonTags.map((t) => (
                <option key={t}>{t}</option>
              ))}
            </select>
            <input name="note" placeholder="Optional note" />
          </div>
        </ActionForm>
      </section>
      <section className="panel">
        <h2>Source history</h2>
        {rows(
          "SELECT source FROM job_sources WHERE job_id=? AND source=? LIMIT 1",
          jobId,
          "adzuna",
        ).length > 0 && (
          <a
            href="https://www.adzuna.com"
            target="_blank"
            rel="noreferrer"
            style={{
              display: "inline-block",
              minWidth: 116,
              minHeight: 23,
              fontSize: 20,
            }}
          >
            Adzuna
          </a>
        )}
        {rows<{
          source: string;
          url: string;
          first_seen: string;
          last_seen: string;
        }>("SELECT * FROM job_sources WHERE job_id=?", jobId).map((s, n) => (
          <p key={n}>
            <a href={s.url} target="_blank" rel="noreferrer">
              {s.source}
            </a>{" "}
            · First seen {s.first_seen} · Last seen {s.last_seen}
          </p>
        ))}
      </section>
    </>
  );
}
