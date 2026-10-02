// Gate (AdemuMLS #712, DECISIONS.md §7.5): the plugin never runs a device host. No source file
// imports `ensureDaemon`, the bundled adc binary resolver, or spawns a child process — the one
// exception is the enrollment page's browser open. Starting an installed user service goes through
// `@ademu/adc-control`'s `startUserService` (launchctl/systemctl, never spawn/stop/kill).
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const p = join(dir, name);
    return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
  });
}

const SOURCES = [join(ROOT, "index.ts"), join(ROOT, "setup-entry.ts"), ...walk(join(ROOT, "src"))];
/** The enrollment page opens the owner's browser (`open`/`xdg-open`); nothing else may spawn. */
const SPAWN_ALLOWED = new Set(["src/enrollment-page.ts"]);

describe("the plugin never runs a device host", () => {
  it("no source imports ensureDaemon or @ademu/adc-bin", () => {
    const offenders = SOURCES.filter((f) => /\bensureDaemon\b|@ademu\/adc-bin/.test(readFileSync(f, "utf8"))).map((f) => relative(ROOT, f));
    expect(offenders).toEqual([]);
  });

  it("only the enrollment page uses child_process", () => {
    const offenders = SOURCES.filter((f) => /node:child_process|from "child_process"/.test(readFileSync(f, "utf8")))
      .map((f) => relative(ROOT, f))
      .filter((f) => !SPAWN_ALLOWED.has(f));
    expect(offenders).toEqual([]);
  });
});
