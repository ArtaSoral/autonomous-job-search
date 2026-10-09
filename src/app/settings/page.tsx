import { loadInputs } from "@/lib/bank";
import { accounts, activeAccount, AccountModel } from "@/lib/openai-auth";
export const dynamic = "force-dynamic";
export default async function Settings({
  searchParams,
}: {
  searchParams: Promise<{ connection?: string }>;
}) {
  const i = loadInputs();
  const { connection } = await searchParams;
  const apiMode = process.env.OPENAI_AUTH_MODE === "api";
  const saved = accounts(),
    active = activeAccount();
  const models = JSON.parse(active?.models || "[]") as AccountModel[];
  return (
    <>
      <h1>Settings</h1>
      <p className="subtitle">Runtime inputs and connection status</p>
      {!apiMode && connection === "connected" && (
        <section className="panel">
          <h2>You’re using your ChatGPT plan</h2>
          <p>
            Eligible model requests use your ChatGPT plan. Manage the app’s
            access and usage in ChatGPT settings.
          </p>
          <a href="/settings">Got it</a>
        </section>
      )}
      {connection === "error" && (
        <p className="error">
          The connection action could not be completed. Try signing in again,
          allow ChatGPT plan usage, and refresh models. Your previously saved
          account is retained.
        </p>
      )}
      {connection === "revocation" && (
        <p className="error">
          Signed out locally. Remote revocation was not confirmed; disconnect
          Personal Job Finder in ChatGPT Settings to end remote access.
        </p>
      )}
      {apiMode ? (
        <section className="panel">
          <h2>OpenAI · API access</h2>
          <p>
            Using your OpenAI API account. Selected posting text and resume
            facts are sent to OpenAI. API usage is billed separately from a
            ChatGPT subscription.
          </p>
          {["OPENAI_API_KEY", "MODEL_FAST", "MODEL_STRONG"].map((key) => (
            <p key={key}>
              {key}{" "}
              <span className="badge">
                {process.env[key] ? "Configured" : "Not configured"}
              </span>
            </p>
          ))}
          <p>
            Set the API key and model identifiers in your local .env file, then
            restart the app and worker.
          </p>
        </section>
      ) : (
        <section className="panel">
          <h2>OpenAI · ChatGPT plan</h2>
          <p>
            Sign in with your eligible Plus or Pro account. Job Finder requests
            count toward your plan’s usage limits. Selected posting text and
            resume facts are sent to OpenAI.
          </p>
          <p>
            <a
              href="https://chatgpt.com/settings/usage"
              target="_blank"
              rel="noreferrer"
            >
              Manage ChatGPT usage and app access
            </a>
          </p>
          <p>
            {active?.secrets
              ? `Using ChatGPT plan · ${active.email || "Saved account"}`
              : "Not connected"}
          </p>
          <form action="/auth/start" method="post">
            <input type="hidden" name="action" value="signin" />
            <button type="submit">Continue with ChatGPT</button>
          </form>
          <p className="muted">
            Use this page at{" "}
            <a href="http://127.0.0.1:3000/settings">127.0.0.1:3000/settings</a>{" "}
            for sign-in.
          </p>
          {saved.map((account, index) => (
            <div className="line" key={account.client_id}>
              <p>
                {account.email || "ChatGPT account"} · Account {index + 1}{" "}
                {account.client_id === active?.client_id ? "· Active" : ""}
              </p>
              <form action="/auth/start" method="post">
                <input
                  type="hidden"
                  name="clientId"
                  value={account.client_id}
                />
                <input type="hidden" name="action" value="signin" />
                <button type="submit">Sign in again</button>
              </form>
              {account.secrets && account.client_id !== active?.client_id && (
                <form action="/auth/start" method="post">
                  <input
                    type="hidden"
                    name="clientId"
                    value={account.client_id}
                  />
                  <input type="hidden" name="action" value="switch" />
                  <button type="submit">Use this account</button>
                </form>
              )}
            </div>
          ))}
          {active?.secrets && (
            <>
              <form action="/auth/start" method="post">
                <input type="hidden" name="action" value="models" />
                <div className="row">
                  <div>
                    <label htmlFor="fast-model">
                      Fast model · extraction and checks
                    </label>
                    <select
                      id="fast-model"
                      name="fast"
                      defaultValue={active.fast_model}
                      required
                    >
                      {models.map((m) => (
                        <option key={m.slug} value={m.slug}>
                          {m.display_name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label htmlFor="strong-model">
                      Strong model · evaluation and writing
                    </label>
                    <select
                      id="strong-model"
                      name="strong"
                      defaultValue={active.strong_model}
                      required
                    >
                      {models.map((m) => (
                        <option key={m.slug} value={m.slug}>
                          {m.display_name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
                <button type="submit" disabled={!models.length}>
                  Save models
                </button>
              </form>
              <form action="/auth/start" method="post">
                <input type="hidden" name="action" value="refresh" />
                <button type="submit">Refresh models</button>
              </form>
              <form action="/auth/start" method="post">
                <input type="hidden" name="action" value="signout" />
                <button type="submit">Sign out</button>
              </form>
            </>
          )}
        </section>
      )}
      <div className="grid">
        {[
          ["Resume bank", i.bankVersion, i.bankHash],
          ["Evaluation specification", i.specVersion, i.specHash],
        ].map(([name, v, hash]) => (
          <section className="panel" key={name}>
            <h2>
              {name} <span className="badge">v{v}</span>
            </h2>
            <p className="muted">SHA256 {hash}</p>
          </section>
        ))}
      </div>
      <section className="panel">
        <h2>Connections</h2>
        {["JSEARCH_API_KEY", "ADZUNA_APP_ID", "ADZUNA_APP_KEY"].map((key) => (
          <p key={key}>
            {key}{" "}
            <span className="badge">
              {process.env[key] ? "Configured" : "Not configured"}
            </span>
          </p>
        ))}
        <p>
          Set credentials in your local .env file. Restart the app and worker
          after changing them.
        </p>
        <p>
          Daily ingestion: 6:00 a.m. (
          {process.env.TIMEZONE || "America/New_York"}). Aggregator daily
          request budget: {process.env.AGGREGATOR_DAILY_REQUESTS || "0"}.
        </p>
      </section>
    </>
  );
}
