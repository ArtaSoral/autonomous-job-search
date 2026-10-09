# Source endpoint references

Model calls use the [OpenAI Responses API](https://developers.openai.com/siwc/token-sharing-open-source/models-and-inference). ChatGPT plan access follows the [documented OAuth sign-in flow](https://developers.openai.com/siwc/token-sharing-open-source/sign-in) and [request limitations](https://developers.openai.com/siwc/token-sharing-open-source/preview-limitations): bearer authentication, streamed responses, `store: false`, instructions with array input, and namespaced function tools. The app accepts only completed responses with one schema-valid task result; bank citations and semantic checks remain enforced locally. Optional API-key access uses the same OpenAI endpoint with separately configured models.

Checked October 8, 2026. These connectors use documented GET APIs. They do not scrape hosted pages or submit applications. Account-specific quotas and terms still govern keyed sources. Review source documentation when enabling or updating a connector.

| Source | Primary reference | Implementation |
|---|---|---|
| Greenhouse | [Job Board API](https://docs.greenhouse.io/job-board.html) | Public board list with content and individual posting reads; no application POST. |
| Lever | [Official Postings API](https://github.com/lever/postings-api) | Published posting reads, JSON mode, pagination, and hosted apply URLs. |
| Ashby | [Job Postings API](https://developers.ashbyhq.com/docs/public-job-posting-api) | Lightweight published-job feed; includes compensation and omits unlisted postings from discovery. |
| SmartRecruiters | [Posting API](https://developers.smartrecruiters.com/docs/posting-api), [Endpoints](https://developers.smartrecruiters.com/docs/endpoints) | Active public postings, pagination, followed by detail reads. Internal/authenticated postings are not requested. |
| JSearch | [Provider API reference](https://github.com/OpenWeb-Ninja/openwebninja-skills/blob/main/openwebninja/apis/jsearch/README.md) | RapidAPI search, one page per budgeted request. Credentials and an explicit request budget required. |
| Adzuna | [Search API](https://developer.adzuna.com/docs/search), [API terms](https://developer.adzuna.com/docs/terms_of_service) | US search API; response snippets retained as aggregator-only. Estimated salaries are not treated as confirmed base pay. |

API fixtures in `tests/fixtures/sources.json` are synthetic contract examples, not recordings from a paid account. Production source responses are recorded locally in `raw_postings`. No target companies or credentials are bundled in source control.

Adzuna permits personal research and requires source attribution. Its API terms list default caps of 25 requests/minute, 250/day, 1,000/week and 2,500/month; set a budget within all applicable limits. Displayed Adzuna results include a link with the required attribution size. The app does not request Jobsworth estimates or publish vacancy/salary research.
