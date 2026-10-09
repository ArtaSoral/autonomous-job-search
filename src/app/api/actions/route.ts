import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { addManualPosting, extractPosting, getJob } from "@/lib/postings";
import { fetchAtsPosting } from "@/lib/listing";
import { atsReference } from "@/lib/safe-fetch";
import {
  prepareDocuments,
  reviseDocument,
  approveDocument,
  saveApplication,
} from "@/lib/documents";
import { statuses, reasonTags } from "@/lib/schemas";
import { recordFeedback, decideProposal } from "@/lib/feedback";
import { generateWeeklyReport } from "@/lib/quality";
import { answerBankQuestion, exportBankQuestion } from "@/lib/bank-growth";
import { exec, uid } from "@/lib/db";
import { enqueue } from "@/lib/ingest";
import { modelConfigured } from "@/lib/openai-auth";
export const runtime = "nodejs";
// Document preparation revalidates a listing and performs several sequential,
// independently checked model calls. Keep the route budget aligned with it.
export const maxDuration = 300;
const id = z.string().uuid();
const checked = z
  .union([z.boolean(), z.literal("on")])
  .optional()
  .transform((x) => x === true || x === "on");
const schema = z.discriminatedUnion("action", [
  z.object({
    action: z.literal("add_job"),
    text: z.string().max(100000).default(""),
    url: z
      .union([
        z.url().refine((value) => {
          const url = new URL(value);
          return (
            ["http:", "https:"].includes(url.protocol) &&
            !url.username &&
            !url.password
          );
        }, "Use an HTTP or HTTPS posting URL without credentials"),
        z.literal(""),
      ])
      .optional(),
  }),
  z.object({ action: z.literal("extract"), jobId: id }),
  z.object({
    action: z.literal("company"),
    name: z.string().min(1).max(200),
    ats: z.enum(["greenhouse", "lever", "ashby", "smartrecruiters"]),
    board_token: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .max(200),
    notes: z.string().max(20000).default(""),
  }),
  z.object({ action: z.literal("company_toggle"), companyId: id }),
  z.object({ action: z.literal("company_remove"), companyId: id }),
  z.object({ action: z.literal("ingest") }),
  z.object({ action: z.literal("evaluate"), jobId: id }),
  z.object({ action: z.literal("reevaluate_stale") }),
  z.object({
    action: z.literal("feedback"),
    jobId: id,
    thumb: z.enum(["up", "down"]),
    reason_tag: z.enum(reasonTags),
    note: z.string().max(10000).default(""),
  }),
  z.object({
    action: z.literal("proposal"),
    proposalId: id,
    decision: z.enum(["accepted", "rejected"]),
  }),
  z.object({ action: z.literal("quality_report") }),
  z.object({
    action: z.literal("bank_answer"),
    questionId: id,
    answer: z.string().min(1).max(20000),
    role_id: z.string(),
    team_id: z.string().default(""),
  }),
  z.object({
    action: z.literal("bank_export"),
    questionId: id,
    version: z.string().regex(/^\d+\.\d+$/),
    approved: checked,
  }),
  z.object({ action: z.literal("prepare"), jobId: id, confirmed: checked }),
  z.object({
    action: z.literal("revise"),
    documentId: id,
    index: z.coerce.number().int().nonnegative(),
    text: z.string().max(2000),
    regenerate: checked,
  }),
  z.object({ action: z.literal("approve"), documentId: id }),
  z.object({
    action: z.literal("application"),
    jobId: id,
    status: z.enum(statuses),
    notes: z.string().max(20000).optional(),
    contacts: z.string().max(20000).optional(),
    follow_up_on: z.string().optional(),
    resume_document_id: z.union([id, z.literal("")]).optional(),
    cover_document_id: z.union([id, z.literal("")]).optional(),
  }),
]);
export async function POST(request: NextRequest) {
  try {
    const host = request.headers.get("host") || "";
    if (!/^(localhost|127\.0\.0\.1)(:\d+)?$/.test(host))
      throw Error("This private app accepts local requests only");
    const origin = request.headers.get("origin");
    if (origin && new URL(origin).host !== host)
      return NextResponse.json({ error: "Origin rejected" }, { status: 403 });
    const body = await request.text();
    if (body.length > 150000)
      return NextResponse.json({ error: "Request too large" }, { status: 413 });
    const p = schema.parse(JSON.parse(body));
    switch (p.action) {
      case "feedback":
        recordFeedback(p.jobId, p.thumb, p.reason_tag, p.note);
        break;
      case "proposal":
        decideProposal(p.proposalId, p.decision);
        break;
      case "quality_report":
        generateWeeklyReport();
        break;
      case "bank_answer":
        await answerBankQuestion(
          p.questionId,
          p.answer,
          p.role_id,
          p.team_id || null,
        );
        break;
      case "bank_export": {
        const exported = exportBankQuestion(
          p.questionId,
          p.version,
          p.approved,
        );
        return NextResponse.json({
          redirect: `/api/exports/${exported.filename}`,
        });
      }
      case "company":
        exec(
          "INSERT INTO companies(id,name,ats,board_token,notes) VALUES(?,?,?,?,?)",
          uid(),
          p.name,
          p.ats,
          p.board_token,
          p.notes,
        );
        break;
      case "company_toggle":
        exec("UPDATE companies SET active=1-active WHERE id=?", p.companyId);
        break;
      case "company_remove":
        exec("DELETE FROM companies WHERE id=?", p.companyId);
        break;
      case "ingest":
        enqueue("ingest", {});
        break;
      case "evaluate":
        enqueue("evaluate", { jobId: p.jobId });
        break;
      case "reevaluate_stale": {
        const { registeredInputs } = await import("@/lib/inputs");
        registeredInputs();
        const { rows } = await import("@/lib/db");
        for (const job of rows<{ id: string }>(
          "SELECT DISTINCT j.id FROM jobs j JOIN evaluations e ON e.job_id=j.id WHERE e.is_current=0 AND NOT EXISTS(SELECT 1 FROM evaluations c WHERE c.job_id=j.id AND c.is_current=1)",
        ))
          enqueue("evaluate", { jobId: job.id });
        break;
      }
      case "add_job": {
        let text = p.text;
        if (p.url && atsReference(p.url)) {
          const posting = await fetchAtsPosting(p.url);
          if (!posting?.open) throw Error("The official listing is closed");
          text = posting.text;
        }
        if (text.trim().length < 50)
          throw Error(
            "Paste at least 50 characters of the job description, or supply a supported ATS URL",
          );
        const jobId = addManualPosting(text, p.url);
        if (modelConfigured()) {
          try {
            await extractPosting(getJob(jobId));
          } catch {
            /* Saved posting remains available for extraction retry. */
          }
        }
        return NextResponse.json({ redirect: `/jobs/${jobId}` });
      }
      case "extract":
        await extractPosting(getJob(p.jobId));
        break;
      case "prepare": {
        const ids = await prepareDocuments(p.jobId, p.confirmed);
        return NextResponse.json({ redirect: `/documents/${ids.resumeId}` });
      }
      case "revise":
        return NextResponse.json({
          redirect: `/documents/${await reviseDocument(p.documentId, p.index, p.text, p.regenerate)}`,
        });
      case "approve":
        await approveDocument(p.documentId);
        break;
      case "application": {
        let contacts: string | undefined;
        if (p.contacts !== undefined) {
          contacts = JSON.stringify(
            z
              .array(
                z.object({
                  name: z.string(),
                  email: z.string().optional(),
                  note: z.string().optional(),
                }),
              )
              .parse(JSON.parse(p.contacts || "[]")),
          );
        }
        saveApplication(p.jobId, {
          ...p,
          contacts,
          follow_up_on: p.follow_up_on || null,
          resume_document_id: p.resume_document_id || undefined,
          cover_document_id: p.cover_document_id || undefined,
        });
        break;
      }
    }
    return NextResponse.json({ message: "Saved" });
  } catch (e) {
    return NextResponse.json(
      { error: e instanceof Error ? e.message : "Request failed" },
      { status: 400 },
    );
  }
}
