// Process-wide runtime slots (plan T10/T14): the host-injected PluginRuntime, the plugin's own
// manifest config values, and the lazily opened SQLite store + DaemonManager shared by every account.
import { createRequire } from "node:module";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { CHANNEL_ID } from "./config.js";
import { DaemonManager, realDaemonDeps } from "./monitor/daemon.js";
import { AdemuStore } from "./store.js";

const runtimeStore = createPluginRuntimeStore<PluginRuntime>({
  pluginId: CHANNEL_ID,
  errorMessage: "Ademú runtime not initialized (the plugin was not registered by the gateway).",
});

export const setAdemuRuntime = runtimeStore.setRuntime;
export const getAdemuRuntime = runtimeStore.getRuntime;
export const tryGetAdemuRuntime = runtimeStore.tryGetRuntime;

/** Plugin-level knobs from `openclaw.plugin.json#configSchema` (`plugins.entries.ademu.config`). */
export type AdemuPluginSettings = {
  typingKeepaliveMs: number;
  mentionAliases: readonly string[];
};

export const DEFAULT_SETTINGS: AdemuPluginSettings = { typingKeepaliveMs: 2000, mentionAliases: [] };

let settings: AdemuPluginSettings = DEFAULT_SETTINGS;

export function applyPluginSettings(raw: Record<string, unknown> | undefined): AdemuPluginSettings {
  const ms = raw?.typingKeepaliveMs;
  const aliases = raw?.mentionAliases;
  settings = {
    typingKeepaliveMs: typeof ms === "number" && Number.isFinite(ms) && ms >= 500 && ms <= 10_000 ? Math.round(ms) : DEFAULT_SETTINGS.typingKeepaliveMs,
    mentionAliases: Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === "string" && a.trim().length > 0) : [],
  };
  return settings;
}

export function getPluginSettings(): AdemuPluginSettings {
  return settings;
}

/** The exact daemon version this plugin bundles (package pin; the versioning gate asserts it is exact). */
export function bundledAdcVersion(): string {
  const require = createRequire(import.meta.url);
  const pkg = require("@ademu/adc-bin/package.json") as { version: string };
  return pkg.version;
}

let sharedStore: AdemuStore | undefined;
let sharedDaemons: DaemonManager | undefined;

export function getAdemuStore(env: NodeJS.ProcessEnv = process.env): AdemuStore {
  sharedStore ??= AdemuStore.open({ stateDir: resolveStateDir(env) });
  return sharedStore;
}

export function getDaemonManager(log: (event: string, fields?: Record<string, string | number | boolean>) => void): DaemonManager {
  sharedDaemons ??= new DaemonManager(realDaemonDeps({ store: getAdemuStore(), bundledVersion: bundledAdcVersion(), log }));
  return sharedDaemons;
}

/** Test seam: replace the shared singletons. */
export function setSharedForTests(next: { store?: AdemuStore; daemons?: DaemonManager } | undefined): void {
  sharedStore = next?.store;
  sharedDaemons = next?.daemons;
}
