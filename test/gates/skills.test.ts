// Skills gate (T15): every skill has parseable frontmatter (name, description ≤ 220 chars,
// user-invocable, optional JSON5-ish openclaw metadata), no banned vocabulary, and the residency
// skill declares its config requirement.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../..", import.meta.url).pathname;
const SKILLS = join(ROOT, "skills");

function frontmatter(src: string): Record<string, string> {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(src);
  expect(m, "frontmatter block").not.toBeNull();
  const out: Record<string, string> = {};
  for (const line of m![1]!.split("\n")) {
    const idx = line.indexOf(":");
    if (idx > 0) out[line.slice(0, idx).trim()] = line.slice(idx + 1).trim();
  }
  return out;
}

describe("skills", () => {
  const names = readdirSync(SKILLS).filter((n) => existsSync(join(SKILLS, n, "SKILL.md")));

  it("ships both skills", () => {
    expect(names.sort()).toEqual(["ademu", "ademu-enroll"]);
  });

  for (const name of names) {
    it(`${name}: frontmatter is well-formed and the copy uses the house vocabulary`, () => {
      const src = readFileSync(join(SKILLS, name, "SKILL.md"), "utf8");
      const fm = frontmatter(src);
      expect(fm.name).toBe(name);
      expect(fm.description!.length).toBeGreaterThan(20);
      expect(fm.description!.length).toBeLessThanOrEqual(220);
      expect(fm["user-invocable"]).toBe("true");
      if (fm.metadata) {
        const meta = JSON.parse(fm.metadata) as { openclaw?: { emoji?: string; requires?: { config?: string[] } } };
        expect(meta.openclaw?.emoji).toBe("🔐");
        if (name === "ademu") expect(meta.openclaw?.requires?.config).toEqual(["channels.ademu"]);
      }
      expect(src).not.toMatch(/\bpair/i);
      expect(src).toMatch(/\benroll/i);
    });
  }
});
