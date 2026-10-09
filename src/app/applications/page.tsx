import Link from "next/link";
import ActionForm from "@/components/action-form";
import { rows } from "@/lib/db";
import { statuses } from "@/lib/schemas";
import ContactsEditor from "@/components/contacts-editor";
export const dynamic = "force-dynamic";
type Application = {
  id: string;
  job_id: string;
  title: string;
  employer: string;
  status: string;
  notes: string;
  contacts: string;
  follow_up_on: string | null;
  resume_document_id: string | null;
  cover_document_id: string | null;
  status_history: string;
};
export default async function Applications({
  searchParams,
}: {
  searchParams: Promise<{ view?: string }>;
}) {
  const { view } = await searchParams;
  const apps = rows<Application>(
    "SELECT a.*,j.title,j.employer FROM applications a JOIN jobs j ON j.id=a.job_id ORDER BY a.follow_up_on IS NULL,a.follow_up_on",
  );
  return (
    <>
      <h1>Applications</h1>
      <p className="subtitle">Follow each opportunity from saved to outcome.</p>
      <div className="row tabs">
        <Link href="/applications">List</Link>
        <Link href="/applications?view=board">Board</Link>
      </div>
      {view === "board" ? (
        <div className="board">
          {statuses.map((status) => (
            <section className="column" key={status}>
              <h3>{status}</h3>
              {apps
                .filter((a) => a.status === status)
                .map((a) => (
                  <div className="card" key={a.id}>
                    <Link href={`/jobs/${a.job_id}`}>{a.title}</Link>
                    <p className="muted">{a.employer}</p>
                    {a.follow_up_on && <p>Follow up {a.follow_up_on}</p>}
                  </div>
                ))}
            </section>
          ))}
        </div>
      ) : apps.length ? (
        apps.map((a) => (
          <section className="panel" key={a.id}>
            <h2>
              <Link href={`/jobs/${a.job_id}`}>
                {a.title} · {a.employer}
              </Link>
            </h2>
            <ActionForm action="application" values={{ jobId: a.job_id }}>
              <div className="row">
                <div>
                  <label>Status</label>
                  <select name="status" defaultValue={a.status}>
                    {statuses.map((s) => (
                      <option key={s}>{s}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label>Follow-up date</label>
                  <input
                    name="follow_up_on"
                    type="date"
                    defaultValue={a.follow_up_on || ""}
                  />
                </div>
              </div>
              <label>Resume version sent</label>
              <select
                name="resume_document_id"
                defaultValue={a.resume_document_id || ""}
              >
                <option value="">Select version</option>
                {rows<{
                  id: string;
                  version: number;
                  approved_by_user: number;
                }>(
                  "SELECT id,version,approved_by_user FROM documents WHERE job_id=? AND kind='resume'",
                  a.job_id,
                ).map((d) => (
                  <option key={d.id} value={d.id}>
                    v{d.version} ·{" "}
                    {d.approved_by_user ? "Approved" : "Review needed"}
                  </option>
                ))}
              </select>
              <label>Cover letter version sent</label>
              <select
                name="cover_document_id"
                defaultValue={a.cover_document_id || ""}
              >
                <option value="">Select version</option>
                {rows<{
                  id: string;
                  version: number;
                  approved_by_user: number;
                }>(
                  "SELECT id,version,approved_by_user FROM documents WHERE job_id=? AND kind='cover_letter'",
                  a.job_id,
                ).map((d) => (
                  <option key={d.id} value={d.id}>
                    v{d.version} ·{" "}
                    {d.approved_by_user ? "Approved" : "Review needed"}
                  </option>
                ))}
              </select>
              <label>Notes</label>
              <textarea name="notes" defaultValue={a.notes} />
              <label>Contacts</label>
              <ContactsEditor initial={JSON.parse(a.contacts)} />
            </ActionForm>
            <details>
              <summary>Status and document history</summary>
              <pre>{JSON.stringify(JSON.parse(a.status_history), null, 2)}</pre>
            </details>
          </section>
        ))
      ) : (
        <div className="empty">
          <h2>No applications yet</h2>
          <p>
            Prepare a job’s documents or save it to your tracker to get started.
          </p>
          <Link className="button" href="/jobs/new">
            Add a job
          </Link>
        </div>
      )}
    </>
  );
}
