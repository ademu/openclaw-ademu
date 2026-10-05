// Channel configuration: `channels.ademu` — accounts (one per enrolled Ademú device), the device
// host (adc daemon) location, and room policies. Design entry §2 R1/R3/R5. Accounts only (no
// single-account root convenience): root-level fields are the inheritance base for
// `dataDir`/`socketPath`/`enabled`; tokens and identities live under accounts. The plugin attaches to
// an INSTALLED adc (AdemuMLS #712): by default the user service's layout, else a system install; the
// Ademú server endpoints are the daemon's own config (`~/.config/adc/config.toml`), so
// `channels.ademu.server` is accepted and ignored (deprecated).
import { existsSync, realpathSync } from "node:fs";
import { homedir, userInfo } from "node:os";
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
import { detectSystemInstall, systemLayout, userServiceLayout, type UserServiceLayout } from "@ademu/adc-control";
import { z } from "zod";
import { pruneRouteBindings } from "./bindings.js";

export const CHANNEL_ID = "ademu";

export const CONTROL_SOCKET_FILE = "adc.sock";
export const SESSION_SOCKET_FILE = "adc-session.sock";
/** The daemon's ENROLLMENT socket (ADC Phase 3b Phase B): the only socket the ceremony half opens. */
export const ENROLL_SOCKET_FILE = "adc-enroll.sock";
/** The system install's state dir per OS (`adc-daemon/src/system_layout.rs`; not exported by the client). */
export function systemDataDir(platform: string = process.platform): string {
  return platform === "darwin" ? "/Library/Application Support/adc" : "/var/lib/adc";
}

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
    /** The device host scope this account was enrolled at; written by both enrollment doors, never inherited. */
    daemonScope: z.enum(["user", "system"]).optional(),
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
  "accounts.*.daemonScope": {
    label: "Device host scope (written at enrollment)",
    advanced: true,
    help: "user: this user's own device host; system: the host's system-wide install. Enrollment writes it, so a system install added later never moves an enrolled account to a device host that does not know its token.",
  },
  dataDir: { label: "Device host data dir", advanced: true },
  socketPath: { label: "Device host control socket", advanced: true },
  enrollSocketPath: { label: "Device host enrollment socket", advanced: true },
  "server.restBaseUrl": {
    label: "Ademú REST base URL (deprecated, ignored)",
    advanced: true,
    help: "Ignored: the device host's own config (~/.config/adc/config.toml) names the server. Removed in a later release.",
  },
  "server.wsUrl": {
    label: "Ademú WebSocket URL (deprecated, ignored)",
    advanced: true,
    help: "Ignored: the device host's own config (~/.config/adc/config.toml) names the server. Removed in a later release.",
  },
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
/**
 * Why the identity has its scope: `explicit` — a `dataDir`/`socketPath`/`enrollSocketPath` key names the
 * paths (always user scope); `enrolled` — the account's recorded `daemonScope`; `detected` — neither, so
 * the host decided (`detectSystemInstall`).
 */
export type ScopeSource = "explicit" | "enrolled" | "detected";

export type DaemonIdentity = {
  /** Canonical data dir (realpath of the deepest existing ancestor + verbatim tail). */
  dataDir: string;
  /** Canonical control socket path (identity data only — the plugin never opens it). */
  controlSocket: string;
  /** Canonical session socket (the fallback when no reachable daemon reports its own). */
  sessionSocket: string;
  /** Canonical enrollment socket: the probe and the ceremony dial it. */
  enrollSocket: string;
  /** Raw values as configured, or from the installed service's layout / the system layout. */
  raw: { dataDir: string; controlSocket: string; sessionSocket: string; enrollSocket: string };
  explicit: { dataDir: boolean; socketPath: boolean; enrollSocketPath: boolean };
  /**
   * `system`: the identity IS the system layout (attach-only, never started — AdemuMLS #712) — because
   * the account was enrolled there, or because nothing is recorded or configured and a system-scope
   * ADC daemon is installed on this host (`detectSystemInstall`: the platform's root-owned config AND
   * its enrollment socket). `user`: everything else — by default the installed user service.
   */
  scope: DaemonScope;
  scopeSource: ScopeSource;
};

