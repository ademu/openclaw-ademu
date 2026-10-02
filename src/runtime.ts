// Process-wide runtime slots (plan T10/T14): the host-injected PluginRuntime, the plugin's own
// manifest config values, and the lazily opened SQLite store + DaemonAttacher shared by every account.
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { CHANNEL_ID } from "./config.js";
import { DaemonAttacher, realAttachDeps } from "./monitor/attach.js";
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

/** The runtime ceiling for `typingKeepaliveMs` — below Ademú's ~3 s receiver TTL (AdemuMLS#621). */
export const TYPING_KEEPALIVE_MAX_MS = 2500;

let settings: AdemuPluginSettings = DEFAULT_SETTINGS;

export function applyPluginSettings(raw: Record<string, unknown> | undefined): AdemuPluginSettings {
  const ms = raw?.typingKeepaliveMs;
  const aliases = raw?.mentionAliases;
  settings = {
    // The manifest keeps accepting 500–10000 (a lowered schema maximum would reject existing configs at
    // OpenClaw's plugin-config validation); the RUNTIME clamps to ≤ 2500 because since adc 0.3.0 the daemon
    // relays each keepalive tick as at most one typing frame and Ademú's receiver expires the indicator
    // ~3 s after the last frame (AdemuMLS#621) — a slower tick would blink.
    typingKeepaliveMs:
      typeof ms === "number" && Number.isFinite(ms) && ms >= 500 && ms <= 10_000
        ? Math.min(Math.round(ms), TYPING_KEEPALIVE_MAX_MS)
        : DEFAULT_SETTINGS.typingKeepaliveMs,
    mentionAliases: Array.isArray(aliases) ? aliases.filter((a): a is string => typeof a === "string" && a.trim().length > 0) : [],
  };
  return settings;
}

export function getPluginSettings(): AdemuPluginSettings {
  return settings;
}

let sharedStore: AdemuStore | undefined;
let sharedAttacher: DaemonAttacher | undefined;

export function getAdemuStore(env: NodeJS.ProcessEnv = process.env): AdemuStore {
  sharedStore ??= AdemuStore.open({ stateDir: resolveStateDir(env) });
  return sharedStore;
}

/** The attacher needs no store: the plugin owns no daemon state (AdemuMLS #712). */
export function getDaemonAttacher(log: (event: string, fields?: Record<string, string | number | boolean>) => void): DaemonAttacher {
  sharedAttacher ??= new DaemonAttacher(realAttachDeps({ log }));
  return sharedAttacher;
}

/** Test seam: replace the shared singletons. */
export function setSharedForTests(next: { store?: AdemuStore; attacher?: DaemonAttacher } | undefined): void {
  sharedStore = next?.store;
  sharedAttacher = next?.attacher;
}
