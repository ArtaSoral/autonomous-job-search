# Personal Job Finder setup

The app runs privately at http://127.0.0.1:3000. Use Node.js 24 LTS. This workspace also has a checksum-verified portable Node runtime under the ignored `data/tools` directory; the PowerShell launcher finds it automatically.

## Everyday startup after a restart

Double-click **Start Job Finder.cmd** in the project folder. It starts the app and worker in the background, waits for them to be ready, and opens the dashboard in your browser. No terminal windows need to stay open. Double-clicking Start again opens the dashboard without launching extra processes.

Double-click **Stop Job Finder.cmd** to stop both processes. Closing the browser leaves them running. You can create desktop shortcuts to these two files for easier access.

The launcher uses the existing production build, or development mode if there is no build yet. Logs are saved under `data/launcher`. If you were already running the app in a terminal, stop that instance before using the launcher. After changing app code, rebuild with `.\scripts\run.ps1 build` while the app is stopped.

## Initial setup and manual commands

```powershell
Copy-Item .env.example .env   # Only if .env does not already exist
.\scripts\run.ps1 install
.\scripts\run.ps1 db:migrate
.\scripts\run.ps1 dev
```

In a second terminal, run the worker:

```powershell
.\scripts\run.ps1 worker
```

For production mode, run `build`, then `start` with the same launcher. Both server modes bind to the loopback interface. Remote deployment is intentionally unsupported by the request handlers; add password authentication and HTTPS before adapting this for a remote host.

The supplied bank and specification are copied into `data/inputs` and excluded from Git. Set `BANK_PATH` and `SPEC_PATH` in `.env` to use another version. The application validates the bank before use, snapshots version/content hashes, and marks existing evaluations stale when either input changes. Use the dashboard’s explicit re-evaluation action to calculate new results.

Connect OpenAI with your ChatGPT Plus or Pro plan through **Settings → Continue with ChatGPT** at http://127.0.0.1:3000/settings. Allow ChatGPT plan usage during the browser authorization flow. No API key is needed for this route. The app uses OpenAI's documented dynamic client registration with a loopback callback, PKCE, state, nonce and verified ID tokens. See the [official sign-in guide](https://developers.openai.com/siwc/token-sharing-open-source/sign-in).

After sign-in, Settings lists the models available to your account. Choose the fast model for extraction and verification and the strong model for evaluation and writing, then save. Initial choices prefer Luna and Sol when your catalog includes them. Saved registrations can be selected or signed in again. The worker refreshes expiring access tokens; app and worker serialize refreshes to protect rotating credentials.

Job Finder requests count toward your ChatGPT plan limits. Review usage and app access in [ChatGPT Settings](https://chatgpt.com/settings/usage). Selected posting text and resume facts are transmitted to OpenAI. Prompts and responses are logged in the local database. OpenAI requests use `store: false` and streaming; incomplete or failed responses never pass validation. Windows DPAPI encrypts OAuth credentials for your Windows user before they are stored locally. Sign out attempts remote revocation and clears local tokens while retaining the registration. If revocation is unconfirmed, disconnect the app in ChatGPT Settings.

Until connected, the bank viewer, manual posting storage, tracker, company manager and quality reports work; extraction, evaluation, rewriting and verification require the model connection. The original bank and specification remain unchanged.

Installation and database setup are already complete in this workspace. Sign in, then add one pasted posting through Add a job and evaluate it before enabling company ingestion. Leave aggregator credentials empty and their daily budget at zero for the first test. Sign-in and model selection take effect without restarting processes.

Optional direct API access can be configured with `OPENAI_AUTH_MODE=api`, `OPENAI_API_KEY`, `MODEL_FAST`, and `MODEL_STRONG` in the local `.env`. This uses separately billed API access, not your ChatGPT subscription. The default `OPENAI_AUTH_MODE=chatgpt` uses the sign-in flow. Never paste credentials into chat. Restart both processes after changing environment values.

Settings displays the active connection mode. API mode reports key and model configuration without showing credentials; ChatGPT plan mode uses the signed-in account's saved model choices. Historical authorship and source IDs in the original resume bank remain intact when the runtime model provider changes.

Add your own target companies under Companies. The app starts with an empty list. Each company needs its ATS and public board token/company identifier. The worker schedules ingestion at 3:00 a.m. and weekly reports on Monday at 7:00 a.m., using `TIMEZONE` (default `America/New_York`). It runs only while its process is active. The queue persists through restarts; failed tasks appear in Quality & feedback.

Aggregator requests default to **zero**. Set JSearch and/or Adzuna credentials plus a daily `AGGREGATOR_DAILY_REQUESTS` budget that fits your subscription. Public-board reads use configurable `SOURCE_DELAY_MS` (default 1,500 ms). Optional per-host delay overrides use `SOURCE_DELAY_BOARDS_API_MS`, `SOURCE_DELAY_API_MS`, and `SOURCE_DELAY_JSEARCH_MS`. Aggregator queries rotate across title families and responsibility combinations derived from the runtime inputs. No applications are submitted automatically.

Prepare a job’s documents after verifying its employer listing is open. Supported ATS URLs are revalidated via their APIs. Other URLs require your explicit confirmation. Review every line and its citations, edit/regenerate flagged wording, and approve each document to enable DOCX downloads. Mark Applied in the tracker with the exact approved resume and optional cover letter versions sent.

Bank answers produce pending drafts. Approving and exporting creates a new bank under `data/exports`, validates it, and leaves the original unchanged. Update `BANK_PATH` and restart to load that exported version. Specification proposals likewise export a suggested Markdown patch; apply it to a new specification version yourself. Inputs are never silently edited.

Back up the entire `data` directory with both app and worker stopped. It contains input snapshots, SQLite data, documents and exports. Never commit it or `.env`.

```powershell
.\scripts\run.ps1 test
.\scripts\run.ps1 typecheck
.\scripts\run.ps1 build
```

Validation fixtures use synthetic postings and documented API response shapes. They run without keys, fees, or changes to the active job database. Live provider behavior, real OpenAI response quality/latency, labeled real-posting calibration, and DOCX visual layout need checks with configured providers and a Word/LibreOffice renderer. Optional email digests and PDF conversion are not enabled.
