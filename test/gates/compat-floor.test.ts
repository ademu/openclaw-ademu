// The compat floor is DERIVED from actual imports (docs/design/compat-floor.md), never inherited by
// convention. This gate pins package.json to the table's maximum first-release.
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  it("floors never use || ranges (rejected by the host)", () => {
    expect(pkg.openclaw.compat.pluginApi).not.toContain("||");
    expect(pkg.openclaw.install.minHostVersion).toMatch(/^>=\d+\.\d+\.\d+$/);
  });
});
