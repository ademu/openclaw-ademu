import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { applyPluginSettings, bundledAdcVersion, DEFAULT_SETTINGS } from "../src/runtime.js";

const ROOT = new URL("..", import.meta.url).pathname;

describe("runtime", () => {
  it("bundledAdcVersion reads the installed @ademu/adc-bin version and it equals the exact pin", () => {
    const pkg = JSON.parse(readFileSync(`${ROOT}/package.json`, "utf8")) as { dependencies: Record<string, string> };
    const v = bundledAdcVersion();
    expect(v).toMatch(/^\d+\.\d+\.\d+$/);
    expect(v).toBe(pkg.dependencies["@ademu/adc-bin"]);
  });

  it("plugin settings clamp to the manifest schema and default sanely", () => {
    expect(applyPluginSettings(undefined)).toEqual(DEFAULT_SETTINGS);
    expect(applyPluginSettings({ typingKeepaliveMs: 100 }).typingKeepaliveMs).toBe(2000);
    expect(applyPluginSettings({ typingKeepaliveMs: 3000, mentionAliases: ["iris", "", 5] }).mentionAliases).toEqual(["iris"]);
    expect(applyPluginSettings({ typingKeepaliveMs: 3000 }).typingKeepaliveMs).toBe(3000);
  });
});
