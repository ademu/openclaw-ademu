// The compat floor is DERIVED from actual imports (docs/design/compat-floor.md), never inherited by
// convention. This gate pins package.json to the table's maximum first-release.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

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

type Version = [number, number, number];
function parse(v: string): Version {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(v);
  if (!m) throw new Error(`not a stable version: ${v}`);
  return [Number(m[1]), Number(m[2]), Number(m[3])];
}
function compare(a: Version, b: Version): number {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i]! - b[i]!;
  return 0;
}

describe("compat floor derived from imports", () => {
  const table = readFileSync(join(ROOT, "docs/design/compat-floor.md"), "utf8");
  const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
    openclaw: { compat: { pluginApi: string }; install: { minHostVersion: string } };
  };

  // Release cells are the last column of table rows: `| ... | v2026.8.1 |` (possibly bolded).
  const releases = [...table.matchAll(/\|\s*\**(v2026\.\d+\.\d+)\**\s*\|\s*$/gm)].map((m) => parse(m[1]!));
  const max = releases.reduce((acc, v) => (compare(v, acc) > 0 ? v : acc));
  const floor = `${max[0]}.${max[1]}.${max[2]}`;

  it("the table's declared floor equals its maximum first-release", () => {
    const declared = /## Derived floor: \*\*(\d+\.\d+\.\d+)\*\*/.exec(table)?.[1];
    expect(declared).toBe(floor);
  });

  it("package.json floors equal the derived floor", () => {
    expect(pkg.openclaw.compat.pluginApi).toBe(`>=${floor}`);
    expect(pkg.openclaw.install.minHostVersion).toBe(`>=${floor}`);
  });

  it("every openclaw/plugin-sdk import in the source tree has a row in the table (no silent floor drift)", () => {
    const files = [join(ROOT, "index.ts"), join(ROOT, "setup-entry.ts"), ...walk(join(ROOT, "src"))];
    const importRe = /import\s+(type\s+)?\{([^}]*)\}\s+from\s+"openclaw\/plugin-sdk\/([a-z0-9-]+)"/g;
    const missing: string[] = [];
    for (const file of files) {
      const src = readFileSync(file, "utf8");
      for (const m of src.matchAll(importRe)) {
        const subpath = m[3]!;
        if (!table.includes(`| \`${subpath}\` |`) && !table.includes(`| \`${subpath}\` (`)) missing.push(`${subpath} (file)`);
        for (const raw of m[2]!.split(",")) {
          const name = raw.replace(/\btype\s+/, "").split(" as ")[0]!.trim();
          if (!name) continue;
          if (!table.includes(`\`${subpath}\` → \`${name}\``)) missing.push(`${subpath} → ${name}`);
        }
      }
    }
    expect(missing, "imports without a compat-floor row (re-derive docs/design/compat-floor.md)").toEqual([]);
  });

  it("floors never use || ranges (rejected by the host)", () => {
    expect(pkg.openclaw.compat.pluginApi).not.toContain("||");
    expect(pkg.openclaw.install.minHostVersion).toMatch(/^>=\d+\.\d+\.\d+$/);
  });
});
