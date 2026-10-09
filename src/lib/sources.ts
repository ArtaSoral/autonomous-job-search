import { z } from "zod";
import { fetchSource, stripHtml, atsReference } from "./safe-fetch";
import { Bank, specSections } from "./bank";
export const sourceNames = [
  "greenhouse",
  "lever",
  "ashby",
  "smartrecruiters",
  "jsearch",
  "adzuna",
] as const;
export type Source = (typeof sourceNames)[number];
export type Company = {
  id: string;
  name: string;
  ats: Source;
  board_token: string;
  active: number;
  notes: string;
  archetype_tags: string;
};
export type Posting = {
  source: Source;
  sourceId: string;
  employer: string;
  title: string;
  location: string;
  description: string;
  url: string;
  applyUrl: string;
  postedAt: string | null;
  requisitionId: string | null;
  official: boolean;
  payload: unknown;
};
const obj = z.record(z.string(), z.unknown());
const array = z.array(obj);
const str = (v: unknown) =>
  typeof v === "string" ? v : v === null || v === undefined ? "" : String(v);
const nested = (v: unknown) => obj.parse(v || {});
export function normalizeResponse(
  source: Source,
  payload: unknown,
  company?: Company,
): Posting[] {
  let entries: Record<string, unknown>[];
  if (source === "lever") entries = array.parse(payload);
  else {
    const data = obj.parse(payload);
    entries = array.parse(
      data[
        source === "greenhouse" || source === "ashby"
          ? "jobs"
          : source === "smartrecruiters"
            ? "content"
            : source === "adzuna"
              ? "results"
              : "data"
      ],
    );
  }
  return entries
    .filter((e) => source !== "ashby" || e.isListed !== false)
    .flatMap((e) => {
      if (source === "jsearch" && Array.isArray(e.jobs))
        return normalizeResponse("jsearch", { data: e.jobs }, company);
      let id = "",
        title = "",
        employer = company?.name || "",
        location = "",
        description = "",
        url = "",
        applyUrl = "",
        date: string | null = null;
      let requisitionId: string | null = null;
      if (source === "greenhouse") {
        id = str(e.id);
        title = str(e.title);
        location = str(nested(e.location).name);
        description = stripHtml(str(e.content));
        url = str(e.absolute_url);
        requisitionId =
          str(e.requisition_id) ||
          null; /* updated_at is not the posting date */
      } else if (source === "lever") {
        id = str(e.id);
        title = str(e.text);
        location = str(nested(e.categories).location);
        description = [
          str(e.descriptionPlain) || stripHtml(str(e.description)),
          ...(Array.isArray(e.lists)
            ? e.lists.map((l) => {
                const list = nested(l);
                return `${list.text}\n${stripHtml(str(list.content))}`;
              })
            : []),
          stripHtml(str(e.additional)),
        ].join("\n");
        url = str(e.hostedUrl);
        applyUrl = str(e.applyUrl);
        date =
          typeof e.createdAt === "number"
            ? new Date(e.createdAt).toISOString()
            : null;
      } else if (source === "ashby") {
        url = str(e.jobUrl);
        id = str(e.id) || url.split("/").filter(Boolean).at(-1) || "";
        title = str(e.title);
        location = str(e.location);
        description =
          str(e.descriptionPlain) || stripHtml(str(e.descriptionHtml));
        applyUrl = str(e.applyUrl);
        date = str(e.publishedAt) || null;
      } else if (source === "smartrecruiters") {
        id = str(e.id);
        title = str(e.name);
        const loc = nested(e.location);
        location = [loc.city, loc.region, loc.country]
          .filter(Boolean)
          .join(", ");
        const sections = nested(nested(e.jobAd).sections);
        description = Object.values(sections)
          .map((section) => stripHtml(str(nested(section).text)))
          .join("\n");
        url =
          str(e.ref) ||
          `https://jobs.smartrecruiters.com/${encodeURIComponent(company?.board_token || "")}/${id}`;
        if (url.startsWith("https://api.smartrecruiters.com/"))
          url = `https://jobs.smartrecruiters.com/${encodeURIComponent(company?.board_token || "")}/${id}`;
        applyUrl = str(e.applyUrl);
        date = str(e.releasedDate) || null;
      } else if (source === "jsearch") {
        id = str(e.job_id);
        title = str(e.job_title);
        employer = str(e.employer_name);
        location =
          str(e.job_location) ||
          [e.job_city, e.job_state, e.job_country].filter(Boolean).join(", ");
        description = str(e.job_description);
        url = str(e.job_apply_link) || str(e.job_google_link);
        date = str(e.job_posted_at_datetime_utc) || null;
      } else {
        id = str(e.id);
        title = str(e.title);
        employer = str(nested(e.company).display_name);
        location = str(nested(e.location).display_name);
        description = stripHtml(str(e.description));
        url = str(e.redirect_url);
        date = str(e.created) || null;
      }
      if (!id || !title || !url)
        throw Error(`${source}: malformed posting lacks id, title or URL`);
      const parsed = new URL(url);
      if (!["https:", "http:"].includes(parsed.protocol))
        throw Error("Invalid posting URL");
      return [
        {
          source,
          sourceId: id,
          title,
          employer,
          location,
          description,
          url,
          applyUrl: applyUrl || url,
          postedAt: date,
          requisitionId,
          official: !!company,
          payload: e,
        },
      ];
    });
}
export type FetchJson = (
  url: string,
  headers?: Record<string, string>,
) => Promise<unknown>;
const lastRequest = new Map<string, number>();
export async function throttledFetch(
  url: string,
  headers?: Record<string, string>,
) {
  const host = new URL(url).host;
  const delay = Math.max(
    0,
    Number(
      process.env[`SOURCE_DELAY_${host.split(".")[0].toUpperCase()}_MS`] ||
        process.env.SOURCE_DELAY_MS ||
        1500,
    ),
  );
  const wait = delay - (Date.now() - (lastRequest.get(host) || 0));
  if (wait > 0) await new Promise((r) => setTimeout(r, Math.min(wait, 60000)));
  lastRequest.set(host, Date.now());
  return fetchSource(url, headers);
}
export async function fetchCompany(
  company: Company,
  fetcher: FetchJson = throttledFetch,
) {
  const board = encodeURIComponent(company.board_token);
  if (company.ats === "greenhouse")
    return normalizeResponse(
      "greenhouse",
      await fetcher(
        `https://boards-api.greenhouse.io/v1/boards/${board}/jobs?content=true`,
      ),
      company,
    );
  if (company.ats === "ashby")
    return normalizeResponse(
      "ashby",
      await fetcher(
        `https://api.ashbyhq.com/posting-api/job-board/${board}?includeCompensation=true`,
      ),
      company,
    );
  if (company.ats === "lever") {
    const all: Posting[] = [];
    for (let page = 0; page < 100; page++) {
      const payload = await fetcher(
        `https://api.lever.co/v0/postings/${board}?mode=json&limit=100&skip=${page * 100}`,
      );
      const jobs = normalizeResponse("lever", payload, company);
      all.push(...jobs);
      if (jobs.length < 100) return all;
    }
    throw Error(
      "Lever pagination exceeded 10,000 postings; review source limits",
    );
  }
  if (company.ats === "smartrecruiters") {
    const all: Posting[] = [];
    for (let page = 0; page < 100; page++) {
      const payload = obj.parse(
        await fetcher(
          `https://api.smartrecruiters.com/v1/companies/${board}/postings?limit=100&offset=${page * 100}`,
        ),
      );
      const content = array.parse(payload.content);
      for (const p of content) {
        const detail = await fetcher(
          `https://api.smartrecruiters.com/v1/companies/${board}/postings/${encodeURIComponent(str(p.id))}`,
        );
        all.push(
          ...normalizeResponse(
            "smartrecruiters",
            { content: [detail] },
            company,
          ),
        );
      }
      if (content.length < 100) return all;
    }
    throw Error("SmartRecruiters pagination limit reached");
  }
  throw Error("Company ATS is unsupported");
}
export function buildQueries(bank: Bank, spec: string) {
  const section = specSections(spec, [6]);
  const rows = section
    .split("\n")
    .filter(
      (l) =>
        l.startsWith("|") &&
        !l.startsWith("|---") &&
        !l.includes("Keywords and phrases"),
    );
  const groups = rows
    .map(
      (l) =>
        l
          .split("|")[2]
          ?.split(";")
          .map((t) => t.trim())
          .filter(Boolean) || [],
    )
    .filter((g) => g.length >= 2);
  const titles = bank.job_preferences.target_titles;
  const responsibilities = titles.map((title, n) => ({
    text: `${title} ${groups[n % groups.length][0]} ${groups[n % groups.length][1]}`,
    responsibilityBased: true,
  }));
  return [
    ...responsibilities,
    ...titles.map((title) => ({ text: title, responsibilityBased: false })),
  ];
}
export async function fetchAggregator(
  source: "jsearch" | "adzuna",
  query: string,
  fetcher: FetchJson = throttledFetch,
) {
  if (source === "jsearch") {
    if (!process.env.JSEARCH_API_KEY) throw Error("JSearch key missing");
    return normalizeResponse(
      source,
      await fetcher(
        `https://jsearch.p.rapidapi.com/search?${new URLSearchParams({ query, page: "1", num_pages: "1", country: "us", date_posted: "month" })}`,
        {
          "x-rapidapi-key": process.env.JSEARCH_API_KEY,
          "x-rapidapi-host": "jsearch.p.rapidapi.com",
        },
      ),
    );
  }
  if (!process.env.ADZUNA_APP_ID || !process.env.ADZUNA_APP_KEY)
    throw Error("Adzuna credentials missing");
  return normalizeResponse(
    source,
    await fetcher(
      `https://api.adzuna.com/v1/api/jobs/us/search/1?${new URLSearchParams({ app_id: process.env.ADZUNA_APP_ID, app_key: process.env.ADZUNA_APP_KEY, what: query, results_per_page: "20", "content-type": "application/json" })}`,
    ),
  );
}
