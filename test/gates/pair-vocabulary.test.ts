// Decision 2: "enroll", never "pair", on every OpenClaw-facing surface. This gate scans the
// user-facing text of the plugin and fails on any /\bpair/i hit. Internal code may still call the
// library methods pollPairing/cancelPairing — those live outside the scanned surfaces.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../..", import.meta.url).pathname;

/** User-facing surfaces: centralized strings, skills, README, and the manifests' copy. */
const SURFACES = ["src/i18n", "skills", "README.md", "openclaw.plugin.json", "package.json"];

function listFiles(path: string): string[] {
  if (!existsSync(path)) return [];
  const st = statSync(path);
  if (st.isFile()) return [path];
  return readdirSync(path).flatMap((name) => listFiles(join(path, name)));
}

describe("vocabulary gate: enroll, never pair", () => {
  it("no user-facing surface says 'pair'", () => {
    const violations: string[] = [];
    for (const surface of SURFACES) {
      for (const file of listFiles(join(ROOT, surface))) {
        if (!/\.(ts|md|json)$/.test(file)) continue;
        const lines = readFileSync(file, "utf8").split("\n");
        lines.forEach((line, i) => {
          // package.json: only the openclaw channel block is user-facing; library names elsewhere
          // (e.g. dependency names) are not copy. Keep the whole file simple: scan everything —
          // nothing in it should say "pair" anyway.
          if (/\bpair/i.test(line)) {
            violations.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
          }
        });
      }
    }
    expect(violations, `user-facing 'pair' wording found:\n${violations.join("\n")}`).toEqual([]);
  });
});
