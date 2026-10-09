import ActionForm from "@/components/action-form";
import { rows } from "@/lib/db";
import { Company } from "@/lib/sources";
export const dynamic = "force-dynamic";
export default function Companies() {
  const companies = rows<Company>("SELECT * FROM companies ORDER BY name");
  return (
    <>
      <h1>Target companies</h1>
      <p className="subtitle">
        Choose your targets. Public ATS feeds load all their open roles for
        local filtering.
      </p>
      <section className="panel">
        <h2>Add a company</h2>
        <ActionForm action="company" label="Add company">
          <div className="row">
            <div>
              <label>Company name</label>
              <input name="name" required />
            </div>
            <div>
              <label>ATS</label>
              <select name="ats">
                {["greenhouse", "lever", "ashby", "smartrecruiters"].map(
                  (ats) => (
                    <option key={ats}>{ats}</option>
                  ),
                )}
              </select>
            </div>
            <div>
              <label>Board token / company identifier</label>
              <input name="board_token" required pattern="[a-zA-Z0-9_-]+" />
            </div>
          </div>
          <label>Notes</label>
          <textarea name="notes" />
        </ActionForm>
      </section>
      {companies.map((c) => (
        <section className="panel" key={c.id}>
          <div className="row spread">
            <h2>
              {c.name}{" "}
              <span className="badge">{c.active ? "Active" : "Paused"}</span>
            </h2>
            <ActionForm
              action="company_toggle"
              values={{ companyId: c.id }}
              label={c.active ? "Pause" : "Resume"}
            />
            <ActionForm
              action="company_remove"
              values={{ companyId: c.id }}
              label="Remove"
            />
          </div>
          <p className="muted">
            {c.ats} · {c.board_token}
          </p>
          <p>{c.notes}</p>
        </section>
      ))}
      <section className="panel">
        <h2>Ingestion</h2>
        <ActionForm action="ingest" label="Queue ingestion now" />
        <p className="muted">
          Start the separate worker to process the queue. Source failures are
          isolated.
        </p>
        {rows<{
          id: string;
          source: string;
          status: string;
          started_at: string;
          counts: string;
          errors: string;
        }>("SELECT * FROM ingest_runs ORDER BY started_at DESC LIMIT 30").map(
          (r) => (
            <details key={r.id}>
              <summary>
                {r.source} · {r.status} · {r.started_at}
              </summary>
              <pre>
                {r.counts}
                {r.errors}
              </pre>
            </details>
          ),
        )}
      </section>
    </>
  );
}