/** The hardened host's detector (seam for tests). */
export type SystemInstallDetector = () => boolean;

/** Where the installed user service lives (`@ademu/adc-control` `userServiceLayout`) — the default identity. */
export type UserLayoutResolver = () => UserServiceLayout;

/** The user service's layout as seen from `env` (its HOME first: deterministic under a test env). */
export function defaultUserLayout(env: NodeJS.ProcessEnv = process.env): UserServiceLayout {
  return userServiceLayout({ env, homedir: () => env.HOME || userInfo().homedir });
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
  /** The account's recorded `daemonScope`; absent for an enrollment door or an account enrolled before the key. */
  enrolledScope?: DaemonScope | undefined;
};

/** The system layout as an identity (Linux `/var/lib/adc` + `/run/adc`; macOS `/private/var/db/adc/run`), foreign by scope. */
function systemIdentity(scopeSource: ScopeSource, platform: string): DaemonIdentity {
  const layout = systemLayout(platform);
  const dataDir = systemDataDir(platform);
  return {
    dataDir: canonicalizePath(dataDir),
    controlSocket: canonicalizePath(layout.controlSocketPath),
    sessionSocket: canonicalizePath(layout.sessionSocketPath),
    enrollSocket: canonicalizePath(layout.enrollSocketPath),
    raw: {
      dataDir,
      controlSocket: layout.controlSocketPath,
      sessionSocket: layout.sessionSocketPath,
      enrollSocket: layout.enrollSocketPath,
    },
    explicit: { dataDir: false, socketPath: false, enrollSocketPath: false },
    scope: "system",
    scopeSource,
  };
}

/**
 * Resolves the daemon identity, first rule that applies:
 *   1. any explicit `dataDir`/`socketPath`/`enrollSocketPath` (inherited root values included) → user
 *      scope at exactly those paths: an operator who names paths gets exactly those paths;
 *   2. the account's recorded scope → that scope, whatever the host looks like NOW: a token belongs to
 *      the device host that minted it, so a system install added later never moves a user-scope account
 *      onto a daemon that does not know its token, and a system-scope account never falls back to a
 *      private daemon while the system one is down (or not up yet at boot);
 *   3. nothing recorded or configured → the system layout when a system install is detected, else user
 *      scope at the default data dir.
 */
