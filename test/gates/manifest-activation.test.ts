import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

/**
 * E2E finding #1 (VPS, 2026-09-04): with `activation.onStartup: false` the gateway loads a channel
 * plugin at startup ONLY when `channels.<id>` is already configured (openclaw
 * `gateway-startup-plugin-config.ts`: `shouldConsiderForGatewayStartup` / `hasConfiguredStartupChannel`).
 * A fresh install therefore had no `ademu_enroll` tool and no enroll skill — the chat door could not
 * open the very first enrollment. Startup loading is cheap here: with zero accounts the gateway starts
 * nothing (`server-channels.ts`: empty `listAccountIds` → no account start), and `registerFull` only
 * registers the tool + the lease service (no SQLite, no daemon — see entries.test.ts).
 */
describe("manifest activation", () => {
  it("loads at gateway startup so the chat door works before any account exists", () => {
    const manifest = JSON.parse(readFileSync(new URL("../../openclaw.plugin.json", import.meta.url), "utf8"));
    expect(manifest.activation).toEqual({ onStartup: true });
  });
});
