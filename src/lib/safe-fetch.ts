const hosts = new Set([
  "boards-api.greenhouse.io",
  "api.greenhouse.io",
  "api.lever.co",
  "api.eu.lever.co",
  "api.ashbyhq.com",
  "api.smartrecruiters.com",
  "jsearch.p.rapidapi.com",
  "api.adzuna.com",
]);
export async function fetchSource(
  url: string,
  headers: Record<string, string> = {},
) {
  const u = new URL(url);
  if (
    u.protocol !== "https:" ||
    !hosts.has(u.hostname) ||
    u.username ||
    u.password ||
    u.port
  )
    throw Error("Unsupported source URL");
  const r = await fetch(u, {
    headers: {
      "User-Agent": "PersonalJobFinder/0.1 (private job-board reader)",
      ...headers,
    },
    signal: AbortSignal.timeout(15000),
    redirect: "error",
  });
  if (!r.ok) throw Error(`Source returned HTTP ${r.status}`);
  const bytes = await r.arrayBuffer();
  if (bytes.byteLength > 15_000_000) throw Error("Source response too large");
  return JSON.parse(new TextDecoder().decode(bytes)) as unknown;
}
export type AtsReference = {
  source: "greenhouse" | "lever" | "ashby" | "smartrecruiters";
  board: string;
  id: string;
};
export function atsReference(url: string): AtsReference | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" || u.username || u.password || u.port)
    return null;
  const p = u.pathname.split("/").filter(Boolean);
  if (
    ["boards.greenhouse.io", "job-boards.greenhouse.io"].includes(u.hostname) &&
    p.length >= 3 &&
    p[1] === "jobs"
  )
    return { source: "greenhouse", board: p[0], id: p[2] };
  if (u.hostname === "jobs.lever.co" && p.length >= 2)
    return { source: "lever", board: p[0], id: p[1] };
  if (u.hostname === "jobs.ashbyhq.com" && p.length >= 2)
    return { source: "ashby", board: p[0], id: p[1] };
  if (u.hostname === "jobs.smartrecruiters.com" && p.length >= 2)
    return { source: "smartrecruiters", board: p[0], id: p[1].split("-")[0] };
  return null;
}
export const stripHtml = (html: string) =>
  html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<\/(?:p|div|li|h\d)>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"');