export function resolveDaemonIdentity(
  input: DaemonIdentityInput,
  env: NodeJS.ProcessEnv = process.env,
  detect: SystemInstallDetector = () => detectSystemInstall(),
  layout: UserLayoutResolver = () => defaultUserLayout(env),
  platform: string = process.platform,
): DaemonIdentity {
  const explicit = {
    dataDir: Boolean(input.dataDir?.trim()),
    socketPath: Boolean(input.socketPath?.trim()),
    enrollSocketPath: Boolean(input.enrollSocketPath?.trim()),
  };
  const anyExplicit = explicit.dataDir || explicit.socketPath || explicit.enrollSocketPath;
  const scopeSource: ScopeSource = anyExplicit ? "explicit" : input.enrolledScope ? "enrolled" : "detected";
  if (scopeSource === "enrolled" && input.enrolledScope === "system") return systemIdentity("enrolled", platform);
  if (scopeSource === "detected" && detect()) return systemIdentity("detected", platform);
  // An explicit data dir keeps every socket under it; otherwise the installed user service's layout
  // (its unit's --data-dir, all three sockets pinned under it — never $XDG_RUNTIME_DIR).
  const service = input.dataDir?.trim() ? undefined : layout();
  const rawDataDir = input.dataDir?.trim() ? expandHome(input.dataDir.trim()) : service!.dataDir;
  const rawControl = input.socketPath?.trim()
    ? expandHome(input.socketPath.trim())
    : service?.controlSocketPath ?? join(rawDataDir, CONTROL_SOCKET_FILE);
  const rawSession = service?.sessionSocketPath ?? join(rawDataDir, SESSION_SOCKET_FILE);
  const rawEnroll = input.enrollSocketPath?.trim()
    ? expandHome(input.enrollSocketPath.trim())
    : service?.enrollSocketPath ?? join(rawDataDir, ENROLL_SOCKET_FILE);
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
    scopeSource,
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
  /** `channels.ademu.server` is set: accepted and IGNORED (deprecated, AdemuMLS #712) — logged once. */
  serverConfigured: boolean;
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

function serverConfigured(channel: AdemuChannelConfig | undefined): boolean {
  return Boolean(channel?.server?.restBaseUrl?.trim() || channel?.server?.wsUrl?.trim());
}

function readAccount(
  cfg: OpenClawConfig,
  accountId: string | null | undefined,
  mode: SecretInputStringResolutionMode,
  env: NodeJS.ProcessEnv,
  detect?: SystemInstallDetector,
  ignoreEnrolledScope = false,
): ResolvedAdemuAccount {
  const channel = getChannelConfig(cfg) ?? ({} as AdemuChannelConfig);
  const id = normalizeOptionalAccountId(accountId) ?? resolveDefaultAdemuAccountId(cfg);
  const entry = resolveAccountEntry(channel.accounts, id) as AdemuAccountConfig | undefined;
  const merged = helpers.resolveAccountConfig(cfg, id) as Record<string, unknown> & Partial<AdemuAccountConfig>;

  const token = resolveSecretInputString({ value: merged.token, path: tokenPath(id), mode });
  const tokenSource: ResolvedAdemuAccount["tokenSource"] =
    token.status === "available" ? "config" : token.status === "configured_unavailable" ? "secretRef" : "none";
  const daemon = resolveDaemonIdentity(
    {
      dataDir: merged.dataDir,
      socketPath: merged.socketPath,
      enrollSocketPath: merged.enrollSocketPath,
      enrolledScope: ignoreEnrolledScope ? undefined : merged.daemonScope,
    },
    env,
    detect,
  );
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
    serverConfigured: serverConfigured(channel),
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
  /** An enrollment door's candidate: validated with the identity the door will dial, existing or not. */
  candidate?: { accountId: string; daemon: DaemonIdentity },
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
  for (const id of ids) identities.set(id, readAccount(cfg, id, "inspect", env, detect).daemon);
  if (candidate) identities.set(candidate.accountId, candidate.daemon);
  // Every control and session socket any identity names: an enrollment socket may be none of them.
  const otherRoles = new Set<string>();
  for (const daemon of identities.values()) {
    otherRoles.add(daemon.controlSocket);
    otherRoles.add(daemon.sessionSocket);
    add(byDir, daemon.dataDir, daemon.controlSocket);
    add(byDirEnroll, daemon.dataDir, daemon.enrollSocket);
    add(bySocket, daemon.controlSocket, daemon.dataDir);
    add(byEnrollSocket, daemon.enrollSocket, daemon.dataDir);
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
    } else if (otherRoles.has(identity.enrollSocket)) {
      errors.set(
        id,
        `daemon identity error: the enrollment socket ${identity.enrollSocket} is another daemon's control or session socket (channels.ademu.enrollSocketPath names an adc-enroll.sock)`,
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

/**
 * Inspect-mode resolution for an enrollment door (wizard, `ademu_enroll`): the account's recorded
 * `daemonScope` is ignored, so a re-enrollment lands where the host points NOW (an explicit key, else
 * the detector) — the way an agent moves onto a system install added after it was enrolled. The door
 * records the scope it enrolled at (`applyEnrollment`).
 */
export function inspectAdemuAccountForEnrollment(
  cfg: OpenClawConfig,
  accountId?: string | null,
  env: NodeJS.ProcessEnv = process.env,
  detect?: SystemInstallDetector,
): Omit<ResolvedAdemuAccount, "token"> {
  const { token: _token, ...account } = readAccount(cfg, accountId, "inspect", env, detect, true);
  // The candidate is validated as the door will dial it, even before its account exists: an
  // enrollment socket configured as the control socket would drive the ceremony with operator authority.
  const error = validateDaemonIdentities(cfg, env, detect, { accountId: account.accountId, daemon: account.daemon }).get(account.accountId);
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
