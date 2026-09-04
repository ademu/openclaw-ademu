// Self-test for dev/privacy-audit.sh over the bait tree in test/fixtures/privacy-bait: positives
// (p*) are caught — every logger form, multiline, .detail, .raw, token/words shapes, QR — and
// negatives (n*) stay clean (the allowlisted `{ event, seq }` log, prose, non-log uses, error class
// names). The real tree must be clean; the default roots exclude test/fixtures.
import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../..", import.meta.url).pathname;
const SCRIPT = join(ROOT, "dev/privacy-audit.sh");
const BAIT = join(ROOT, "test/fixtures/privacy-bait");

function runAudit(root?: string) {
  const env = { ...process.env } as Record<string, string>;
  if (root) env.PRIVACY_AUDIT_TS_ROOT = root;
  return spawnSync("bash", [SCRIPT], { cwd: ROOT, env, encoding: "utf8" });
}

describe("privacy audit self-test", () => {
  const files = readdirSync(BAIT);
  const positives = files.filter((f) => f.startsWith("p"));
  const negatives = files.filter((f) => f.startsWith("n"));

  it("has both positive and negative bait", () => {
    expect(positives.length).toBeGreaterThanOrEqual(8);
    expect(negatives.length).toBeGreaterThanOrEqual(4);
  });

  it("catches every positive and none of the negatives", () => {
    const res = runAudit(BAIT);
    expect(res.status, res.stdout + res.stderr).toBe(1);
    for (const name of positives) {
      expect(res.stdout, `positive not caught: ${name}`).toContain(name);
    }
    for (const name of negatives) {
      expect(res.stdout, `negative wrongly flagged: ${name}`).not.toContain(name);
    }
  });

  it("the plugin tree is clean", () => {
    const res = runAudit();
    expect(res.status, res.stdout + res.stderr).toBe(0);
    expect(res.stdout).toContain("privacy audit clean");
  });
});
