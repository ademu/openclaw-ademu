// The install contract is the packed tarball. This golden pins what ships: compiled JS, the
// manifest, the icon, skills, licenses, README, CHANGELOG — and what never ships: sources, tests,
// docs, scripts, CI. Run `npm run build` first (CI does).
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}
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
    // The COMPLETE expected manifest: the fixed files, every skill on disk, and exactly the compiled
    // output of the TypeScript sources (one .js + .js.map per source file). Anything else — or
    // anything missing — fails: the tarball is the install contract, not a subset check.
    const expected = new Set<string>(REQUIRED);
    const skillsDir = join(ROOT, "skills");
    for (const name of readdirSync(skillsDir)) {
      const skill = join("skills", name, "SKILL.md");
      if (existsSync(join(ROOT, skill))) expected.add(skill);
    }
    for (const rel of ["index.ts", "setup-entry.ts", ...walk(join(ROOT, "src")).map((f) => relative(ROOT, f))]) {
      const base = rel.replace(/\.ts$/, "");
      expected.add(`dist/${base}.js`);
      expected.add(`dist/${base}.js.map`);
    }
    expect([...files].sort()).toEqual([...expected].sort());
  });
});
