import Link from "next/link";
import ActionForm from "@/components/action-form";
import { dashboardJobs } from "@/lib/dashboard";
import { registeredInputs } from "@/lib/inputs";
import { currentExtraction } from "@/lib/postings";
import { rows } from "@/lib/db";
import { reasonTags } from "@/lib/schemas";
export const dynamic = "force-dynamic";
export default async function Home({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const p = await searchParams;
  const { bank } = registeredInputs();
  const jobs = dashboardJobs({
    showHidden: p.hidden === "on",
    threshold: p.threshold ? Number(p.threshold) : undefined,
  });
  const page = Math.max(1, Math.floor(Number(p.page) || 1));
  const visibleJobs = jobs.slice((page - 1) * 50, page * 50);
  const questions = rows<{ id: string; question: string }>(
    "SELECT id,question FROM bank_questions WHERE status='open' LIMIT 5",
  );
  return (
    <>
      <div className="row spread">
        <div>
          <h1>Your next chapter</h1>
          <p className="subtitle">
            Evidence-backed opportunities, thoughtfully ranked.
          </p>
        </div>
        <Link className="button" href="/jobs/new">
          + Add a job
        </Link>
      </div>
      <div className="grid">
        <section className="panel">
          <div className="muted">IN YOUR SHORTLIST</div>
          <p className="score">
            {
              jobs.filter((j) =>
                ["Excellent", "Strong", "Provisional Strong"].includes(
                  j.classification,
                ),
              ).length
            }
          </p>
        </section>
        <section className="panel">
          <div className="muted">OPPORTUNITIES TO EXPLORE</div>
          <p className="score">{jobs.length}</p>
        </section>
        <section className="panel">
          <div className="muted">BANK QUESTIONS</div>
          <p className="score">{questions.length}</p>
          <Link href="/quality">Review questions →</Link>
        </section>
      </div>
      <form className="row panel">
        <label>
          Minimum score{" "}
          <input
            type="number"
            name="threshold"
            min="0"
            max="100"
            defaultValue={
              p.threshold || bank.job_preferences.match_score_threshold
            }
            style={{ width: 75 }}
          />
        </label>
        <label>
          <input
            type="checkbox"
            name="hidden"
            defaultChecked={p.hidden === "on"}
          />{" "}
          Show Weak, Disqualified and below-cutoff roles
        </label>
        <button>Apply filters</button>
      </form>
      <ActionForm
        action="reevaluate_stale"
        label="Queue stale jobs for re-evaluation"
      />
      <div style={{ marginTop: 22 }}>
        {jobs.length ? (
          visibleJobs.map((j) => {
            const x = currentExtraction(j.id);
            const hasAdzuna =
              rows<{ source: string }>(
                "SELECT source FROM job_sources WHERE job_id=? AND source=? LIMIT 1",
                j.id,
                "adzuna",
              ).length > 0;
            return (
              <article className="card" key={j.id}>
                <div className="row spread">
                  <div>
                    <div className="muted">{j.employer}</div>
                    <h2>
                      <Link href={`/jobs/${j.id}`}>{j.title}</Link>
                    </h2>
                  </div>
                  <div>
                    <span className="badge">{j.classification}</span>
                    {j.stale && (
                      <span className="badge warning">Stale evaluation</span>
                    )}
                    {j.computed && (
                      <Link
                        href={`/jobs/${j.id}#ledger`}
                        className="score"
                        style={{ display: "block", marginTop: 12 }}
                      >
                        {j.computed.total}
                        <span className="muted"> / 100</span>
                      </Link>
                    )}
                  </div>
                </div>
                <p className="muted">
                  {j.location_text} ·{" "}
                  {x?.location.arrangement || "Arrangement not stated"} ·{" "}
                  {x?.salary.basis === "base" && x.salary.max
                    ? `${x.salary.currency} ${x.salary.min?.toLocaleString() || "?"}–${x.salary.max.toLocaleString()} base`
                    : "Salary requires verification"}
                </p>
                {hasAdzuna && (
                  <a
                    href="https://www.adzuna.com"
                    style={{
                      display: "inline-block",
                      minWidth: 116,
                      minHeight: 23,
                      fontSize: 20,
                    }}
                    target="_blank"
                    rel="noreferrer"
                  >
                    Adzuna
                  </a>
                )}
                {j.computed && (
                  <div className="row">
                    <span className="badge">
                      {j.computed.confidence} confidence
                    </span>
                    <span className="badge">{j.computed.eligibility}</span>
                    <span className="badge">{j.computed.career_direction}</span>
                  </div>
                )}
                {j.anchors && (
                  <ul>
                    {j.anchors.reasons.map((r, n) => (
                      <li key={n}>{r}</li>
                    ))}
                  </ul>
                )}
                {j.review_error && (
                  <p className="error">Review needed: {j.review_error}</p>
                )}
                {j.adjustment !== 0 && (
                  <p className="muted" title={j.preferenceReasons.join("\n")}>
                    Display preference: {j.adjustment > 0 ? "+" : ""}
                    {j.adjustment} points within this classification
                  </p>
                )}
                <div className="row">
                  <Link className="button" href={`/jobs/${j.id}`}>
                    View evidence & prepare
                  </Link>
                  <details>
                    <summary>Rate this opportunity</summary>
                    <ActionForm
                      action="feedback"
                      values={{ jobId: j.id }}
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
                  </details>
                </div>
              </article>
            );
          })
        ) : (
          <section className="empty">
            <h2>Start with a role worth exploring</h2>
            <p>
              Add a job description to evaluate its fit and prepare a truthful
              application. Company feeds appear here once you configure your
              target list.
            </p>
            <Link className="button" href="/jobs/new">
              Add your first job
            </Link>
          </section>
        )}
      </div>
      <section className="panel">
        <h2>Bank review</h2>
        {jobs.length > 50 && (
          <div className="row">
            {page > 1 && (
              <Link
                href={`/?${new URLSearchParams({ ...p, page: String(page - 1) })}`}
              >
                ← Previous page
              </Link>
            )}
            <span className="muted">
              Page {page} of {Math.ceil(jobs.length / 50)}
            </span>
            {page * 50 < jobs.length && (
              <Link
                href={`/?${new URLSearchParams({ ...p, page: String(page + 1) })}`}
              >
                Next page →
              </Link>
            )}
          </div>
        )}
        <p>{bank.review_queue.length} items in the review queue.</p>
        <Link href="/bank?tab=review_queue">Open review queue →</Link>
        {questions.map((q) => (
          <p className="muted" key={q.id}>
            {q.question}
          </p>
        ))}
      </section>
    </>
  );
}
