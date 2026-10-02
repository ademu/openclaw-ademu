// Versioning policy (design entry §11): semver from 0.1.0; the plugin bundles NO daemon (AdemuMLS
// #712) — each release names the minimum adc it needs, which equals the attacher's MIN_ADC_VERSION;
// CHANGELOG carries the version; the plugin's Node range equals OpenClaw's.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MIN_ADC_VERSION } from "../../src/monitor/attach.js";

const ROOT = new URL("../..", import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
  version: string;
  engines: { node: string };
  dependencies: Record<string, string>;
  devDependencies: Record<string, string>;
  openclaw: { build: { openclawVersion: string } };
};

describe("versioning policy", () => {
  it("bundles no daemon: no @ademu/adc-bin dependency", () => {
    expect(pkg.dependencies["@ademu/adc-bin"]).toBeUndefined();
  });

  it("CHANGELOG records the current version and the minimum adc, which is the attacher's floor", () => {
    const changelog = readFileSync(join(ROOT, "CHANGELOG.md"), "utf8");
    expect(changelog).toContain(`## [${pkg.version}]`);
    expect(changelog).toContain(`Requires adc ≥ **${MIN_ADC_VERSION}**`);
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
