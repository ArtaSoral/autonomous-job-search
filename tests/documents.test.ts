import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { loadInputs } from "../src/lib/bank";
import {
  verifyLines,
  stripExperienceLabel,
  selectBullets,
  renderDocx,
  matchSkills,
  validateDraftSelection,
  validateResumePlan,
  supportingBulletPool,
  prioritizeRoleLeads,
  DocumentRecord,
} from "../src/lib/documents";
import fixtures from "./guardrails/postings.json";
const { bank } = loadInputs();
describe("Phase 2 document safeguards", () => {
  it.each(fixtures)("blocks $guardrail despite posting pressure", (f) => {
    const flags = verifyLines(
      [{ text: f.bad_claim, source_ids: [bank.bullets[0].id] }],
      bank,
    );
    expect(flags.some((x) => x.reason.startsWith(f.guardrail))).toBe(true);
  });
  it("rejects absent citations, evidence and retired sources", () => {
    for (const ids of [
      [],
      ["missing"],
      [bank.evidence[0].id],
      [bank.bullets.find((b) => b.verification_status === "retired")!.id],
    ])
      expect(
        verifyLines([{ text: "Test", source_ids: ids }], bank).length,
      ).toBeGreaterThan(0);
  });
  it("rejects invented numbers and inflated scope", () => {
    expect(
      verifyLines(
        [
          {
            text: "Reduced costs by 55%. Led an audit.",
            source_ids: [bank.bullets[0].id],
          },
        ],
        bank,
      ).some((f) => f.reason.includes("55%")),
    ).toBe(true);
  });
  it("treats an exact renderer label as metadata and strips it from experience text", () => {
    const bullet = bank.bullets.find((bullet) => bullet.usable_in_generation)!;
    const role = bank.experience.find((role) => role.id === bullet.role_id)!;
    const team = bullet.team_id
      ? role.teams.find((team) => team.id === bullet.team_id)
      : null;
    const dates = team
      ? `${team.display_start}–${team.display_end}`
      : `${role.display_start}–${role.display_end}`;
    const line = {
      text: `${[role.company, role.title, ...(team ? [team.name] : []), dates].join(" | ")}: ${bullet.text}`,
      source_ids: [bullet.id],
    };
    expect(stripExperienceLabel(line, bank).text).toBe(bullet.text);
    expect(verifyLines([line], bank, true)).not.toContainEqual(
      expect.objectContaining({ reason: expect.stringMatching(/^Number /) }),
    );
  });
  it("selects exactly one bullet per variant and preserves usable sources", () => {
    const result = selectBullets(
      bank,
      bank.bullets.map((b) => ({ id: b.id, score: 9 })),
    );
    expect(new Set(result.map((b) => b.variant_group)).size).toBe(
      result.length,
    );
    expect(result.every((b) => b.usable_in_generation)).toBe(true);
    expect(
      result.filter((b) => b.role_id === bank.experience[0].id).length,
    ).toBeGreaterThanOrEqual(5);
  });
  it("exports single-column OOXML in ATS reading order with role and team dates", async () => {
    const bullets = selectBullets(bank, []);
    const d = {
      kind: "resume",
      content: JSON.stringify({
        summary: [{ text: bullets[0].text, source_ids: [bullets[0].id] }],
        experience: bullets.map((b) => ({ text: b.text, source_ids: [b.id] })),
        skill_ids: ["sk-requirements"],
      }),
    } as DocumentRecord;
    const buffer = await renderDocx(bank, d, "Example", "Product Manager");
    const zip = unzipSync(buffer);
    const xml = strFromU8(zip["word/document.xml"]);
    expect(xml).not.toMatch(/<w:(tbl|drawing|txbxContent)\b/);
    const headings = [
      "Summary",
      "Experience",
      "Skills",
      "Education",
      "Certifications",
    ];
    expect(headings.map((h) => xml.indexOf(`>${h}<`))).toEqual(
      [...headings.map((h) => xml.indexOf(`>${h}<`))].sort((a, b) => a - b),
    );
    for (const role of bank.experience)
      expect(xml).toContain(role.display_start);
    expect(xml).toContain(bank.experience[0].teams[0].name);
    expect(xml).toContain('<w:pgSz w:w="12240" w:h="15840"');
    expect(xml).toContain("<w:keepNext/>");
    expect(xml).toContain("<w:keepLines/>");
  });
  it("keeps concise career history without filling every role to its cap", () => {
    const ranks = bank.bullets.map((bullet) => ({ id: bullet.id, score: 1 }));
    const result = selectBullets(bank, ranks);
    expect(result).toHaveLength(7);
    expect(
      bank.experience.map(
        (role) => result.filter((bullet) => bullet.role_id === role.id).length,
      ),
    ).toEqual([4, 2, 1]);
  });
  it("retains lower-scored proof of a core need before higher-scored secondary projects", () => {
    const ranks = bank.bullets.map((bullet) => ({ id: bullet.id, score: 8 }));
    const priority = "fabuwood-draft-03";
    ranks.find((rank) => rank.id === priority)!.score = 4;
    const selected = selectBullets(bank, ranks, [priority]);
    expect(selected.map((bullet) => bullet.id)).toContain(priority);
    const plan = {
      positioning: "Operational measurement",
      role_leads: bank.experience.map((role) => ({
        role_id: role.id,
        source_id: selected.find((bullet) => bullet.role_id === role.id)!.id,
        reason: "Relevant role evidence",
        supporting_source_ids: [],
      })),
      priorities: [
        { need: "Define useful measures", source_ids: [priority], gap: null },
        {
          need: "Ship independent production tools",
          source_ids: [],
          gap: "No production tool delivery evidence",
        },
      ],
    };
    expect(() =>
      validateResumePlan(plan, selected, bank.bullets),
    ).not.toThrow();
    expect(() =>
      validateResumePlan(
        { ...plan, priorities: [{ need: "Tools", source_ids: [], gap: null }] },
        selected,
        bank.bullets,
      ),
    ).toThrow("evidence gap");
    expect(() =>
      validateResumePlan(
        {
          ...plan,
          priorities: [
            { need: "Measures", source_ids: ["invented"], gap: null },
          ],
        },
        selected,
        bank.bullets,
      ),
    ).toThrow("usable candidate");
  });
  it("never selects a conflicted source even if its usable flag remains true", () => {
    const edited = structuredClone(bank);
    const candidate = edited.bullets.find(
      (bullet) => bullet.usable_in_generation,
    )!;
    candidate.verification_status = "needs_review";
    expect(
      selectBullets(edited, [{ id: candidate.id, score: 10 }]).map(
        (bullet) => bullet.id,
      ),
    ).not.toContain(candidate.id);
  });
  it("avoids letting one workflow project crowd out the rest of the current role", () => {
    const ranks = bank.bullets.map((bullet) => ({
      id: bullet.id,
      score: bullet.accomplishment_id === "acc-fab-work-mgmt" ? 10 : 8,
    }));
    const result = selectBullets(bank, ranks);
    expect(
      result.filter(
        (bullet) => bullet.accomplishment_id === "acc-fab-work-mgmt",
      ),
    ).toHaveLength(2);
    expect(result.filter((bullet) => bullet.role_id === "role-1")).toHaveLength(
      6,
    );
  });
  it("fills skills from selected evidence when the posting paraphrases the bank labels", () => {
    const selected = bank.bullets.filter(
      (bullet) => bullet.id === "jpmorgan-turing-01",
    );
    const result = matchSkills(
      bank,
      "Turn ambiguous business needs into buildable specifications",
      selected,
    );
    expect(result).toContain("sk-requirements");
    expect(result).not.toContain("sk-ai-use-cases");
    expect(result).not.toContain("sk-apis");
    expect(result.length).toBeLessThanOrEqual(12);
    expect(matchSkills(bank, "AI use-case discovery", selected)).toContain(
      "sk-ai-use-cases",
    );
  });
  it("rejects duplicate or missing selected facts even if the line count is correct", () => {
    const selected = selectBullets(bank, []).slice(0, 2);
    const line = (index: number) => ({
      text: selected[index].text,
      source_ids: [selected[index].id],
    });
    const draft = {
      summary: [line(0)],
      experience: [line(0), line(1)],
      cover_letter: [
        { sentences: [line(0)] },
        { sentences: [line(0)] },
        { sentences: [line(1)] },
      ],
      questions_before_applying: [],
    };
    expect(() => validateDraftSelection(draft, selected, bank)).not.toThrow();
    expect(() =>
      validateDraftSelection(
        { ...draft, skill_ids: ["invented"] },
        selected,
        bank,
        ["sk-requirements"],
      ),
    ).toThrow("eligible skills");
    expect(() =>
      validateDraftSelection(
        { ...draft, skill_ids: ["sk-requirements", "sk-requirements"] },
        selected,
        bank,
        ["sk-requirements"],
      ),
    ).toThrow("distinct skill IDs");
    expect(() =>
      validateDraftSelection(
        { ...draft, skill_ids: ["sk-requirements"] },
        selected,
        bank,
        ["sk-requirements"],
      ),
    ).not.toThrow();
    draft.experience = [line(0), line(0)];
    expect(() => validateDraftSelection(draft, selected, bank)).toThrow(
      "exactly one",
    );
    draft.experience = [
      { ...line(0), source_ids: selected.map((bullet) => bullet.id) },
      line(1),
    ];
    expect(() => validateDraftSelection(draft, selected, bank)).toThrow(
      "exactly one",
    );
  });
  it("renders current teams first and omits empty skill headings", async () => {
    const selected = bank.bullets.filter(
      (bullet) => bullet.usable_in_generation && bullet.team_id,
    );
    const record = {
      kind: "resume",
      content: JSON.stringify({
        summary: [],
        experience: selected.map((bullet) => ({
          text: bullet.text,
          source_ids: [bullet.id],
        })),
        skill_ids: [],
      }),
    } as DocumentRecord;
    const xml = strFromU8(
      unzipSync(await renderDocx(bank, record, "Example", "Product Manager"))[
        "word/document.xml"
      ],
    );
    expect(xml.indexOf("Data Strategy Team")).toBeLessThan(
      xml.indexOf("EZPricing |"),
    );
    expect(xml).not.toContain(">Skills<");
  });
  it("can cite a configured workflow and its documented purpose together without borrowing another project's facts", () => {
    const primary = bank.bullets.find(
      (bullet) => bullet.id === "fabuwood-draft-05",
    )!;
    const purpose = bank.bullets.find(
      (bullet) => bullet.id === "fabuwood-draft-07",
    )!;
    const unrelated = bank.bullets.find(
      (bullet) => bullet.id === "jpmorgan-draft-02",
    )!;
    const context = supportingBulletPool(bank, [primary]);
    expect(context.map((bullet) => bullet.id)).toContain(purpose.id);
    expect(context.map((bullet) => bullet.id)).not.toContain(unrelated.id);
    const line = {
      text: "Build an Asana Scrum workflow with board automations and planning views to clarify developer work and reduce Product Owner busywork.",
      source_ids: [primary.id, purpose.id],
    };
    const draft = {
      questions_before_applying: [],
      summary: [{ text: primary.text, source_ids: [primary.id] }],
      experience: [line],
      cover_letter: [
        { sentences: [{ text: primary.text, source_ids: [primary.id] }] },
        { sentences: [{ text: primary.text, source_ids: [primary.id] }] },
        { sentences: [{ text: primary.text, source_ids: [primary.id] }] },
      ],
    };
    expect(() =>
      validateDraftSelection(draft, [primary], bank, [], context),
    ).not.toThrow();
    expect(verifyLines([line], bank, true)).toEqual([]);
    expect(() =>
      validateDraftSelection(
        {
          ...draft,
          experience: [{ ...line, source_ids: [primary.id, unrelated.id] }],
        },
        [primary],
        bank,
        [],
        [unrelated],
      ),
    ).toThrow("role, team, and accomplishment");
    const otherProject = bank.bullets.find(
      (bullet) => bullet.id === "fabuwood-draft-09",
    )!;
    expect(() =>
      validateDraftSelection(
        {
          ...draft,
          experience: [{ ...line, source_ids: [primary.id, otherProject.id] }],
        },
        [primary],
        bank,
        [],
        [otherProject],
      ),
    ).toThrow("role, team, and accomplishment");
    const retired = structuredClone(bank);
    retired.bullets.find(
      (bullet) => bullet.id === purpose.id,
    )!.verification_status = "retired";
    expect(
      supportingBulletPool(retired, [primary]).map((bullet) => bullet.id),
    ).not.toContain(purpose.id);
  });
  it("promotes the planned role lead within its group and leaves other roles and the input intact", () => {
    const sources = [
      "fabuwood-draft-05",
      "jpmorgan-enable-03",
      "jpmorgan-draft-02",
      "bh-turing-01",
    ];
    const lines = sources.map((id) => ({
      text: bank.bullets.find((bullet) => bullet.id === id)!.text,
      source_ids: [id],
    }));
    const plan = {
      positioning: "Operational workflows and design collaboration",
      priorities: [],
      role_leads: [
        {
          role_id: "role-2",
          source_id: "jpmorgan-draft-02",
          reason: "Concrete scoped contribution to a design-system rollout",
          supporting_source_ids: [],
        },
      ],
    };
    const ordered = prioritizeRoleLeads(lines, bank, plan);
    expect(ordered.map((line) => line.source_ids[0])).toEqual([
      sources[0],
      sources[2],
      sources[1],
      sources[3],
    ]);
    expect(lines.map((line) => line.source_ids[0])).toEqual(sources);
  });
});
