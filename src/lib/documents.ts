import { z } from "zod";
import { Document, Packer, Paragraph, TextRun, HeadingLevel } from "docx";
import { mkdirSync, writeFileSync } from "node:fs";
import { Bank, Bullet } from "./bank";
import { registeredInputs } from "./inputs";
import { callModel, ModelCall } from "./model";
import { Draft, draftSchema, judgeSchema, lineSchema } from "./schemas";
import { exec, row, transaction, now, uid } from "./db";
import { getJob, extractPosting } from "./postings";
import { revalidateJob } from "./listing";
import generation from "../../config/generation.json";
import { artifactDirectory } from "./storage";
import { join } from "node:path";

export type Line = z.infer<typeof lineSchema>;
const verbPairs: Record<string, string> = {
  owned: "own",
  drove: "drive",
  collaborated: "collaborate",
  introduced: "introduce",
  worked: "work",
  defined: "define",
  partnered: "partner",
  translated: "translate",
  analyzed: "analyze",
  resolved: "resolve",
  broke: "break",
  wrote: "write",
  maintained: "maintain",
  compiled: "compile",
  executed: "execute",
  authored: "author",
  facilitated: "facilitate",
  oversaw: "oversee",
  managed: "manage",
  served: "serve",
  coordinated: "coordinate",
  gathered: "gather",
  planned: "plan",
  ran: "run",
  helped: "help",
  specified: "specify",
  built: "build",
  designed: "design",
  rolled: "roll",
  created: "create",
  used: "use",
  led: "lead",
  developed: "develop",
  shipped: "ship",
  launched: "launch",
};
export function requiredTense(line: Line, bank: Bank) {
  const b = bank.bullets.find((b) => b.id === line.source_ids[0]);
  if (!b) return null;
  const role = bank.experience.find((r) => r.id === b.role_id);
  if (!role) return null;
  const team = role.teams.find((t) => t.id === b.team_id);
  return role.is_current && (!team || team.display_end === "Present")
    ? "present"
    : "past";
}
export function openingTense(text: string, tense: "present" | "past") {
  const mapping =
    tense === "present"
      ? verbPairs
      : Object.fromEntries(
          Object.entries(verbPairs).map(([past, present]) => [present, past]),
        );
  return text.replace(
    /^(\w+)( and (\w+))?/,
    (
      match,
      first: string,
      and: string | undefined,
      second: string | undefined,
    ) => {
      const change = (word: string) => {
        const changed = mapping[word.toLowerCase()] || word.toLowerCase();
        return /^[A-Z]/.test(word)
          ? changed[0].toUpperCase() + changed.slice(1)
          : changed;
      };
      return change(first) + (and ? ` and ${change(second!)}` : "");
    },
  );
}
export type Flag = {
  index: number;
  severity: "error" | "warning";
  reason: string;
};
export type DocumentRecord = {
  id: string;
  job_id: string;
  kind: "resume" | "cover_letter";
  version: number;
  bank_version: string;
  spec_version: string;
  bank_hash: string;
  spec_hash: string;
  content: string;
  citations: string;
  verification_report: string;
  approved_by_user: number;
  file_path: string | null;
};
export type ResumeContent = {
  summary: Line[];
  experience: Line[];
  skill_ids: string[];
};
export const resumeSchema = z.object({
  summary: z.array(lineSchema),
  experience: z.array(lineSchema),
  skill_ids: z.array(z.string()),
});
export const coverSchema = z.object({
  paragraphs: z
    .array(z.object({ sentences: z.array(lineSchema) }))
    .min(3)
    .max(4),
});
const flagsSchema = z.array(
  z.object({
    index: z.number(),
    severity: z.enum(["error", "warning"]),
    reason: z.string(),
  }),
);
export function sourcePool(bank: Bank) {
  return [...bank.bullets, ...bank.strengths].filter(
    (s) =>
      s.usable_in_generation &&
      ["confirmed", "no_known_conflict"].includes(s.verification_status),
  );
}
export function selectBullets(
  bank: Bank,
  ranks: { id: string; score: number }[],
) {
  const rank = new Map(ranks.map((r) => [r.id, r.score]));
  const pool = bank.bullets
    .filter((b) => b.usable_in_generation)
    .sort(
      (a, b) =>
        (rank.get(b.id) || 0) - (rank.get(a.id) || 0) ||
        a.id.localeCompare(b.id),
    );
  const groups = new Set<string>();
  const result: Bullet[] = [];
  for (const [index, role] of bank.experience.entries()) {
    let count = 0;
    for (const b of pool.filter((b) => b.role_id === role.id)) {
      if (
        groups.has(b.variant_group) ||
        count >=
          (generation.roleBulletCaps[index] || generation.defaultBulletCap)
      )
        continue;
      groups.add(b.variant_group);
      result.push(b);
      count++;
    }
  }
  return result;
}
export function matchSkills(bank: Bank, posting: string) {
  const normalized = posting.toLowerCase();
  return bank.skills
    .filter(
      (s) =>
        ["direct", "adjacent", "listed_only"].includes(s.evidence_level) &&
        [s.name, ...s.aliases].some((name) =>
          new RegExp(
            `(^|[^a-z0-9])${name.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`,
            "i",
          ).test(normalized),
        ),
    )
    .map((s) => s.id);
}
function expectedExperienceLabel(line: Line, bank: Bank) {
  const bullets = line.source_ids.map((id) =>
    bank.bullets.find((bullet) => bullet.id === id),
  );
  if (bullets.some((bullet) => !bullet)) return null;
  const roleIds = new Set(bullets.map((bullet) => bullet!.role_id));
  const teamIds = new Set(bullets.map((bullet) => bullet!.team_id));
  if (roleIds.size !== 1 || teamIds.size !== 1) return null;
  const role = bank.experience.find((role) => role.id === bullets[0]!.role_id);
  if (!role) return null;
  const teamId = bullets[0]!.team_id;
  const team = teamId ? role.teams.find((team) => team.id === teamId) : null;
  const dates = team
    ? `${team.display_start}–${team.display_end}`
    : `${role.display_start}–${role.display_end}`;
  return [role.company, role.title, ...(team ? [team.name] : []), dates].join(
    " | ",
  );
}
export function stripExperienceLabel(line: Line, bank: Bank): Line {
  const label = expectedExperienceLabel(line, bank);
  const prefix = label ? `${label}: ` : "";
  if (prefix && line.text.startsWith(prefix))
    return { ...line, text: line.text.slice(prefix.length) };
  // The renderer derives role/team headings from the cited source. Treat a
  // model-added heading as metadata even if it chose a different team label.
  const bullet = bank.bullets.find((bullet) => bullet.id === line.source_ids[0]);
  const role = bullet && bank.experience.find((role) => role.id === bullet.role_id);
  if (!role) return line;
  const company = role.company.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const metadata = new RegExp(
    `^${company}\\s*\\|[^\\n:]{1,200}:\\s*`,
  );
  return metadata.test(line.text)
    ? { ...line, text: line.text.replace(metadata, "") }
    : line;
}
export function verifyLines(
  lines: Line[],
  bank: Bank,
  uniqueVariants = false,
): Flag[] {
  const pool = new Map(sourcePool(bank).map((s) => [s.id, s]));
  const flags: Flag[] = [];
  const variants = new Set<string>();
  for (const [index, line] of lines.entries()) {
    const error = (reason: string) =>
      flags.push({ index, severity: "error", reason });
    if (!line.source_ids.length) {
      error("Line has no source citations");
      continue;
    }
    const sources = line.source_ids.map((id) => pool.get(id));
    if (sources.some((s) => !s)) {
      error("Citation missing, retired, evidence-only, or not usable");
      continue;
    }
    const claimText = stripExperienceLabel(line, bank).text;
    const texts = sources
      .map((s) => s!.text)
      .join(" ")
      .toLowerCase();
    const normalizeVerbs = (text: string) =>
      text.replace(
        /\b[a-z]+\b/gi,
        (word) => verbPairs[word.toLowerCase()] || word.toLowerCase(),
      );
    const normalizedSources = normalizeVerbs(texts);
    const normalizedLine = normalizeVerbs(claimText);
    const nums = claimText.match(/\d[\d,.]*(?:%|\+)?/g) || [];
    for (const number of nums)
      if (!new Set(texts.match(/\d[\d,.]*(?:%|\+)?/g) || []).has(number))
        error(`Number ${number} is absent from cited sources`);
    for (const word of [
      "led",
      "owned",
      "organization-wide",
      "organisation-wide",
      "enterprise",
      "end-to-end",
      "audit",
      "architected",
      "built",
      "developed",
      "shipped",
      "launched",
    ])
      if (
        new RegExp(`\\b${normalizeVerbs(word)}\\b`, "i").test(normalizedLine) &&
        !new RegExp(`\\b${normalizeVerbs(word)}\\b`, "i").test(
          normalizedSources,
        )
      )
        error(`Scope word "${word}" exceeds cited sources`);
    const guardrailRules: Record<string, RegExp> = {
      "g-08":
        /\b(built|developed|created|implemented)\b.{0,50}\b(dashboards?|production dashboard queries)\b/i,
      "g-09":
        /advanced SQL|complex joins|warehouse model|analytics engineering/i,
      "g-16": /organi[sz]ation[- ]wide|enterprise[- ]wide/i,
      "g-17":
        /organi[sz]ation[- ]wide.{0,30}(transformation|scrum|agile|coaching)/i,
      "g-18": /Copilot|Gemini|AI.{0,30}(efficiency gain|time saved)/i,
      "g-20":
        /API (design|ownership)|integration engineering|software engineering|ML architecture|MLOps|automation engineering/i,
      "g-22": /(shipped|production|launched).{0,30}AI product/i,
      "g-23": /Tableau|Power BI|Looker|Qlik|MicroStrategy|Domo|Sisense/i,
    };
    for (const g of bank.guardrails)
      if (guardrailRules[g.id]?.test(claimText)) error(`${g.id}: ${g.rule}`);
    for (const url of claimText.match(/https?:\/\/\S+/g) || []) {
      const approved = (bank.portfolio_links as Record<string, unknown>[]).some(
        (p) => p.url === url && p.approved_for_applications === true,
      );
      if (!approved && !texts.includes(url.toLowerCase()))
        error("Unapproved portfolio or unsupported URL");
    }
    if (uniqueVariants) {
      const tense = requiredTense(line, bank);
      if (tense && openingTense(claimText, tense) !== claimText)
        error(`Use ${tense} tense for this role/team`);
      for (const s of sources) {
        const b = bank.bullets.find((b) => b.id === s!.id);
        if (!b) {
          error("Experience lines must cite usable bullets");
          continue;
        }
        if (variants.has(b.variant_group))
          error(`Duplicate variant group ${b.variant_group}`);
        variants.add(b.variant_group);
      }
      const roleIds = new Set(sources.map((s) => (s as Bullet).role_id));
      const teams = new Set(sources.map((s) => (s as Bullet).team_id));
      if (roleIds.size > 1 || teams.size > 1)
        error("An experience line must stay within one role and team");
    }
  }
  return flags;
}
export function getDocument(id: string) {
  const d = row<DocumentRecord>("SELECT * FROM documents WHERE id=?", id);
  if (!d) throw Error("Document not found");
  return d;
}
export function documentLines(d: DocumentRecord) {
  return d.kind === "resume"
    ? ((x: ResumeContent) => [...x.summary, ...x.experience])(
        resumeSchema.parse(JSON.parse(d.content)),
      )
    : coverSchema
        .parse(JSON.parse(d.content))
        .paragraphs.flatMap((p) => p.sentences);
}
function persistDocument(
  jobId: string,
  kind: "resume" | "cover_letter",
  content: unknown,
  flags: Flag[],
  base?: Pick<
    DocumentRecord,
    "bank_version" | "spec_version" | "bank_hash" | "spec_hash"
  >,
) {
  const i = registeredInputs();
  const id = uid();
  const version =
    (row<{ v: number }>(
      "SELECT MAX(version) AS v FROM documents WHERE job_id=? AND kind=?",
      jobId,
      kind,
    )?.v || 0) + 1;
  const lines =
    kind === "resume"
      ? ((c: ResumeContent) => [...c.summary, ...c.experience])(
          resumeSchema.parse(content),
        )
      : coverSchema.parse(content).paragraphs.flatMap((p) => p.sentences);
  exec(
    "INSERT INTO documents(id,job_id,kind,version,bank_version,spec_version,bank_hash,spec_hash,content,citations,verification_report,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)",
    id,
    jobId,
    kind,
    version,
    base?.bank_version || i.bankVersion,
    base?.spec_version || i.specVersion,
    base?.bank_hash || i.bankHash,
    base?.spec_hash || i.specHash,
    JSON.stringify(content),
    JSON.stringify(lines.map((l) => l.source_ids)),
    JSON.stringify(flags),
    now(),
  );
  return id;
}
async function modelVerify(
  lines: Line[],
  bank: Bank,
  model: ModelCall,
  signal?: AbortSignal,
) {
  const result = await model(
    "verify every factual line against sources and all guardrails",
    judgeSchema,
    {
      lines: lines.map((line, index) => ({
        index,
        ...line,
        sources: line.source_ids.map((id) =>
          sourcePool(bank).find((s) => s.id === id),
        ),
      })),
    },
    {
      bank: {
        guardrails: bank.guardrails,
        generation_policy: bank.generation_policy,
      },
      sections: [2, 25],
      signal,
      validate: (r) => {
        if (
          r.lines.length !== lines.length ||
          new Set(r.lines.map((x) => x.index)).size !== lines.length ||
          r.lines.some((x) => x.index >= lines.length)
        )
          throw Error("Judge must return exactly one result for every line");
      },
    },
  );
  return result.lines
    .filter((l) => l.verdict !== "supported" || l.guardrails_violated.length)
    .map(
      (l) =>
        ({
          index: l.index,
          severity:
            l.verdict === "unsupported" || l.guardrails_violated.length
              ? "error"
              : "warning",
          reason: [l.reason, ...l.guardrails_violated].join("; "),
        }) as Flag,
    );
}
export async function prepareDocuments(
  jobId: string,
  manualConfirmed = false,
  model: ModelCall = callModel,
) {
  const started = Date.now();
  const signal = AbortSignal.timeout(generation.timeoutMs);
  const job = await revalidateJob(jobId, manualConfirmed);
  const i = registeredInputs();
  const x = await extractPosting(job, model, signal);
  const rankingSchema = z.object({
    ranks: z.array(
      z.object({
        id: z.string(),
        score: z.number().min(0).max(10),
        reason: z.string(),
      }),
    ),
  });
  const pool = i.bank.bullets.filter((b) => b.usable_in_generation);
  const ranked = await model(
    "rank usable bullets for relevance",
    rankingSchema,
    { posting: x, candidates: pool },
    {
      bank: { generation_policy: i.bank.generation_policy },
      signal,
      validate: (r) => {
        if (
          r.ranks.length !== pool.length ||
          new Set(r.ranks.map((x) => x.id)).size !== pool.length ||
          r.ranks.some((r) => !pool.some((b) => b.id === r.id))
        )
          throw Error("Rank each usable bullet exactly once");
      },
    },
  );
  const selected = selectBullets(i.bank, ranked.ranks);
  const draft = await model(
    "reword documents",
    draftSchema,
    {
      posting: x,
      selected: selected.map((b) => ({
        ...b,
        required_tense: requiredTense(
          { text: b.text, source_ids: [b.id] },
          i.bank,
        ),
      })),
      instructions:
        "Return one experience line per selected bullet. Never merge bullets from different role/team headings. Resume experience text must contain only the accomplishment sentence: do not add company, title, team, dates, or a heading because the renderer supplies them. Follow generation_policy tense using role/team dates. Generate a fresh summary from selected bullets or usable strengths. Cover letter: 3–4 short paragraphs, every factual sentence cited. Do not copy evidence text. Keep unsupported skills out. Never add a number, tool, outcome or scope. Use only selected bullets and usable strengths. List candidate-evidence questions for unsupported posting requirements in questions_before_applying. Approved portfolio links may support relevant training/enablement/Agile/product-operations applications only.",
    },
    {
      strong: true,
      sections: [2, 25],
      bank: {
        selected,
        strengths: i.bank.strengths.filter((s) => s.usable_in_generation),
        experience: i.bank.experience,
        guardrails: i.bank.guardrails,
        generation_policy: i.bank.generation_policy,
        portfolio_links: (
          i.bank.portfolio_links as Record<string, unknown>[]
        ).filter((p) => p.approved_for_applications === true),
      },
      signal,
      validate: (d) => {
        const allowed = new Set(
          [
            ...selected,
            ...i.bank.strengths.filter((s) => s.usable_in_generation),
          ].map((b) => b.id),
        );
        if (
          [
            ...d.summary,
            ...d.experience,
            ...d.cover_letter.flatMap((p) => p.sentences),
          ].some((l) => l.source_ids.some((id) => !allowed.has(id)))
        )
          throw Error("Draft used an unselected or unusable source");
        if (d.experience.length !== selected.length)
          throw Error("Return one experience line per selected bullet");
      },
    },
  );
  const resume: ResumeContent = {
    summary: draft.summary,
    experience: draft.experience.map((line) =>
      stripExperienceLabel(line, i.bank),
    ),
    skill_ids: matchSkills(i.bank, job.description),
  };
  const resumeLines = [...draft.summary, ...draft.experience];
  const coverLines = draft.cover_letter.flatMap((p) => p.sentences);
  const deterministic = [
    ...verifyLines(draft.summary, i.bank),
    ...verifyLines(draft.experience, i.bank, true).map((f) => ({
      ...f,
      index: f.index + draft.summary.length,
    })),
    ...verifyLines(coverLines, i.bank).map((f) => ({
      ...f,
      index: f.index + resumeLines.length,
    })),
  ];
  const judged = await modelVerify(
    [...resumeLines, ...coverLines],
    i.bank,
    model,
    signal,
  );
  const flags = [...deterministic, ...judged];
  const current = registeredInputs();
  if (current.bankHash !== i.bankHash || current.specHash !== i.specHash)
    throw Error("Inputs changed during generation. Prepare again.");
  const ids = transaction(() => {
    const provenance = {
      bank_version: i.bankVersion,
      spec_version: i.specVersion,
      bank_hash: i.bankHash,
      spec_hash: i.specHash,
    };
    const resumeId = persistDocument(
      jobId,
      "resume",
      resume,
      flags.filter((f) => f.index < resumeLines.length),
      provenance,
    );
    const coverId = persistDocument(
      jobId,
      "cover_letter",
      { paragraphs: draft.cover_letter },
      flags
        .filter((f) => f.index >= resumeLines.length)
        .map((f) => ({ ...f, index: f.index - resumeLines.length })),
      provenance,
    );
    for (const question of draft.questions_before_applying)
      exec(
        "INSERT INTO bank_questions(id,job_id,question,created_at) SELECT ?,?,?,? WHERE NOT EXISTS(SELECT id FROM bank_questions WHERE job_id=? AND question=?)",
        uid(),
        jobId,
        question,
        now(),
        jobId,
        question,
      );
    saveApplication(jobId, {
      status: "Preparing",
      resume_document_id: resumeId,
      cover_document_id: coverId,
    });
    return { resumeId, coverId };
  });
  return { ...ids, durationMs: Date.now() - started };
}
export async function reviseDocument(
  id: string,
  index: number,
  text: string,
  regenerate = false,
  model: ModelCall = callModel,
) {
  const d = getDocument(id);
  const i = registeredInputs();
  if (d.bank_hash !== i.bankHash || d.spec_hash !== i.specHash)
    throw Error("Inputs changed; generate a new document first.");
  const content =
    d.kind === "resume"
      ? resumeSchema.parse(JSON.parse(d.content))
      : coverSchema.parse(JSON.parse(d.content));
  const lines =
    d.kind === "resume"
      ? [
          ...(content as ResumeContent).summary,
          ...(content as ResumeContent).experience,
        ]
      : (content as z.infer<typeof coverSchema>).paragraphs.flatMap(
          (p) => p.sentences,
        );
  const line = lines[index];
  if (!line) throw Error("Line not found");
  if (regenerate) {
    const replacement = await model(
      "reword one cited line",
      lineSchema,
      {
        line,
        posting: getJob(d.job_id).description,
        instructions:
          "Keep exactly the same source_ids and preserve role/team attribution.",
      },
      {
        strong: true,
        bank: {
          sources: line.source_ids.map((id) =>
            sourcePool(i.bank).find((s) => s.id === id),
          ),
          guardrails: i.bank.guardrails,
          generation_policy: i.bank.generation_policy,
        },
        validate: (r) => {
          if (
            [...r.source_ids].sort().join() !==
            [...line.source_ids].sort().join()
          )
            throw Error("Regeneration changed citations");
        },
      },
    );
    line.text = replacement.text;
  } else line.text = lineSchema.parse({ ...line, text }).text;
  const flags =
    d.kind === "resume"
      ? [
          ...verifyLines((content as ResumeContent).summary, i.bank),
          ...verifyLines(
            (content as ResumeContent).experience,
            i.bank,
            true,
          ).map((f) => ({
            ...f,
            index: f.index + (content as ResumeContent).summary.length,
          })),
        ]
      : verifyLines(lines, i.bank);
  flags.push(...(await modelVerify(lines, i.bank, model)));
  return persistDocument(d.job_id, d.kind, content, flags, d);
}
export async function approveDocument(id: string) {
  const d = getDocument(id);
  const i = registeredInputs();
  if (d.bank_hash !== i.bankHash || d.spec_hash !== i.specHash)
    throw Error("Document inputs are stale. Regenerate before export.");
  const flags = flagsSchema.parse(JSON.parse(d.verification_report));
  const lines = documentLines(d);
  const content =
    d.kind === "resume" ? resumeSchema.parse(JSON.parse(d.content)) : null;
  const errors =
    d.kind === "resume"
      ? [
          ...verifyLines(content!.summary, i.bank),
          ...verifyLines(content!.experience, i.bank, true),
        ]
      : verifyLines(lines, i.bank);
  if ([...flags, ...errors].some((f) => f.severity === "error"))
    throw Error(
      "Unsupported claims or guardrail violations block export. Edit the flagged lines and verify again.",
    );
  const job = getJob(d.job_id);
  const buffer = await renderDocx(i.bank, d, job.employer, job.title);
  const outputDirectory = artifactDirectory("documents");
  mkdirSync(outputDirectory, { recursive: true });
  const safe = (v: string) => v.replace(/[^a-z0-9_-]/gi, "_").slice(0, 90);
  const file = join(
    outputDirectory,
    `${safe(i.bank.contact.full_name)}_${d.kind === "resume" ? "Resume" : "Cover_Letter"}_${safe(job.employer)}_${safe(job.title)}_v${d.version}_${d.id}.docx`,
  );
  writeFileSync(file, buffer);
  exec(
    "UPDATE documents SET approved_by_user=1,file_path=? WHERE id=?",
    file,
    id,
  );
  return file;
}
export async function renderDocx(
  bank: Bank,
  d: DocumentRecord,
  employer: string,
  title: string,
) {
  const p = (text: string, bold = false) =>
    new Paragraph({
      children: [new TextRun({ text, bold })],
      spacing: { after: 100 },
    });
  const heading = (text: string) =>
    new Paragraph({
      text,
      heading: HeadingLevel.HEADING_1,
      spacing: { before: 200, after: 100 },
      keepNext: true,
    });
  const children: Paragraph[] = [
    new Paragraph({
      children: [
        new TextRun({ text: bank.contact.full_name, bold: true, size: 30 }),
      ],
    }),
    p(
      [bank.contact.email, bank.contact.phone, bank.contact.linkedin_url].join(
        " | ",
      ),
    ),
  ];
  if (d.kind === "resume") {
    const c = resumeSchema.parse(JSON.parse(d.content));
    children.push(
      heading("Summary"),
      ...c.summary.map((l) => p(l.text)),
      heading("Experience"),
    );
    for (const role of bank.experience) {
      const lines = c.experience.filter((l) =>
        bank.bullets.some(
          (b) => b.id === l.source_ids[0] && b.role_id === role.id,
        ),
      );
      if (!lines.length) continue;
      children.push(
        p(`${role.title} | ${role.company}`, true),
        p(`${role.display_start} – ${role.display_end}`),
      );
      for (const teamId of [null, ...role.teams.map((t) => t.id)]) {
        const group = lines.filter(
          (l) =>
            bank.bullets.find((b) => b.id === l.source_ids[0])?.team_id ===
            teamId,
        );
        if (!group.length) continue;
        if (teamId) {
          const team = role.teams.find((t) => t.id === teamId)!;
          children.push(
            p(
              `${team.name} | ${team.display_start} – ${team.display_end}`,
              true,
            ),
          );
        }
        children.push(
          ...group.map(
            (l) =>
              new Paragraph({
                text: l.text,
                bullet: { level: 0 },
                spacing: { after: 100 },
              }),
          ),
        );
      }
    }
    children.push(
      heading("Skills"),
      p(
        c.skill_ids
          .map((id) => bank.skills.find((s) => s.id === id)?.name || "")
          .filter(Boolean)
          .join(" · "),
      ),
      heading("Education"),
    );
    for (const edu of bank.education)
      children.push(
        p(`${edu.degree} | ${edu.institution} | ${edu.graduation_date}`),
      );
    children.push(heading("Certifications"));
    for (const cert of bank.certifications)
      children.push(p(`${cert.name} | ${cert.issuer} | ${cert.date}`));
  } else {
    children.push(
      p(`Re: ${title} at ${employer}`, true),
      p("Dear Hiring Team,"),
      ...coverSchema
        .parse(JSON.parse(d.content))
        .paragraphs.map((g) => p(g.sentences.map((s) => s.text).join(" "))),
      p("Sincerely,"),
      p(bank.contact.full_name),
    );
  }
  return Packer.toBuffer(
    new Document({
      styles: {
        default: {
          document: {
            run: { font: "Calibri", size: 21, color: "000000" },
            paragraph: { spacing: { line: 250 } },
          },
        },
        paragraphStyles: [
          {
            id: "Heading1",
            name: "Heading 1",
            basedOn: "Normal",
            next: "Normal",
            quickFormat: true,
            run: { font: "Calibri", size: 23, bold: true, color: "000000" },
          },
        ],
      },
      sections: [
        {
          properties: {
            page: { margin: { top: 720, right: 720, bottom: 720, left: 720 } },
          },
          children,
        },
      ],
    }),
  );
}
export function saveApplication(
  jobId: string,
  patch: {
    status?: string;
    resume_document_id?: string | null;
    cover_document_id?: string | null;
    notes?: string;
    contacts?: string;
    follow_up_on?: string | null;
  },
) {
  const old = row<{
    id: string;
    status: string;
    status_history: string;
    resume_document_id: string | null;
    cover_document_id: string | null;
    notes: string;
    contacts: string;
    follow_up_on: string | null;
    applied_at: string | null;
  }>("SELECT * FROM applications WHERE job_id=?", jobId);
  const status = patch.status || old?.status || "Saved";
  if (
    ![
      "Saved",
      "Preparing",
      "Applied",
      "Interviewing",
      "Offer",
      "Rejected",
      "Withdrawn",
      "Closed",
    ].includes(status)
  )
    throw Error("Invalid application status");
  const resume =
    patch.resume_document_id === undefined
      ? old?.resume_document_id || null
      : patch.resume_document_id;
  const cover =
    patch.cover_document_id === undefined
      ? old?.cover_document_id || null
      : patch.cover_document_id;
  for (const [id, kind] of [
    [resume, "resume"],
    [cover, "cover_letter"],
  ] as const) {
    if (id) {
      const d = getDocument(id);
      if (d.job_id !== jobId || d.kind !== kind)
        throw Error("Application document belongs to another job or kind");
      if (status === "Applied" && !d.approved_by_user)
        throw Error("Approve the exact documents before recording Applied");
    }
  }
  if (status === "Applied" && !resume)
    throw Error("Choose the resume version sent with this application");
  const history = z
    .array(
      z.object({
        status: z.string(),
        at: z.string(),
        resume_document_id: z.string().nullable().optional(),
        cover_document_id: z.string().nullable().optional(),
      }),
    )
    .parse(JSON.parse(old?.status_history || "[]"));
  if (
    status !== old?.status ||
    resume !== old?.resume_document_id ||
    cover !== old?.cover_document_id
  )
    history.push({
      status,
      at: now(),
      resume_document_id: resume,
      cover_document_id: cover,
    });
  exec(
    "INSERT INTO applications(id,job_id,status,status_history,applied_at,resume_document_id,cover_document_id,contacts,notes,follow_up_on) VALUES(?,?,?,?,?,?,?,?,?,?) ON CONFLICT(job_id) DO UPDATE SET status=excluded.status,status_history=excluded.status_history,applied_at=excluded.applied_at,resume_document_id=excluded.resume_document_id,cover_document_id=excluded.cover_document_id,contacts=excluded.contacts,notes=excluded.notes,follow_up_on=excluded.follow_up_on",
    old?.id || uid(),
    jobId,
    status,
    JSON.stringify(history),
    status === "Applied" ? old?.applied_at || now() : old?.applied_at || null,
    resume,
    cover,
    patch.contacts ?? old?.contacts ?? "[]",
    patch.notes ?? old?.notes ?? "",
    patch.follow_up_on === undefined
      ? old?.follow_up_on || null
      : patch.follow_up_on,
  );
}
