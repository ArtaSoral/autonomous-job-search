import Link from "next/link";
import { getJob, currentExtraction } from "@/lib/postings";
import { rows } from "@/lib/db";
import ActionForm from "@/components/action-form";
import EvaluationDetail from "@/components/evaluation-detail";
export const dynamic = "force-dynamic";
export default async function JobDetail({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const job = getJob(id);
  const x = currentExtraction(id);
  const documents = rows<{
    id: string;
    kind: string;
    version: number;
    approved_by_user: number;
  }>(
    "SELECT id,kind,version,approved_by_user FROM documents WHERE job_id=? ORDER BY created_at DESC",
    id,
  );
  return (
    <>
      <Link href="/">← All jobs</Link>
      <h1 style={{ marginTop: 20 }}>{job.title}</h1>
      <p className="subtitle">
        {job.employer} · {job.location_text || "Location awaiting extraction"} ·{" "}
        <span className="badge">{job.listing_status}</span>
      </p>
      <div className="row">
        {job.apply_url && (
          <a
            className="button"
            target="_blank"
            rel="noreferrer"
            href={job.apply_url}
          >
            Open application
          </a>
        )}
        <Link className="button" href="/applications">
          Application tracker
        </Link>
      </div>
      <div style={{ marginTop: 24 }}>
        <EvaluationDetail jobId={id} />
      </div>
      <ActionForm
        action="application"
        values={{ jobId: id, status: "Saved" }}
        label="Save to tracker"
      />
      <section className="panel" style={{ marginTop: 24 }}>
        <h2>Prepare an application</h2>
        <ActionForm
          action="prepare"
          values={{ jobId: id }}
          label="Generate resume & cover letter"
        >
          <label>
            <input name="confirmed" type="checkbox" /> I checked the official
            listing and it is open.
          </label>
          <p className="muted">
            Supported ATS listings are revalidated automatically. Review every
            generated line before approving export.
          </p>
        </ActionForm>
      </section>
      <section className="panel">
        <h2>Documents</h2>
        {documents.length ? (
          documents.map((d) => (
            <p key={d.id}>
              <Link href={`/documents/${d.id}`}>
                {d.kind.replace("_", " ")} · v{d.version}
              </Link>{" "}
              <span className="badge">
                {d.approved_by_user ? "Approved" : "Review needed"}
              </span>
            </p>
          ))
        ) : (
          <p className="muted">No documents prepared yet.</p>
        )}
      </section>
      <section className="panel">
        <h2>Posting extraction</h2>
        <ActionForm
          action="extract"
          values={{ jobId: id }}
          label="Extract posting details"
        />
        {x && <pre>{JSON.stringify(x, null, 2)}</pre>}
      </section>
      <details className="panel">
        <summary>Original job description</summary>
        <pre>{job.description}</pre>
      </details>
    </>
  );
}
