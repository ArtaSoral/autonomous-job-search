import Link from "next/link";
import ActionForm from "@/components/action-form";
import { documentLines, getDocument } from "@/lib/documents";
import { registeredInputs } from "@/lib/inputs";
import { rows } from "@/lib/db";
export const dynamic = "force-dynamic";
export default async function Review({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  const d = getDocument(id);
  const { bank } = registeredInputs();
  const flags = JSON.parse(d.verification_report) as {
    index: number;
    severity: string;
    reason: string;
  }[];
  const siblings = rows<{ id: string; kind: string; version: number }>(
    "SELECT id,kind,version FROM documents WHERE job_id=? ORDER BY created_at DESC",
    d.job_id,
  );
  return (
    <>
      <Link href={`/jobs/${d.job_id}`}>← Job details</Link>
      <h1 style={{ marginTop: 20 }}>
        Review {d.kind.replace("_", " ")}{" "}
        <span className="badge">v{d.version}</span>
      </h1>
      <p className="subtitle">
        Bank v{d.bank_version} · Specification v{d.spec_version} · Each line is
        linked to its source.
      </p>
      <div className="row">
        {siblings
          .filter((s) => s.kind !== d.kind)
          .slice(0, 1)
          .map((s) => (
            <Link className="button" href={`/documents/${s.id}`} key={s.id}>
              Review {s.kind.replace("_", " ")}
            </Link>
          ))}
        {d.approved_by_user ? (
          <a className="button" href={`/api/documents/${id}`}>
            Download approved DOCX
          </a>
        ) : (
          <ActionForm
            action="approve"
            values={{ documentId: id }}
            label="Approve & export"
          />
        )}
      </div>
      {documentLines(d).map((line, index) => (
        <section className="panel" key={index} style={{ marginTop: 20 }}>
          <div className="grid">
            <div>
              <h3>Generated line {index + 1}</h3>
              <p>{line.text}</p>
              {flags
                .filter((f) => f.index === index)
                .map((f, n) => (
                  <p
                    key={n}
                    className={
                      f.severity === "error" ? "error" : "badge warning"
                    }
                  >
                    {f.reason}
                  </p>
                ))}
              <ActionForm
                action="revise"
                values={{ documentId: id, index }}
                label="Save revised version"
              >
                <label>Revise wording</label>
                <textarea name="text" defaultValue={line.text} />
                <label>
                  <input name="regenerate" type="checkbox" /> Regenerate this
                  line from the same sources
                </label>
              </ActionForm>
            </div>
            <div>
              <h3>Source evidence</h3>
              {line.source_ids.map((source) => {
                const s = [...bank.bullets, ...bank.strengths].find(
                  (b) => b.id === source,
                );
                return (
                  <div className="line" key={source}>
                    <strong>{source}</strong>
                    <p className="muted">
                      {s?.text ||
                        "Source is no longer available in the current bank"}
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        </section>
      ))}
    </>
  );
}
