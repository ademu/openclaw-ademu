// Process-wide runtime slots (plan T10/T14): the host-injected PluginRuntime, the plugin's own
// manifest config values, and the lazily opened SQLite store + DaemonManager shared by every account.
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
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

function nearestPackageJson(startDir: string, accept: (pkg: Record<string, unknown>) => string | undefined): string | undefined {
  let dir = startDir;
  for (let i = 0; i < 8; i++) {
    const candidate = join(dir, "package.json");
    if (existsSync(candidate)) {
      const found = accept(JSON.parse(readFileSync(candidate, "utf8")) as Record<string, unknown>);
      if (found) return found;
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return undefined;
}

/**
 * The exact daemon version this plugin bundles. `@ademu/adc-bin` does not export its package.json
 * (ERR_PACKAGE_PATH_NOT_EXPORTED at register time — caught by the headless acceptance), so walk up
 * from the resolved entry file to the package's own package.json; fall back to this plugin's exact
 * dependency pin (the versioning gate asserts it is exact).
 */
export function bundledAdcVersion(): string {
  const require = createRequire(import.meta.url);
  let fromInstalled: string | undefined;
  try {
    fromInstalled = nearestPackageJson(dirname(require.resolve("@ademu/adc-bin")), (pkg) =>
      pkg.name === "@ademu/adc-bin" && typeof pkg.version === "string" ? pkg.version : undefined,
    );
  } catch {
    fromInstalled = undefined;
  }
  if (fromInstalled) return fromInstalled;
  const fromPin = nearestPackageJson(dirname(fileURLToPath(import.meta.url)), (pkg) => {
    const deps = pkg.dependencies as Record<string, string> | undefined;
    return pkg.name === "@ademu/openclaw-ademu" ? deps?.["@ademu/adc-bin"] : undefined;
  });
  if (fromPin) return fromPin;
  throw new Error("cannot determine the bundled @ademu/adc-bin version");
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
