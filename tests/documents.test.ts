import { describe, it, expect } from "vitest";
import { unzipSync, strFromU8 } from "fflate";
import { loadInputs } from "../src/lib/bank";
import {
  verifyLines,
  stripExperienceLabel,
  selectBullets,
  renderDocx,
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
        skill_ids: [],
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
  });
});
