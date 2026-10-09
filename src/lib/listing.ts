import { atsReference, fetchSource, stripHtml } from "./safe-fetch";
import { getJob, Job } from "./postings";
import { exec, now } from "./db";
import { sha256 } from "./bank";
import { z } from "zod";
type Entry = Record<string, unknown>;
export async function fetchAtsPosting(
  url: string,
): Promise<{ text: string; open: boolean } | null> {
  const ref = atsReference(url);
  if (!ref) return null;
  const board = encodeURIComponent(ref.board);
  const id = encodeURIComponent(ref.id);
  try {
    if (ref.source === "greenhouse") {
      const p = (await fetchSource(
        `https://boards-api.greenhouse.io/v1/boards/${board}/jobs/${id}`,
      )) as Entry;
      return {
        text: `${p.title}\nLocation: ${JSON.stringify(p.location || {})}\n${stripHtml(String(p.content || ""))}`,
        open: !!p.id,
      };
    }
    if (ref.source === "lever") {
      const p = (await fetchSource(
        `https://api.lever.co/v0/postings/${board}/${id}`,
      )) as Entry;
      return {
        text: `${p.text}\nCategories: ${JSON.stringify(p.categories || {})}\nSalary: ${JSON.stringify(p.salaryRange || {})}\n${stripHtml(String(p.description || ""))}\n${((p.lists as Entry[]) || []).map((x) => stripHtml(String(x.content))).join("\n")}`,
        open: !!p.id,
      };
    }
    if (ref.source === "ashby") {
      const p = (await fetchSource(
        `https://api.ashbyhq.com/posting-api/job-board/${board}`,
      )) as { jobs: Entry[] };
      const job = z
        .array(z.record(z.string(), z.unknown()))
        .parse(p.jobs)
        .find(
          (x) =>
            x.id === ref.id ||
            atsReference(String(x.jobUrl || ""))?.id === ref.id,
        );
      return job
        ? {
            text: `${job.title}\nLocation: ${job.location}\nWorkplace: ${job.workplaceType || ""}\nEmployment: ${job.employmentType || ""}\nSalary: ${JSON.stringify(job.compensation || {})}\n${job.descriptionPlain || stripHtml(String(job.descriptionHtml || ""))}`,
            open: true,
          }
        : { text: "", open: false };
    }
    const p = (await fetchSource(
      `https://api.smartrecruiters.com/v1/companies/${board}/postings/${id}`,
    )) as Entry;
    return {
      text: `${p.name}\nEmployer: ${JSON.stringify(p.company || {})}\nLocation: ${JSON.stringify(p.location || {})}\nEmployment: ${JSON.stringify(p.typeOfEmployment || {})}\n${stripHtml(JSON.stringify(p.jobAd || ""))}`,
      open: !!p.id,
    };
  } catch (e) {
    if (/HTTP (404|410)/.test(String(e))) return { text: "", open: false };
    throw e;
  }
}
export async function revalidateJob(
  id: string,
  manualConfirmed = false,
): Promise<Job> {
  const j = getJob(id);
  if (j.canonical_url && atsReference(j.canonical_url)) {
    const live = await fetchAtsPosting(j.canonical_url);
    if (!live?.open) {
      exec(
        "UPDATE jobs SET listing_status='closed',official_verified=1 WHERE id=?",
        id,
      );
      throw Error(
        "The official listing is closed. Application preparation is unavailable.",
      );
    }
    exec(
      "UPDATE jobs SET listing_status='open',official_verified=1,aggregator_only=0,last_verified_at=? WHERE id=?",
      now(),
      id,
    );
    if (live.text !== j.description) {
      exec(
        "UPDATE jobs SET description=?,posting_hash=? WHERE id=?",
        live.text,
        sha256(live.text),
        id,
      );
      exec("UPDATE evaluations SET is_current=0 WHERE job_id=?", id);
    }
    return getJob(id);
  }
  if (j.listing_status === "closed") throw Error("This listing is closed.");
  if (!manualConfirmed)
    throw Error(
      "Verify the employer’s listing is open, then check the listing confirmation to continue.",
    );
  exec(
    "UPDATE jobs SET listing_status='open',official_verified=1,last_verified_at=? WHERE id=?",
    now(),
    id,
  );
  return getJob(id);
}
