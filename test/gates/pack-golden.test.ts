// The install contract is the packed tarball. This golden pins what ships: compiled JS, the
// manifest, the icon, skills, licenses, README, CHANGELOG — and what never ships: sources, tests,
// docs, scripts, CI. Run `npm run build` first (CI does).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../..", import.meta.url).pathname;

const REQUIRED = [
  "package.json",
  "openclaw.plugin.json",
  "assets/icon.png",
  "LICENSE",
  "README.md",
  "CHANGELOG.md",
  "dist/index.js",
  "dist/setup-entry.js",
];

const FORBIDDEN_PREFIXES = ["src/", "test/", "docs/", "scripts/", "dev/", ".github/", "node_modules/"];

describe("npm pack golden", () => {
  it("ships exactly the install contract", () => {
    expect(existsSync(join(ROOT, "dist", "index.js")), "run `npm run build` before the pack golden").toBe(true);
    const out = execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], {
      cwd: ROOT,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    const parsed = JSON.parse(out) as Array<{ files: Array<{ path: string }> }>;
    const files = new Set(parsed[0]!.files.map((f) => f.path));

    for (const req of REQUIRED) {
      expect(files.has(req), `missing from tarball: ${req}`).toBe(true);
    }
    const forbidden = [...files].filter(
      (p) => FORBIDDEN_PREFIXES.some((pre) => p.startsWith(pre)) || (/\.ts$/.test(p) && !/\.d\.ts$/.test(p)),
    );
    expect(forbidden, "files that must not ship").toEqual([]);
    // Skills ship as directories with SKILL.md (T15 adds them); every one on disk must be in the tarball.
    const skillsDir = join(ROOT, "skills");
    if (existsSync(skillsDir)) {
      for (const name of readdirSync(skillsDir)) {
        const skill = join("skills", name, "SKILL.md");
        if (existsSync(join(ROOT, skill))) {
          expect(files.has(skill), `skill missing from tarball: ${skill}`).toBe(true);
        }
      }
    }
  });
});
