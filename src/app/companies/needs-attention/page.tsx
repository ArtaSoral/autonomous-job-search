import Link from "next/link";
import RefreshButton from "@/components/refresh-button";
import ActionForm from "@/components/action-form";
import { jobProgress } from "@/lib/progress";

export const dynamic = "force-dynamic";

export default function NeedsAttention() {
  const { failedJobs } = jobProgress();
  return (
    <>
      <p>
        <Link href="/companies">← Back to Companies</Link>
      </p>
      <div className="row spread">
        <h1>Jobs needing attention</h1>
        <RefreshButton />
      </div>
      <p className="subtitle">
        {failedJobs.length.toLocaleString("en-US")} jobs need attention after
        evaluation failed. Open a job to review it or try evaluating it again.
        Jobs leave this list when queued for another attempt or successfully
        evaluated.
      </p>
      {failedJobs.length ? (
        <section className="panel" aria-label="Jobs needing attention">
          <ul className="attention-jobs">
            {failedJobs.map((job) => (
              <li className="line" key={job.id}>
                <h2>
                  <Link href={`/jobs/${job.id}`}>
                    {job.employer} · {job.title}
                  </Link>
                </h2>
                {job.error ? (
                  <pre className="error">{job.error}</pre>
                ) : (
                  <p className="muted">
                    Evaluation failed without a recorded reason.
                  </p>
                )}
                <ActionForm
                  action="evaluate"
                  values={{ jobId: job.id }}
                  label="Retry evaluation"
                />
              </li>
            ))}
          </ul>
        </section>
      ) : (
        <div className="empty">
          <h2>No jobs need attention</h2>
          <p>There are no failed evaluations to review right now.</p>
          <Link href="/companies">Return to job search progress →</Link>
        </div>
      )}
    </>
  );
}
