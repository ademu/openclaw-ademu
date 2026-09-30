// Channel configuration: `channels.ademu` — accounts (one per enrolled Ademú device), the device
// host (adc daemon) location, the Ademú server endpoints, and room policies. Design entry §2 R1/R3/
// R5/R11. Accounts only (no single-account root convenience): root-level fields are the inheritance
// base for `dataDir`/`socketPath`/`server`/`enabled`; tokens and identities live under accounts.
import { existsSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { createAccountListHelpers } from "openclaw/plugin-sdk/account-helpers";
import { normalizeAccountId, normalizeOptionalAccountId } from "openclaw/plugin-sdk/account-id";
import { resolveAccountEntry, type OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { createHybridChannelConfigAdapter } from "openclaw/plugin-sdk/channel-config-helpers";
import {
  buildChannelConfigSchema,
  buildGroupEntrySchema,
  buildMultiAccountChannelSchema,
} from "openclaw/plugin-sdk/channel-config-schema";
import {
  buildOptionalSecretInputSchema,
  resolveSecretInputString,
  type SecretInputStringResolutionMode,
} from "openclaw/plugin-sdk/secret-input";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { detectSystemInstall, SYSTEM_CONTROL_SOCKET_PATH, SYSTEM_ENROLL_SOCKET_PATH, SYSTEM_SESSION_SOCKET_PATH } from "@ademu/adc-control";
import { z } from "zod";
import { pruneRouteBindings } from "./bindings.js";

export const CHANNEL_ID = "ademu";

/** Ademú production endpoints (R11). Staging/dev override `channels.ademu.server`. */
export const DEFAULT_SERVER = {
  restBaseUrl: "https://api.ademu.com",
  wsUrl: "wss://gateway.ademu.com/v1/ws",
} as const;

export const CONTROL_SOCKET_FILE = "adc.sock";
export const SESSION_SOCKET_FILE = "adc-session.sock";
/** The daemon's ENROLLMENT socket (ADC Phase 3b Phase B): the only socket the ceremony half opens. */
export const ENROLL_SOCKET_FILE = "adc-enroll.sock";
/** The system install's state dir (`adc-daemon/src/system_layout.rs` STATE_DIR; not exported by the client). */
export const SYSTEM_DATA_DIR = "/var/lib/adc";

// ---------------------------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------------------------

const ServerSchema = z
  .object({
    restBaseUrl: z.string().url().optional(),
    wsUrl: z.string().url().optional(),
  })
  .strict();

/** One enrolled device. `token` is a plain string or a SecretRef (`buildOptionalSecretInputSchema`). */
export const AdemuAccountSchema = z
  .object({
    enabled: z.boolean().optional(),
    name: z.string().optional(),
    agentName: z.string().optional(),
    deviceId: z.string().optional(),
    agentUserId: z.string().optional(),
    ownerUserId: z.string().optional(),
    token: buildOptionalSecretInputSchema(),
    dataDir: z.string().optional(),
    socketPath: z.string().optional(),
    enrollSocketPath: z.string().optional(),
  })
  .strict();

/** Root: inheritance base + channel-wide settings. No token/identity at the root. */
const AdemuBaseSchema = z
  .object({
    enabled: z.boolean().optional(),
    dataDir: z.string().optional(),
    socketPath: z.string().optional(),
    enrollSocketPath: z.string().optional(),
    server: ServerSchema.optional(),
    groups: z.record(z.string(), buildGroupEntrySchema()).optional(),
  })
  .strict();

export const AdemuChannelSchema = buildMultiAccountChannelSchema(AdemuBaseSchema, {
  accountSchema: AdemuAccountSchema,
});

export type AdemuAccountConfig = z.infer<typeof AdemuAccountSchema>;
/** Explicit (not inferred through the multi-account wrapper) so downstream types stay precise. */
export type AdemuChannelConfig = z.infer<typeof AdemuBaseSchema> & {
  accounts?: Record<string, AdemuAccountConfig>;
  defaultAccount?: string;
};

export const ADEMU_UI_HINTS = {
  "accounts.*.token": {
    label: "Device token",
    sensitive: true,
    help: "Minted by the enrollment wizard or the ademu_enroll tool; rotate it at the adc CLI and paste the new token via “I have a device token”.",
  },
  "accounts.*.agentName": { label: "Agent name on Ademú" },
  "accounts.*.deviceId": { label: "Device id", advanced: true },
  "accounts.*.agentUserId": { label: "Agent user id", advanced: true },
  "accounts.*.ownerUserId": { label: "Owner user id", advanced: true },
  "accounts.*.dataDir": { label: "Device host data dir (override)", advanced: true },
  "accounts.*.socketPath": { label: "Device host control socket (override)", advanced: true },
  "accounts.*.enrollSocketPath": { label: "Device host enrollment socket (override)", advanced: true },
  dataDir: { label: "Device host data dir", advanced: true },
  socketPath: { label: "Device host control socket", advanced: true },
  enrollSocketPath: { label: "Device host enrollment socket", advanced: true },
  "server.restBaseUrl": { label: "Ademú REST base URL", advanced: true },
  "server.wsUrl": { label: "Ademú WebSocket URL", advanced: true },
} as const;

/** The code-level channel config schema (`ChannelPlugin.configSchema`). */
export const ademuConfigSchema: ReturnType<typeof buildChannelConfigSchema> = buildChannelConfigSchema(AdemuChannelSchema, {
  uiHints: ADEMU_UI_HINTS,
});

// ---------------------------------------------------------------------------------------------
// Daemon identity (R1): the validated, canonical pair (dataDir, controlSocket) + session socket
// + the enrollment socket (Phase B) + the scope (user, or a hardened system install: attach-only)
// ---------------------------------------------------------------------------------------------

export type DaemonScope = "user" | "system";

export type DaemonIdentity = {
  /** Canonical data dir (realpath of the deepest existing ancestor + verbatim tail). */
  dataDir: string;
  /** Canonical control socket path (identity data only — the plugin never opens it). */
  controlSocket: string;
  /** Session socket we inject on owned spawns (`<dataDir>/adc-session.sock`). */
  sessionSocket: string;
  /** Enrollment socket we inject on owned spawns and dial for the ceremony (`<dataDir>/adc-enroll.sock`). */
  enrollSocket: string;
  /** Raw values as configured/derived (what we pass to the daemon). */
  raw: { dataDir: string; controlSocket: string; sessionSocket: string; enrollSocket: string };
  explicit: { dataDir: boolean; socketPath: boolean; enrollSocketPath: boolean };
  /**
   * `system`: a system-scope ADC daemon is installed on this host (`detectSystemInstall`: a root-owned
   * regular /etc/adc/config.toml AND a socket at /run/adc/adc-enroll.sock) and nothing was configured
   * explicitly, so the identity IS the system layout and the daemon is foreign (attach-only, never
   * spawned beside — the coexistence gap, AdemuMLS#642). `user`: everything else.
   */
  scope: DaemonScope;
};

/** The hardened host's detector (seam for tests). */
export type SystemInstallDetector = () => boolean;

export function defaultDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(resolveStateDir(env), "ademu", "adc");
}

function expandHome(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

/**
 * Canonical form for identity comparison: absolute, `..`/`.`/duplicate separators collapsed, and
 * the deepest EXISTING ancestor resolved through symlinks (the tail stays verbatim). Ademú itself
 * joins paths verbatim and never normalizes, so aliases must collapse on our side (R1).
 */
export function canonicalizePath(p: string): string {
  const abs = resolve(expandHome(p));
  let existing = abs;
  const tail: string[] = [];
  while (!existsSync(existing)) {
    const parent = dirname(existing);
    if (parent === existing) break;
    tail.unshift(existing.slice(parent.length).replace(new RegExp(`^\\${sep}`), ""));
    existing = parent;
  }
  let base: string;
  try {
    base = realpathSync(existing);
  } catch {
    base = existing;
  }
  return tail.length ? join(base, ...tail) : base;
}

export type DaemonIdentityInput = {
  dataDir?: string | undefined;
  socketPath?: string | undefined;
  enrollSocketPath?: string | undefined;
};

/** The system layout as an identity: `/var/lib/adc` + the three `/run/adc` sockets, foreign by scope. */
function systemIdentity(): DaemonIdentity {
  return {
    dataDir: canonicalizePath(SYSTEM_DATA_DIR),
    controlSocket: canonicalizePath(SYSTEM_CONTROL_SOCKET_PATH),
    sessionSocket: canonicalizePath(SYSTEM_SESSION_SOCKET_PATH),
    enrollSocket: canonicalizePath(SYSTEM_ENROLL_SOCKET_PATH),
    raw: {
      dataDir: SYSTEM_DATA_DIR,
      controlSocket: SYSTEM_CONTROL_SOCKET_PATH,
      sessionSocket: SYSTEM_SESSION_SOCKET_PATH,
      enrollSocket: SYSTEM_ENROLL_SOCKET_PATH,
    },
    explicit: { dataDir: false, socketPath: false, enrollSocketPath: false },
    scope: "system",
  };
}

/**
 * Resolves the daemon identity. With NOTHING configured (no `dataDir`, `socketPath` or
 * `enrollSocketPath`, inherited root values included) and a system install detected, the identity is
 * the system layout (scope `system`). Any explicit key keeps user scope: an operator who names paths
 * gets exactly those paths.
 */
export function resolveDaemonIdentity(
  input: DaemonIdentityInput,
  env: NodeJS.ProcessEnv = process.env,
  detect: SystemInstallDetector = () => detectSystemInstall(),
): DaemonIdentity {
  const explicit = {
    dataDir: Boolean(input.dataDir?.trim()),
    socketPath: Boolean(input.socketPath?.trim()),
    enrollSocketPath: Boolean(input.enrollSocketPath?.trim()),
  };
  if (!explicit.dataDir && !explicit.socketPath && !explicit.enrollSocketPath && detect()) return systemIdentity();
  const rawDataDir = input.dataDir?.trim() ? expandHome(input.dataDir.trim()) : defaultDataDir(env);
  const rawControl = input.socketPath?.trim()
    ? expandHome(input.socketPath.trim())
    : join(rawDataDir, CONTROL_SOCKET_FILE);
  const rawSession = join(rawDataDir, SESSION_SOCKET_FILE);
  const rawEnroll = input.enrollSocketPath?.trim()
    ? expandHome(input.enrollSocketPath.trim())
    : join(rawDataDir, ENROLL_SOCKET_FILE);
  return {
    dataDir: canonicalizePath(rawDataDir),
    controlSocket: canonicalizePath(rawControl),
    sessionSocket: canonicalizePath(rawSession),
    enrollSocket: canonicalizePath(rawEnroll),
    raw: {
      dataDir: isAbsolute(rawDataDir) ? rawDataDir : resolve(rawDataDir),
      controlSocket: isAbsolute(rawControl) ? rawControl : resolve(rawControl),
      sessionSocket: isAbsolute(rawSession) ? rawSession : resolve(rawSession),
      enrollSocket: isAbsolute(rawEnroll) ? rawEnroll : resolve(rawEnroll),
    },
    explicit,
    scope: "user",
  };
}

// ---------------------------------------------------------------------------------------------
// Accounts
// ---------------------------------------------------------------------------------------------

export type TokenStatus = "available" | "configured_unavailable" | "missing";

export type ResolvedAdemuAccount = {
  accountId: string;
  enabled: boolean;
  /** Enabled, has a device id, and a token that is available or a configured SecretRef. */
  configured: boolean;
  agentName: string;
  deviceId?: string;
  agentUserId?: string;
  ownerUserId?: string;
  /** Plaintext token when available in this resolution mode; never logged. */
  token?: string;
  tokenStatus: TokenStatus;
  tokenSource: "config" | "secretRef" | "none";
  daemon: DaemonIdentity;
  server: { restBaseUrl: string; wsUrl: string };
  /** Set when this account's daemon identity collides with another account's (R1). */
  configError?: string;
};

function getChannelConfig(cfg: OpenClawConfig): AdemuChannelConfig | undefined {
  return cfg?.channels?.[CHANNEL_ID] as AdemuChannelConfig | undefined;
}

const helpers = createAccountListHelpers<Record<string, unknown> & AdemuChannelConfig>(CHANNEL_ID, {
  fallbackAccountIdWhenEmpty: false,
  omitKeys: ["defaultAccount", "groups", "server"],
});

export const listAdemuAccountIds = helpers.listAccountIds;
export const resolveDefaultAdemuAccountId = helpers.resolveDefaultAccountId;

/** Stable account id for a new enrollment: the OpenClaw-normalized slug of the agent name. */
export function accountIdForAgentName(agentName: string): string {
  const slug = agentName
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return normalizeAccountId(slug || "agent");
}

function tokenPath(accountId: string): string {
  return `channels.${CHANNEL_ID}.accounts.${accountId}.token`;
}

function resolveServer(channel: AdemuChannelConfig | undefined): { restBaseUrl: string; wsUrl: string } {
  return {
    restBaseUrl: channel?.server?.restBaseUrl?.trim() || DEFAULT_SERVER.restBaseUrl,
    wsUrl: channel?.server?.wsUrl?.trim() || DEFAULT_SERVER.wsUrl,
  };
}

function readAccount(
  cfg: OpenClawConfig,
  accountId: string | null | undefined,
  mode: SecretInputStringResolutionMode,
  env: NodeJS.ProcessEnv,
  detect?: SystemInstallDetector,
): ResolvedAdemuAccount {
  const channel = getChannelConfig(cfg) ?? ({} as AdemuChannelConfig);
  const id = normalizeOptionalAccountId(accountId) ?? resolveDefaultAdemuAccountId(cfg);
  const entry = resolveAccountEntry(channel.accounts, id) as AdemuAccountConfig | undefined;
  const merged = helpers.resolveAccountConfig(cfg, id) as Record<string, unknown> & Partial<AdemuAccountConfig>;

  const token = resolveSecretInputString({ value: merged.token, path: tokenPath(id), mode });
  const tokenSource: ResolvedAdemuAccount["tokenSource"] =
    token.status === "available" ? "config" : token.status === "configured_unavailable" ? "secretRef" : "none";
  const daemon = resolveDaemonIdentity({ dataDir: merged.dataDir, socketPath: merged.socketPath, enrollSocketPath: merged.enrollSocketPath }, env, detect);
  const enabled = channel.enabled !== false && entry?.enabled !== false;
  const deviceId = merged.deviceId?.trim() || undefined;
  const configured = enabled && Boolean(deviceId) && token.status !== "missing";

  return {
    accountId: id,
    enabled,
    configured,
    agentName: merged.agentName?.trim() || merged.name?.trim() || id,
    ...(deviceId ? { deviceId } : {}),
    ...(merged.agentUserId?.trim() ? { agentUserId: merged.agentUserId.trim() } : {}),
    ...(merged.ownerUserId?.trim() ? { ownerUserId: merged.ownerUserId.trim() } : {}),
    ...(token.value ? { token: token.value } : {}),
    tokenStatus: token.status,
    tokenSource,
    daemon,
    server: resolveServer(channel),
  };
}

/**
 * Cross-axis daemon identity validation (R1): one data dir ↔ one control socket ↔ one enrollment
 * socket. Returns a map of accountId → error message for every account involved in a collision.
 */
export function validateDaemonIdentities(
  cfg: OpenClawConfig,
  env: NodeJS.ProcessEnv = process.env,
  detect?: SystemInstallDetector,
): Map<string, string> {
  const errors = new Map<string, string>();
  const ids = listAdemuAccountIds(cfg);
  const byDir = new Map<string, Set<string>>();
  const byDirEnroll = new Map<string, Set<string>>();
  const bySocket = new Map<string, Set<string>>();
  const byEnrollSocket = new Map<string, Set<string>>();
  const identities = new Map<string, DaemonIdentity>();
  const add = (map: Map<string, Set<string>>, key: string, value: string) =>
    (map.get(key) ?? map.set(key, new Set()).get(key)!).add(value);
  for (const id of ids) {
    const account = readAccount(cfg, id, "inspect", env, detect);
    identities.set(id, account.daemon);
    add(byDir, account.daemon.dataDir, account.daemon.controlSocket);
    add(byDirEnroll, account.daemon.dataDir, account.daemon.enrollSocket);
    add(bySocket, account.daemon.controlSocket, account.daemon.dataDir);
    add(byEnrollSocket, account.daemon.enrollSocket, account.daemon.dataDir);
  }
  for (const [id, identity] of identities) {
    const sockets = byDir.get(identity.dataDir)!;
    const enrollSockets = byDirEnroll.get(identity.dataDir)!;
    const dirs = bySocket.get(identity.controlSocket)!;
    const enrollDirs = byEnrollSocket.get(identity.enrollSocket)!;
    // The three sockets play three roles: the enrollment socket the plugin dials must never be the
    // control socket (the plugin would drive the ceremony with ambient operator authority) or the
    // session socket.
    if (identity.enrollSocket === identity.controlSocket || identity.enrollSocket === identity.sessionSocket) {
      errors.set(
        id,
        `daemon identity error: the enrollment socket ${identity.enrollSocket} must differ from the control and session sockets (channels.ademu.enrollSocketPath names adc-enroll.sock, never adc.sock)`,
      );
    } else if (sockets.size > 1) {
      errors.set(
        id,
        `daemon identity collision: data dir ${identity.dataDir} is named with ${sockets.size} different control sockets across accounts`,
      );
    } else if (enrollSockets.size > 1) {
      errors.set(
        id,
        `daemon identity collision: data dir ${identity.dataDir} is named with ${enrollSockets.size} different enrollment sockets across accounts`,
      );
    } else if (dirs.size > 1) {
      errors.set(
        id,
        `daemon identity collision: control socket ${identity.controlSocket} is shared by ${dirs.size} different data dirs across accounts`,
      );
    } else if (enrollDirs.size > 1) {
      errors.set(
        id,
        `daemon identity collision: enrollment socket ${identity.enrollSocket} is shared by ${enrollDirs.size} different data dirs across accounts`,
      );
    }
  }
  return errors;
}

/** Strict resolution (runtime): SecretRefs have been resolved into the config by the gateway. */
export function resolveAdemuAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  detect?: SystemInstallDetector,
): ResolvedAdemuAccount {
  const account = readAccount(cfg, accountId, "strict", env, detect);
  const error = validateDaemonIdentities(cfg, env, detect).get(account.accountId);
  return error ? { ...account, configError: error } : account;
}

/** Inspect-mode resolution (status/doctor/wizard): never throws on an unresolved SecretRef. */
export function inspectAdemuAccount(
  cfg: OpenClawConfig,
  accountId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  detect?: SystemInstallDetector,
): Omit<ResolvedAdemuAccount, "token"> {
  const { token: _token, ...account } = readAccount(cfg, accountId, "inspect", env, detect);
  const error = validateDaemonIdentities(cfg, env, detect).get(account.accountId);
  return error ? { ...account, configError: error } : account;
}

// ---------------------------------------------------------------------------------------------
// Owner authority (R3): channel-scoped entry in the GLOBAL commands.ownerAllowFrom
// ---------------------------------------------------------------------------------------------

export function ownerAllowFromEntry(ownerUserId: string): string {
  return `${CHANNEL_ID}:${ownerUserId}`;
}

type CommandsConfig = { ownerAllowFrom?: Array<string | number> };

/** Adds `ademu:<ownerUserId>` to commands.ownerAllowFrom (idempotent). */
export function addOwnerAllowFrom(cfg: OpenClawConfig, ownerUserId: string): OpenClawConfig {
  const commands = ((cfg as { commands?: CommandsConfig }).commands ?? {}) as CommandsConfig;
  const entry = ownerAllowFromEntry(ownerUserId);
  const list = commands.ownerAllowFrom ?? [];
  if (list.some((e) => String(e) === entry)) return cfg;
  return { ...cfg, commands: { ...commands, ownerAllowFrom: [...list, entry] } } as OpenClawConfig;
}

/**
 * Rider B: removes `ademu:<ownerUserId>` unless another ademu account still names that owner.
 * `remainingAccountIds` are the accounts that still exist after the removal.
 */
export function pruneOwnerAllowFrom(
  cfg: OpenClawConfig,
  ownerUserId: string | undefined,
  remainingAccountIds: string[],
): OpenClawConfig {
  if (!ownerUserId) return cfg;
  const stillUsed = remainingAccountIds.some((id) => {
    const entry = resolveAccountEntry(getChannelConfig(cfg)?.accounts, id) as AdemuAccountConfig | undefined;
    return entry?.ownerUserId?.trim() === ownerUserId;
  });
  if (stillUsed) return cfg;
  const commands = (cfg as { commands?: CommandsConfig }).commands;
  if (!commands?.ownerAllowFrom) return cfg;
  const entry = ownerAllowFromEntry(ownerUserId);
  const next = commands.ownerAllowFrom.filter((e) => String(e) !== entry);
  if (next.length === commands.ownerAllowFrom.length) return cfg;
  return { ...cfg, commands: { ...commands, ownerAllowFrom: next } } as OpenClawConfig;
}

// ---------------------------------------------------------------------------------------------
// The config adapter (ChannelPlugin.config)
// ---------------------------------------------------------------------------------------------

// The SDK's accessor-bearing adapter type plus the optional enabled/configured predicates of
// `ChannelConfigAdapter` (`types.adapters.ts:93-100`; that type is not exported by name, so it is
// matched structurally when the plugin object is assembled).
type AdemuConfigAdapter = ReturnType<typeof createHybridChannelConfigAdapter<ResolvedAdemuAccount>> & {
  isEnabled?: (account: ResolvedAdemuAccount, cfg: OpenClawConfig) => boolean;
  isConfigured?: (account: ResolvedAdemuAccount, cfg: OpenClawConfig) => boolean;
};

const baseAdapter: AdemuConfigAdapter = createHybridChannelConfigAdapter<ResolvedAdemuAccount>({
  sectionKey: CHANNEL_ID,
  listAccountIds: listAdemuAccountIds,
  resolveAccount: (cfg, accountId) => resolveAdemuAccount(cfg, accountId),
  inspectAccount: (cfg, accountId) => inspectAdemuAccount(cfg, accountId),
  defaultAccountId: resolveDefaultAdemuAccountId,
  clearBaseFields: [],
  resolveAllowFrom: (account) => (account.ownerUserId ? [account.ownerUserId] : []),
  formatAllowFrom: (allowFrom) => allowFrom.map(String),
});

export const ademuConfigAdapter: AdemuConfigAdapter = {
  ...baseAdapter,
  isEnabled: (account: ResolvedAdemuAccount) => account.enabled,
  isConfigured: (account: ResolvedAdemuAccount) => account.configured,
  deleteAccount: ({ cfg, accountId }: { cfg: OpenClawConfig; accountId: string }) => {
    const id = normalizeAccountId(accountId);
    const owner = inspectAdemuAccount(cfg, id).ownerUserId;
    const next = baseAdapter.deleteAccount!({ cfg, accountId: id });
    // Rider B, extended: the account's own route binding goes with it (wildcard/peer-scoped rows and
    // other channels stay). Logout keeps the account block and therefore keeps the binding.
    return pruneRouteBindings(pruneOwnerAllowFrom(next, owner, listAdemuAccountIds(next)), { channel: CHANNEL_ID, accountId: id });
  },
};
