// Versioning policy (design entry §12): semver from 0.1.0; each release pins the EXACT
// @ademu/adc-bin (daemon) version it was tested with; CHANGELOG carries the version; the plugin's
// Node range equals OpenClaw's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
  engines: { node: string };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  openclaw: { build: { openclawVersion: string } };
};

describe("versioning policy", () => {
  it("pins @ademu/adc-bin exactly", () => {
    expect(pkg.dependencies["@ademu/adc-bin"]).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("CHANGELOG records the current version and the tested adc-bin version", () => {
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`## [${pkg.version}]`);
    expect(changelog).toContain(`\`@ademu/adc-bin\` **${pkg.dependencies["@ademu/adc-bin"]}**`);
  });

  it("the openclaw devDependency is an exact pin and matches build.openclawVersion", () => {
    expect(pkg.devDependencies.openclaw).toMatch(/^\d+\.\d+\.\d+$/);
    expect(pkg.openclaw.build.openclawVersion).toBe(pkg.devDependencies.openclaw);
  });

  it("engines.node equals the installed openclaw's host range", () => {
    const host = JSON.parse(readFileSync(join(ROOT, "node_modules/openclaw/package.json"), "utf8")) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(host.engines.node);
  });
});
