import Link from "next/link";
import { jobProgress } from "@/lib/progress";
import RefreshButton from "./refresh-button";

export default function JobProgress() {
  const progress = jobProgress();
  const fetch = progress.latestFetch;
  const number = (value: number) => value.toLocaleString("en-US");
  const time = (value: string) =>
    new Date(value).toLocaleString("en-US", {
      timeZone: process.env.TIMEZONE || "America/New_York",
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
      timeZoneName: "short",
    });
  const fetchLabels = {
    pending: "Queued",
    running: "Fetching",
    complete: "Complete",
    failed: "Needs attention",
  };
  const active = progress.pending + progress.running > 0;
  const status =
    fetch?.status === "running"
      ? "Fetching jobs"
      : fetch?.status === "pending"
        ? "Fetch queued"
        : active
          ? "Evaluations in progress"
          : progress.failed
            ? "Needs attention"
            : "Up to date";
  return (
    <section
      className="panel job-progress"
      aria-labelledby="job-progress-heading"
    >
      <div className="row spread">
        <div className="row">
          <h2 id="job-progress-heading">Job search progress</h2>
          <span
            className={`badge${!active && progress.failed ? " warning" : ""}`}
          >
            {status}
          </span>
        </div>
        <RefreshButton />
      </div>
      <div className="progress-stats fetch-stats">
        <div>
          <span className="muted">Pulled in latest fetch</span>
          <strong>{fetch ? number(fetch.pulled) : "—"}</strong>
          <span className="muted">Includes previously seen postings</span>
        </div>
        <div>
          <span className="muted">New jobs added</span>
          <strong>{fetch ? number(fetch.added) : "—"}</strong>
          <span className="muted">Queued for evaluation</span>
        </div>
        <div>
          <span className="muted">Unique jobs collected</span>
          <strong>{number(progress.totalJobs)}</strong>
          <span className="muted">Across all fetches and manual additions</span>
        </div>
      </div>
      <p className="muted fetch-summary">
        {fetch ? (
          <>
            Latest fetch: {fetchLabels[fetch.status]} ·{" "}
            {fetch.startedAt
              ? `Started ${time(fetch.startedAt)}`
              : `Requested ${time(fetch.created_at)}`}{" "}
            · {number(fetch.finished)} feeds checked
            {fetch.failed > 0 && (
              <>
                {" "}
                · {number(fetch.failed)} failed (
                <Link href="/companies">view feeds</Link>)
              </>
            )}
          </>
        ) : (
          <>
            No fetch has run yet.{" "}
            <Link href="/companies">Choose companies and start a fetch</Link>.
          </>
        )}
        {fetch?.status === "running" && " Counts update as each feed finishes."}
      </p>
      <div className="row spread">
        <h3>Evaluation progress</h3>
        <span className="muted">
          {number(progress.complete)} of {number(progress.scheduled)} jobs done
        </span>
      </div>
      <progress
        aria-label="Jobs with completed evaluation processing"
        value={progress.complete}
        max={Math.max(1, progress.scheduled)}
      />
      <div className="progress-stats evaluation-stats">
        {[
          ["Waiting", progress.pending],
          ["Evaluating now", progress.running],
          ["Done", progress.complete],
          ["Needs attention", progress.failed],
        ].map(([label, count]) => (
          <div key={label}>
            <span className="muted">{label}</span>
            <strong>
              {label === "Needs attention" ? (
                <Link
                  className="progress-count-link"
                  href="/companies/needs-attention"
                  aria-label={`View ${number(progress.failed)} jobs that need attention`}
                >
                  {number(progress.failed)}
                </Link>
              ) : (
                number(count as number)
              )}
            </strong>
          </div>
        ))}
      </div>
      {progress.runningJobs.slice(0, 3).map((job) => (
        <p className="muted" key={job.id}>
          Now evaluating:{" "}
          <Link href={`/jobs/${job.id}`}>
            {job.employer} · {job.title}
          </Link>
        </p>
      ))}
      {progress.failed > 0 && (
        <p className="muted">
          <Link href="/companies/needs-attention">
            Review evaluation errors →
          </Link>
        </p>
      )}
      <p className="muted progress-note">
        Done includes jobs filtered out during evaluation. Each job is counted
        once; retries use its latest status.
        {progress.unqueued > 0 &&
          ` ${number(progress.unqueued)} collected jobs have not been queued.`}{" "}
        Updated {time(progress.updatedAt)}. Refresh counts or reload the page
        for an update.
      </p>
    </section>
  );
}
