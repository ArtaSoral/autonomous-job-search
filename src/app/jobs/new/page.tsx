import ActionForm from "@/components/action-form";
export default function AddJob() {
  return (
    <>
      <h1>Add a job</h1>
      <p className="subtitle">
        Bring in a role to evaluate and prepare an application.
      </p>
      <section className="panel">
        <ActionForm action="add_job" label="Save job">
          <label htmlFor="url">Official posting URL (optional)</label>
          <input
            id="url"
            name="url"
            type="url"
            style={{ width: "100%" }}
            placeholder="https://…"
          />
          <p className="muted">
            Greenhouse, Lever, Ashby, and SmartRecruiters URLs load from their
            public APIs. For other sites, paste the description below.
          </p>
          <label htmlFor="text">Job description</label>
          <textarea
            id="text"
            name="text"
            rows={16}
            placeholder="Paste responsibilities, qualifications, salary, and location details."
          />
        </ActionForm>
      </section>
    </>
  );
}
