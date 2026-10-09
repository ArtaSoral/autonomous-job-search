import Link from "next/link";
import { loadInputs } from "@/lib/bank";
export const dynamic = "force-dynamic";
export default async function BankPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string>>;
}) {
  const p = await searchParams;
  const { bank } = loadInputs();
  const tab = p.tab || "bullets";
  const collection = bank[tab];
  const bullets = bank.bullets.filter(
    (b) =>
      (!p.role || b.role_id === p.role) &&
      (!p.team || b.team_id === p.team || b.team_ids.includes(p.team)) &&
      (!p.status || b.verification_status === p.status) &&
      (!p.variant || b.variant_group === p.variant),
  );
  return (
    <>
      <h1>Resume bank</h1>
      <p className="subtitle">
        Read-only source of truth · v{bank.schema_version} ·{" "}
        {bank.bullets.filter((b) => b.usable_in_generation).length} usable
        bullets ·{" "}
        {bank.bullets.filter((b) => b.verification_status === "retired").length}{" "}
        retired
      </p>
      <div className="row tabs">
        {[
          "bullets",
          "evidence",
          "guardrails",
          "skills",
          "job_preferences",
          "review_queue",
        ].map((t) => (
          <Link href={`/bank?tab=${t}`} key={t}>
            {t.replaceAll("_", " ")}
          </Link>
        ))}
      </div>
      {tab === "bullets" ? (
        <>
          <form className="row panel">
            <input type="hidden" name="tab" value="bullets" />
            <select name="role" defaultValue={p.role}>
              <option value="">All roles</option>
              {bank.experience.map((r) => (
                <option value={r.id} key={r.id}>
                  {r.company}
                </option>
              ))}
            </select>
            <select name="team" defaultValue={p.team}>
              <option value="">All teams</option>
              {bank.experience
                .flatMap((r) => r.teams)
                .map((t) => (
                  <option value={t.id} key={t.id}>
                    {t.name}
                  </option>
                ))}
            </select>
            <select name="status" defaultValue={p.status}>
              <option value="">All statuses</option>
              {[...new Set(bank.bullets.map((b) => b.verification_status))].map(
                (s) => (
                  <option key={s}>{s}</option>
                ),
              )}
            </select>
            <input
              name="variant"
              placeholder="Variant group"
              defaultValue={p.variant}
            />
            <button>Filter</button>
          </form>
          {bank.experience.map((role) => (
            <section key={role.id}>
              <h2>
                {role.company} · {role.title}
              </h2>
              {[null, ...role.teams.map((t) => t.id)].map((team) => {
                const list = bullets.filter(
                  (b) => b.role_id === role.id && b.team_id === team,
                );
                return list.length ? (
                  <div key={team || "role"}>
                    <h3>
                      {role.teams.find((t) => t.id === team)?.name ||
                        "Role-level and shared work"}
                    </h3>
                    {[...new Set(list.map((b) => b.variant_group))].map(
                      (vg) => (
                        <div className="panel" key={vg}>
                          <div className="muted">{vg}</div>
                          {list
                            .filter((b) => b.variant_group === vg)
                            .map((b) => (
                              <div className="line" key={b.id}>
                                <div className="row spread">
                                  <strong>{b.id}</strong>
                                  <span
                                    className={`badge ${!b.usable_in_generation ? "warning" : ""}`}
                                  >
                                    {b.verification_status}
                                  </span>
                                </div>
                                <p>{b.text}</p>
                              </div>
                            ))}
                        </div>
                      ),
                    )}
                  </div>
                ) : null;
              })}
            </section>
          ))}
        </>
      ) : (
        <section className="panel">
          <pre>{JSON.stringify(collection, null, 2)}</pre>
        </section>
      )}
    </>
  );
}
