// DaemonManager (design entry §2 R1/R2/R11, plan T5): who runs the Ademú device host (adc daemon),
// where, and who may stop it.
//
//   identity  = the canonical (dataDir, controlSocket[, sessionSocket]) pair — §2 R1.
//   ownership = a row in the plugin's SQLite (`daemon_ownership`) with a closed state enum and a
//               generation that fences EVERY transition — §2 R2. No row ⇒ FOREIGN: attach only,
//               never spawn, never stop, never upgrade.
//   holders   = cross-process leases (`daemon_holders`, heartbeat 30 s). Only the gateway RUNTIME
//               role may stop a daemon, and only through the atomic fence: sweep stale holders → no
//               other live holder → CAS bound→stopping (new generation) → shutdown op → kill fallback.
//               Setup leases (wizard, chat tool) may spawn but NEVER stop anything.
//   spawn     = `ensureDaemon` from @ademu/adc-control with OUR `spawnFn`, which injects the five
//               env vars (ADC_DATA_DIR, ADC_SOCKET_PATH, ADC_SESSION_SOCKET_PATH, ADC_REST_BASE_URL,
//               ADC_WS_URL), re-checks abort synchronously, and persists the CHILD pid/start facts
//               into the `starting` row before returning (daemon_info carries no pid).
//
// Every timing constant is a named export; every process/fs/net effect goes through `DaemonDeps`
// so the state machine is testable with fakes.
import { spawn as realSpawn, execFileSync } from "node:child_process";
import { createConnection } from "node:net";
import type { Duplex } from "node:stream";
import { chmodSync, existsSync, lstatSync, readdirSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { PlatformPackageMissingError, resolveAdcBinaryPath, UnsupportedPlatformError } from "@ademu/adc-bin";
import { connect as connectControlReal, ensureDaemon as ensureDaemonReal, type ChildLike, type DaemonInfoResult } from "@ademu/adc-control";
import { canonicalizePath, type DaemonIdentity } from "../config.js";
import { strings } from "../i18n/strings.js";
import type { AdemuStore, OwnershipRow, OwnershipState } from "../store.js";

export const STARTING_DEADLINE_MS = 20_000;
export const STOPPING_DEADLINE_MS = 10_000;
export const WAIT_POLL_MS = 250;
export const WAIT_FOR_BOUND_MS = 20_000;
export const WAIT_WHILE_STOPPING_MS = 15_000;
export const RELEASE_CAP_MS = 2_500;
export const SHUTDOWN_OP_MS = 1_500;
export const SIGTERM_GRACE_MS = 500;
export const HEARTBEAT_MS = 30_000;
export const PENDING_PUBLICATION_SWEEP_MS = 3_600_000;
/** Bound on ensureDaemon's pre-spawn bare probe (its `connectFn` seam; the package sets none). */
export const PROBE_CONNECT_MS = 1_000;

export type Role = "runtime" | "setup";
/** Whether a `starting` generation came from a never-bound fresh claim or from existing ownership. */
type SpawnOrigin = "fresh" | "existing";
export type Mode = "owned" | "foreign";

export type ServerEndpoints = { restBaseUrl: string; wsUrl: string };

export type ProcessFacts = { alive: boolean; startedAt?: string; command?: string };

export type ControlLike = {
  daemonInfo(): Promise<DaemonInfoResult>;
  request<R>(op: string, params?: object, options?: { timeoutMs?: number }): Promise<R>;
  close(): Promise<void>;
};

export type DaemonDeps = {
  store: AdemuStore;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  processFacts: (pid: number) => ProcessFacts;
  selfPid: number;
  selfPidStartedAt: string;
  spawn: (cmd: string, argv: string[], opts: object) => ChildLike & { pid?: number | undefined };
  ensureDaemon: typeof ensureDaemonReal;
  connectControl: (socketPath: string) => Promise<ControlLike>;
  resolveBinaryPath: () => string;
  kill: (pid: number, signal: NodeJS.Signals) => void;
  isDirAbsentOrEmpty: (dir: string) => boolean;
  /** For an EXISTING empty dir: verify it is a real directory we own and make it 0700. */
  secureEmptyDir: (dir: string) => "absent" | "ok" | "unsafe";
  /** ensureDaemon's `connectFn` seam: a unix-socket connect that gives up after PROBE_CONNECT_MS. */
  probeConnect: (path: string) => Duplex;
  bundledVersion: string;
  platform: string;
  /** Closed-allowlist structured log: never a path with secrets, never `.detail`. */
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

export class DaemonUnsupportedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnsupportedError";
  }
}
export class DaemonBusyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonBusyError";
  }
}
export class DaemonUnreachableError extends Error {
  constructor(
    message: string,
    readonly logPath?: string,
  ) {
    super(message);
    this.name = "DaemonUnreachableError";
  }
}
export class DaemonAbortedError extends Error {
  constructor() {
    super("daemon acquisition aborted");
    this.name = "DaemonAbortedError";
  }
}
export class DaemonLostError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonLostError";
  }
}

export type AcquireParams = {
  identity: DaemonIdentity;
  server: ServerEndpoints;
  role: Role;
  signal?: AbortSignal | undefined;
  /** Authority re-check (async), awaited immediately before ANY spawn (Codex R8 #2). */
  beforeEffect?: (() => Promise<void>) | undefined;
};

export type Lease = {
  mode: Mode;
  role: Role;
  identity: DaemonIdentity;
  holderId: string;
  info: {
    controlSocketPath: string;
    sessionSocketPath: string;
    daemonVersion?: string | undefined;
    generation?: number | undefined;
    logPath?: string | undefined;
  };
  /** Rejects when an OWNED daemon exits or this lease's holder row was swept (fail closed). Never resolves. */
  lost: Promise<never>;
  release(): Promise<void>;
};

/** `"0.2.4 (abc123)"` → `"0.2.4"`; unparsable → undefined (never triggers an upgrade). */
export function parseAdcVersion(version: string | undefined): string | undefined {
  const m = /^\s*v?(\d+\.\d+\.\d+)/.exec(version ?? "");
  return m ? m[1] : undefined;
}

export function daemonEnv(identity: DaemonIdentity, server: ServerEndpoints, base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return {
    ...base,
    ADC_DATA_DIR: identity.raw.dataDir,
    ADC_SOCKET_PATH: identity.raw.controlSocket,
    ADC_SESSION_SOCKET_PATH: identity.raw.sessionSocket,
    ADC_REST_BASE_URL: server.restBaseUrl,
    ADC_WS_URL: server.wsUrl,
  };
}

function realProcessFacts(pid: number): ProcessFacts {
  try {
    process.kill(pid, 0);
  } catch {
    return { alive: false };
  }
  try {
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf8" }).trim();
    const command = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf8" }).trim();
    return { alive: true, startedAt, command };
  } catch {
    return { alive: true };
  }
}

export function realDaemonDeps(params: { store: AdemuStore; bundledVersion: string; log?: DaemonDeps["log"] }): DaemonDeps {
  const self = realProcessFacts(process.pid);
  return {
    store: params.store,
    now: () => Date.now(),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    processFacts: realProcessFacts,
    selfPid: process.pid,
    selfPidStartedAt: self.startedAt ?? "",
    spawn: (cmd, argv, opts) => realSpawn(cmd, argv, opts as never) as unknown as ChildLike & { pid?: number },
    ensureDaemon: ensureDaemonReal,
    connectControl: async (socketPath) => (await connectControlReal({ socketPath })) as unknown as ControlLike,
    resolveBinaryPath: resolveAdcBinaryPath,
    kill: (pid, signal) => process.kill(pid, signal),
    isDirAbsentOrEmpty: (dir) => !existsSync(dir) || readdirSync(dir).length === 0,
    secureEmptyDir: realSecureEmptyDir,
    probeConnect: boundedProbeConnect,
    bundledVersion: params.bundledVersion,
    platform: process.platform,
    log: params.log ?? (() => {}),
  };
}

type Probe = { info: DaemonInfoResult; matches: boolean };

/** Real-clock bound for a control-plane round trip (the fake clock in tests never reaches it). */
function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("control round trip timed out")), Math.max(1, ms));
    t.unref?.();
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e: unknown) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

/**
 * A unix-socket connect that cannot hang: if neither `connect` nor an error arrives within
 * PROBE_CONNECT_MS the socket is destroyed with an error, which ensureDaemon's bare probe reads as
 * "nothing answered" (→ spawn). `create` is injectable for tests.
 */
export function boundedProbeConnect(path: string, create: (path: string) => Duplex & { setTimeout?: (ms: number, cb: () => void) => unknown; destroy: (err?: Error) => unknown } = (p) => createConnection(p)): Duplex {
  const socket = create(path);
  const timer = setTimeout(() => socket.destroy(new Error("probe connect timed out")), PROBE_CONNECT_MS);
  timer.unref?.();
  const clear = () => clearTimeout(timer);
  socket.once("connect", clear);
  socket.once("error", clear);
  socket.once("close", clear);
  return socket;
}

/** The reachable daemon's own session socket path, or a blocked error — never a derived path. */
function requireSessionSocket(info: DaemonInfoResult): string {
  if (!info.session_socket_path) throw new DaemonUnsupportedError(strings.status.noSessionSocket);
  return info.session_socket_path;
}

/** An existing, empty daemon dir must be a real directory we own; it is then made private (0700). */
export function realSecureEmptyDir(dir: string): "absent" | "ok" | "unsafe" {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(dir);
  } catch {
    return "absent";
  }
  if (st.isSymbolicLink() || !st.isDirectory()) return "unsafe";
  if (typeof process.getuid === "function" && st.uid !== process.getuid()) return "unsafe";
  try {
    chmodSync(dir, 0o700);
  } catch {
    return "unsafe";
  }
  return "ok";
}

/** True when the daemon at the other end is exactly the identity we own (all three paths). */
export function infoMatchesIdentity(info: DaemonInfoResult, identity: DaemonIdentity): boolean {
  const dataDir = info.data_dir ? canonicalizePath(info.data_dir) : "";
  const control = info.socket_path ? canonicalizePath(info.socket_path) : "";
  const session = info.session_socket_path ? canonicalizePath(info.session_socket_path) : "";
  return dataDir === identity.dataDir && control === identity.controlSocket && (!session || session === identity.sessionSocket);
}

export class DaemonManager {
  readonly #deps: DaemonDeps;
  /** Per-identity closing promise: a later acquire awaits a release in flight (never overlaps). */
  readonly #closing = new Map<string, Promise<void>>();
  readonly #leases = new Set<Lease>();

  constructor(deps: DaemonDeps) {
    this.#deps = deps;
  }

  get activeLeases(): number {
    return this.#leases.size;
  }

  // ------------------------------------------------------------------ probing

  /**
   * Probe the control socket. Every stage is raced against the acquisition signal: an abort during
   * a slow hello / daemon_info throws DaemonAbortedError at once (a late connection is closed), so
   * an account stop is never held past its budget by an unresponsive daemon.
   */
  async #probe(controlSocket: string, identity: DaemonIdentity, signal?: AbortSignal): Promise<Probe | undefined> {
    if (signal?.aborted) throw new DaemonAbortedError();
    let control: ControlLike | undefined;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DaemonAbortedError());
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {});
    let abortWon = false;
    try {
      const connecting = this.#deps.connectControl(controlSocket);
      // Late-success containment: a connection that resolves after abort won is closed, once.
      connecting
        .then((c) => {
          if (abortWon) void c.close().catch(() => {});
          else control = c;
        })
        .catch(() => {});
      try {
        control = await Promise.race([connecting, aborted]);
      } catch (err) {
        if (err instanceof DaemonAbortedError) abortWon = true;
        throw err;
      }
      const info = await Promise.race([control.daemonInfo(), aborted]);
      return { info, matches: infoMatchesIdentity(info, identity) };
    } catch (err) {
      if (err instanceof DaemonAbortedError) throw err;
      return undefined;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      void control?.close().catch(() => {});
    }
  }

  #ownerAlive(row: OwnershipRow): boolean {
    if (row.ownerPid == null) return false;
    const facts = this.#deps.processFacts(row.ownerPid);
    if (!facts.alive) return false;
    return !row.ownerPidStartedAt || !facts.startedAt || facts.startedAt === row.ownerPidStartedAt;
  }

  #expired(row: OwnershipRow): boolean {
    return row.deadlineMs != null && this.#deps.now() > row.deadlineMs;
  }

  #isProcessAlive = (pid: number, pidStartedAt: string): boolean => {
    const facts = this.#deps.processFacts(pid);
    return facts.alive && (!pidStartedAt || !facts.startedAt || facts.startedAt === pidStartedAt);
  };

  /**
   * Bound daemon facts still describe a live `adc daemon run` process (defeats pid reuse). FAIL
   * CLOSED: a missing pid, start time, or command is "not proven", never "assumed ours".
   */
  #daemonProcessVerified(row: OwnershipRow): boolean {
    if (row.daemonPid == null || !row.daemonPidStartedAt) return false;
    const facts = this.#deps.processFacts(row.daemonPid);
    if (!facts.alive || !facts.startedAt || !facts.command) return false;
    if (facts.startedAt !== row.daemonPidStartedAt) return false;
    return /\badc\b.*\bdaemon\b\s+\brun\b/.test(facts.command);
  }

  /**
   * Fail-closed proof that the daemon answering on our sockets is the exact instance we bound: all
   * three canonical paths (session socket REQUIRED), the daemon's own start time, and a live pid
   * whose start time and command match the row. Anything missing or different → foreign, never
   * stopped or upgraded (Codex branch review #6).
   */
  #verifyOwnedInstance(row: OwnershipRow, info: DaemonInfoResult): boolean {
    if (!info.session_socket_path || !info.data_dir || !info.socket_path) return false;
    if (canonicalizePath(info.data_dir) !== row.dataDir) return false;
    if (canonicalizePath(info.socket_path) !== row.controlSocket) return false;
    if (canonicalizePath(info.session_socket_path) !== row.sessionSocket) return false;
    if (row.daemonStartedAtMs == null || info.started_at_ms !== row.daemonStartedAtMs) return false;
    return this.#daemonProcessVerified(row);
  }

  /** Tool-door accelerator: the enrollment's config is committed → publish the setup-spawned daemon. */
  promotePendingPublication(dataDir: string): boolean {
    const row = this.#deps.store.getOwnership(dataDir);
    if (!row || row.state !== "pending-publication") return false;
    const ok = this.#deps.store.cas({ dataDir, from: ["pending-publication"], to: "bound", expectedGeneration: row.generation });
    if (ok) this.#deps.log("daemon_promoted", { dataDir });
    return Boolean(ok);
  }

  // ------------------------------------------------------------------ acquire

  async acquire(params: AcquireParams): Promise<Lease> {
    const { identity, role } = params;
    if (this.#deps.platform === "win32") {
      throw new DaemonUnsupportedError("Ademú is not available on Windows yet (no adc daemon build).");
    }
    const pending = this.#closing.get(identity.dataDir);
    if (pending) await pending;

    const holderId = `${role}:${this.#deps.selfPid}:${randomUUID()}`;
    await this.#registerHolder(identity, holderId, role, params.signal);

    try {
      const lease = await this.#acquireInner(params, holderId);
      this.#leases.add(lease);
      return lease;
    } catch (err) {
      this.#deps.store.removeHolder(holderId);
      throw err;
    }
  }

  async #registerHolder(identity: DaemonIdentity, holderId: string, role: Role, signal?: AbortSignal): Promise<void> {
    const deadline = this.#deps.now() + WAIT_WHILE_STOPPING_MS;
    for (;;) {
      if (signal?.aborted) throw new DaemonAbortedError();
      const ok = this.#deps.store.addHolder({
        holderId,
        dataDir: identity.dataDir,
        role,
        pid: this.#deps.selfPid,
        pidStartedAt: this.#deps.selfPidStartedAt,
        heartbeatMs: this.#deps.now(),
      });
      if (ok) return;
      // The daemon is `stopping`: wait for the transition (or recover an orphaned stop).
      const row = this.#deps.store.getOwnership(identity.dataDir);
      if (row?.state === "stopping" && (!this.#ownerAlive(row) || this.#expired(row))) {
        await this.#recoverOrphanedStopping(row, identity, signal);
        continue;
      }
      if (this.#deps.now() > deadline) throw new DaemonBusyError("the Ademú device host is stopping; try again in a moment");
      await this.#deps.sleep(WAIT_POLL_MS);
    }
  }

  /**
   * An orphaned `stopping` row (stopper dead OR deadline passed): no listener → `stopped`; our exact
   * instance still answering → RESUME the stop under this generation; anything else answering → the
   * row is `stale` (we no longer own what listens there). Never `bound` on a path match alone.
   */
  async #recoverOrphanedStopping(row: OwnershipRow, identity: DaemonIdentity, signal?: AbortSignal): Promise<void> {
    const probe = await this.#probe(identity.raw.controlSocket, identity, signal);
    let to: OwnershipState;
    let reason: string;
    if (!probe) {
      to = "stopped";
      reason = "orphaned stop: no listener";
    } else if (this.#verifyOwnedInstance(row, probe.info)) {
      const clean = await this.#terminate(identity, row);
      to = clean ? "stopped" : "stale";
      reason = clean ? "orphaned stop resumed" : "orphaned stop resumed: did not exit within the budget";
    } else {
      to = "stale";
      reason = "orphaned stop: an unverified listener answers on our socket";
    }
    this.#deps.store.cas({
      dataDir: identity.dataDir,
      from: ["stopping"],
      to,
      expectedGeneration: row.generation,
      set: { ownerPid: null, ownerPidStartedAt: null, deadlineMs: null, reason },
    });
    this.#deps.log("daemon_stopping_recovered", { dataDir: identity.dataDir, to });
  }

  async #acquireInner(params: AcquireParams, holderId: string): Promise<Lease> {
    const { identity } = params;
    const store = this.#deps.store;
    const deadline = this.#deps.now() + WAIT_FOR_BOUND_MS;

    for (;;) {
      if (params.signal?.aborted) throw new DaemonAbortedError();
      const row = store.getOwnership(identity.dataDir);

      if (!row) {
        const probe = await this.#probe(identity.raw.controlSocket, identity, params.signal);
        if (probe) return this.#foreignLease(params, holderId, probe.info);
        if (!this.#deps.isDirAbsentOrEmpty(identity.raw.dataDir)) return this.#foreignLease(params, holderId, undefined);
        // An EXISTING empty dir must be ours and private before we put a daemon's state in it
        // (ensureDaemon only applies 0700 to a dir it creates): symlink / other owner → refuse.
        if (this.#deps.secureEmptyDir(identity.raw.dataDir) === "unsafe") {
          throw new DaemonUnsupportedError(
            `the Ademú device host data dir ${identity.raw.dataDir} is a symlink or not owned by this user; fix its ownership and permissions (0700) or choose another channels.ademu.dataDir`,
          );
        }
        // Fresh: claim BEFORE spawn.
        const claimed = store.claim({
          dataDir: identity.dataDir,
          controlSocket: identity.controlSocket,
          sessionSocket: identity.sessionSocket,
          ownerPid: this.#deps.selfPid,
          ownerPidStartedAt: this.#deps.selfPidStartedAt,
        });
        if (!claimed) continue; // someone else claimed between our read and insert — re-decide
        const starting = this.#toStarting(identity, ["claimed"], 0);
        if (!starting) continue;
        return await this.#spawnAndBind(params, holderId, starting, "fresh");
      }

      switch (row.state) {
        case "bound":
        case "pending-publication": {
          const probe = await this.#probe(identity.raw.controlSocket, identity, params.signal);
          if (probe?.matches && !this.#verifyOwnedInstance(row, probe.info)) {
            // Paths match but the instance facts do not: a replacement daemon on our sockets. Attach
            // only — never stop, never upgrade. The row keeps the last facts we could prove.
            this.#deps.log("daemon_unverified_foreign", { dataDir: identity.dataDir, state: row.state });
            return this.#foreignLease(params, holderId, probe.info);
          }
          if (probe?.matches) {
            let current = row;
            if (row.state === "pending-publication" && params.role === "runtime") {
              current = store.cas({ dataDir: identity.dataDir, from: ["pending-publication"], to: "bound", expectedGeneration: row.generation }) ?? row;
              this.#deps.log("daemon_promoted", { dataDir: identity.dataDir });
            }
            return await this.#ownedLease(params, holderId, current, probe.info, undefined);
          }
          if (probe && !probe.matches) return this.#foreignLease(params, holderId, probe.info);
          // Our daemon is dead: respawn under a new generation.
          const starting = this.#toStarting(identity, [row.state], row.generation);
          if (!starting) continue;
          return await this.#spawnAndBind(params, holderId, starting, "existing");
        }
        case "claimed":
        case "starting": {
          if (this.#ownerAlive(row) && !this.#expired(row)) {
            if (this.#deps.now() > deadline) throw new DaemonBusyError("the Ademú device host is still starting");
            await this.#deps.sleep(WAIT_POLL_MS);
            continue;
          }
          // Reclaim an orphaned claim/start by generation CAS.
          const starting = this.#toStarting(identity, [row.state], row.generation);
          if (!starting) continue;
          const probe = await this.#probe(identity.raw.controlSocket, identity, params.signal);
          if (probe) {
            // A listener answers after an orphaned claim/start. Nothing correlates that listener to
            // the pid the crashed starter recorded (daemon_info carries no pid), so we can never
            // PROVE it is the child we spawned: give the row up and attach as FOREIGN. (Narrows the
            // plan's "probe-and-bind a surviving detached daemon" — Codex branch round 2 #2.)
            store.deleteOwnership({ dataDir: identity.dataDir, state: "starting", generation: starting.generation });
            this.#deps.log("daemon_orphan_listener_foreign", { dataDir: identity.dataDir });
            return this.#foreignLease(params, holderId, probe.info);
          }
          // A reclaimed claim/start that had once been bound keeps its ownership history.
          return await this.#spawnAndBind(params, holderId, starting, row.daemonStartedAtMs != null ? "existing" : "fresh");
        }
        case "stopping": {
          if (this.#ownerAlive(row) && !this.#expired(row)) {
            if (this.#deps.now() > deadline) throw new DaemonBusyError("the Ademú device host is stopping");
            await this.#deps.sleep(WAIT_POLL_MS);
            continue;
          }
          await this.#recoverOrphanedStopping(row, identity, params.signal);
          continue;
        }
        case "stopped":
        case "stale": {
          const probe = await this.#probe(identity.raw.controlSocket, identity, params.signal);
          if (probe?.matches && this.#verifyOwnedInstance(row, probe.info)) {
            const bound = store.cas({ dataDir: identity.dataDir, from: [row.state], to: "bound", expectedGeneration: row.generation });
            if (bound) return await this.#ownedLease(params, holderId, bound, probe.info, undefined);
            continue;
          }
          if (probe) return this.#foreignLease(params, holderId, probe.info);
          if (this.#daemonProcessVerified(row)) {
            // Our recorded child is ALIVE but not listening (a spawn that never came up): never
            // start a second daemon beside it — retry once it has exited (Codex branch round 11 #2).
            this.#deps.log("daemon_child_alive_not_listening", { dataDir: identity.dataDir });
            throw new DaemonUnreachableError(
              `a previous Ademú device host process is still running but not answering; it will be retried once it exits (daemon log: ${identity.raw.dataDir}/daemon.log)`,
              `${identity.raw.dataDir}/daemon.log`,
            );
          }
          const starting = this.#toStarting(identity, [row.state], row.generation);
          if (!starting) continue;
          return await this.#spawnAndBind(params, holderId, starting, "existing");
        }
        default:
          throw new Error(`unknown ownership state ${String((row as { state: string }).state)}`);
      }
    }
  }

  #toStarting(identity: DaemonIdentity, from: readonly OwnershipState[], expectedGeneration: number): OwnershipRow | undefined {
    return this.#deps.store.cas({
      dataDir: identity.dataDir,
      from,
      to: "starting",
      expectedGeneration,
      bumpGeneration: true,
      set: {
        ownerPid: this.#deps.selfPid,
        ownerPidStartedAt: this.#deps.selfPidStartedAt,
        deadlineMs: this.#deps.now() + STARTING_DEADLINE_MS,
        daemonPid: null,
        daemonPidStartedAt: null,
        reason: null,
      },
    });
  }

  #bind(role: Role, starting: OwnershipRow, info: DaemonInfoResult, daemonPid: number | null, daemonPidStartedAt: string | null): OwnershipRow | undefined {
    return this.#deps.store.cas({
      dataDir: starting.dataDir,
      from: ["starting"],
      to: role === "setup" ? "pending-publication" : "bound",
      expectedGeneration: starting.generation,
      set: {
        daemonPid,
        daemonPidStartedAt,
        daemonStartedAtMs: info.started_at_ms,
        daemonDataDir: info.data_dir,
        daemonSocketPath: info.socket_path,
        daemonSessionSocketPath: info.session_socket_path ?? null,
        adcVersion: parseAdcVersion(info.version) ?? null,
        bundledVersion: this.#deps.bundledVersion,
        ownerPid: null,
        ownerPidStartedAt: null,
        deadlineMs: null,
      },
    });
  }

  // ------------------------------------------------------------------ spawn

  /**
   * Give up a `starting` generation we could not turn into a bound instance. A FRESH claim (never
   * bound) is deleted; EXISTING ownership (respawn of a bound/stopped/stale daemon) is preserved and
   * CASed back to `stopped` (nothing runs) or `stale` (an unverified listener answers) — deleting it
   * would downgrade our own daemon to foreign forever (Codex branch round 10 #1).
   */
  #abandonStarting(identity: DaemonIdentity, starting: OwnershipRow, origin: SpawnOrigin, to: "stopped" | "stale", reason: string): void {
    const store = this.#deps.store;
    if (origin === "fresh") {
      store.deleteOwnership({ dataDir: identity.dataDir, state: "starting", generation: starting.generation });
      return;
    }
    store.cas({
      dataDir: identity.dataDir,
      from: ["starting"],
      to,
      expectedGeneration: starting.generation,
      set: { ownerPid: null, ownerPidStartedAt: null, deadlineMs: null, reason },
    });
  }

  async #spawnAndBind(params: AcquireParams, holderId: string, starting: OwnershipRow, origin: SpawnOrigin): Promise<Lease> {
    const { identity, server, role } = params;
    const store = this.#deps.store;
    let child: (ChildLike & { pid?: number | undefined }) | undefined;
    // Once a child EXISTS every abandonment is `stale` with the child's pid facts kept — for a fresh
    // claim too — so a live-but-unverified process is never forgotten (it authorizes the later fenced
    // stop and forbids a second spawn beside it). Without a child the origin rule applies.
    const abandon = (to: "stopped" | "stale", reason: string) =>
      child ? this.#abandonStarting(identity, starting, "existing", "stale", reason) : this.#abandonStarting(identity, starting, origin, to, reason);
    let binaryPath: string;
    try {
      binaryPath = this.#deps.resolveBinaryPath();
    } catch (err) {
      abandon("stopped", "binary unavailable");
      if (err instanceof UnsupportedPlatformError) throw new DaemonUnsupportedError(`Ademú is not available on ${err.platform}/${err.arch} yet.`);
      if (err instanceof PlatformPackageMissingError) {
        throw new DaemonUnreachableError(`the Ademú device host binary package is missing (${err.packageName}); reinstall the plugin`);
      }
      throw err;
    }

    // The ASYNC authority re-check runs immediately before the spawn; inside spawnFn only SYNCHRONOUS
    // checks can live: the abort flag and the exact-generation ownership re-read. ensureDaemon's own
    // probe-then-spawn window is its bare probe, which WE bound to PROBE_CONNECT_MS through the
    // `connectFn` seam (the package's bare probe has no timeout of its own). A rejected re-check must
    // not leave our `starting` generation behind.
    try {
      await params.beforeEffect?.();
    } catch (err) {
      abandon("stopped", "authority check rejected before spawn");
      throw err;
    }
    if (params.signal?.aborted) {
      abandon("stopped", "aborted before spawn");
      throw new DaemonAbortedError();
    }
    // The authority check may have outlived our `starting` deadline: refresh the generation's
    // owner/deadline by exact-generation CAS — if it loses, another process reclaimed the identity
    // and ONLY that winner may call ensureDaemon (Codex branch round 10 #2).
    const refreshed = store.cas({
      dataDir: identity.dataDir,
      from: ["starting"],
      to: "starting",
      expectedGeneration: starting.generation,
      set: { ownerPid: this.#deps.selfPid, ownerPidStartedAt: this.#deps.selfPidStartedAt, deadlineMs: this.#deps.now() + STARTING_DEADLINE_MS },
    });
    if (!refreshed) throw new DaemonBusyError("the Ademú device host changed hands while starting");
    const stillOurGeneration = () => {
      const current = store.getOwnership(identity.dataDir);
      return current?.state === "starting" && current.generation === starting.generation;
    };

    const env = daemonEnv(identity, server);
    let exited: { code: unknown; signal: unknown } | undefined;
    const exitWaiters = new Set<() => void>();

    const spawnFn = (cmd: string, argv: string[], opts: object) => {
      if (params.signal?.aborted) throw new DaemonAbortedError();
      // Synchronous last look: our exact generation must still own the identity at the spawn instant.
      if (!stillOurGeneration()) throw new DaemonBusyError("the Ademú device host changed hands while starting");
      const c = this.#deps.spawn(cmd, argv, { ...(opts as object), env });
      child = c;
      // Persist the CHILD facts under our generation NOW (daemon_info carries no pid).
      const facts = c.pid != null ? this.#deps.processFacts(c.pid) : { alive: false };
      store.cas({
        dataDir: identity.dataDir,
        from: ["starting"],
        to: "starting",
        expectedGeneration: starting.generation,
        set: { daemonPid: c.pid ?? null, daemonPidStartedAt: facts.startedAt ?? null },
      });
      c.on("exit", (...args: unknown[]) => {
        exited = { code: args[0], signal: args[1] };
        for (const w of exitWaiters) w();
      });
      return c;
    };

    const ensure = this.#deps.ensureDaemon({ binaryPath, env, spawnFn, connectFn: this.#deps.probeConnect });
    const abortP = new Promise<never>((_, reject) => {
      if (!params.signal) return;
      const onAbort = () => reject(new DaemonAbortedError());
      if (params.signal.aborted) onAbort();
      else params.signal.addEventListener("abort", onAbort, { once: true });
    });

    let result: Awaited<ReturnType<typeof ensureDaemonReal>>;
    try {
      result = await Promise.race([ensure, abortP]);
    } catch (err) {
      if (err instanceof DaemonAbortedError) {
        // Contain a late success: observe the ensureDaemon promise; bind under the current
        // generation in the role's terminal state (runtime → bound, then the fenced release;
        // setup → pending-publication, left idle — setup never stops anything).
        void ensure
          .then(async (late) => {
            if (!late.spawned) {
              abandon("stale", "listener answered during an aborted start");
              return;
            }
            let probe: Probe | undefined;
            try {
              probe = await this.#probe(identity.raw.controlSocket, identity);
            } catch {
              probe = undefined;
            }
            if (!probe?.matches) {
              abandon("stale", probe ? "the listener after an aborted start is not the identity we started" : "spawned child did not answer after an aborted start");
              return;
            }
            const latePid = child?.pid ?? null;
            const lateStartedAt = latePid != null ? (this.#deps.processFacts(latePid).startedAt ?? null) : null;
            const bound = this.#bind(role, starting, probe.info, latePid, lateStartedAt);
            if (bound && role === "runtime") {
              await this.#stopOwnedDaemon(identity, bound, holderId, "aborted start");
            }
          })
          .catch(() => {
            // ensureDaemon rejected after our abort — either spawnFn threw before any child existed
            // (→ the origin rule) or its hello ladder gave up on a child that DID spawn (→ `stale`
            // with the child's pid facts, chosen by abandon() itself). Never leave `starting` behind.
            abandon("stopped", "ensureDaemon rejected after an aborted start");
          });
        throw err;
      }
      abandon("stopped", "daemon did not start");
      throw new DaemonUnreachableError(
        `the Ademú device host did not start; check channels.ademu.server and the daemon log at ${identity.raw.dataDir}/daemon.log`,
        `${identity.raw.dataDir}/daemon.log`,
      );
    }

    if (!result.spawned) {
      // A listener won the probe-then-spawn race: it is not ours.
      abandon("stale", "a listener won the probe-then-spawn race");
      const probe = await this.#probe(identity.raw.controlSocket, identity, params.signal);
      return this.#foreignLease(params, holderId, probe?.info);
    }

    let probe: Probe | undefined;
    try {
      probe = await this.#probe(identity.raw.controlSocket, identity, params.signal);
    } catch (err) {
      abandon("stale", "aborted while verifying the spawned child");
      throw err;
    }
    if (!probe) {
      abandon("stale", "spawned child did not answer");
      throw new DaemonUnreachableError(`the Ademú device host started but its control socket did not answer; see ${result.logPath}`, result.logPath);
    }
    if (!probe.matches) {
      abandon("stale", "the listener after spawn is not the identity we started");
      return this.#foreignLease(params, holderId, probe.info);
    }
    const current = store.getOwnership(identity.dataDir);
    const bound = this.#bind(role, starting, probe.info, current?.daemonPid ?? child?.pid ?? null, current?.daemonPidStartedAt ?? null);
    if (!bound) throw new DaemonBusyError("the Ademú device host changed hands while starting");
    this.#deps.log("daemon_spawned", { dataDir: identity.dataDir, role, generation: bound.generation });
    return await this.#ownedLease(params, holderId, bound, probe.info, {
      exited: () => exited,
      onExit: (cb) => {
        exitWaiters.add(cb);
      },
      logPath: result.logPath,
    });
  }

  // ------------------------------------------------------------------ leases

  #foreignLease(params: AcquireParams, holderId: string, info: DaemonInfoResult | undefined): Lease {
    const { identity } = params;
    this.#deps.log("daemon_attached_foreign", { dataDir: identity.dataDir, reachable: Boolean(info) });
    const hb = this.#startHeartbeat(holderId, () => false);
    const lease: Lease = {
      mode: "foreign",
      role: params.role,
      identity,
      holderId,
      info: {
        controlSocketPath: identity.raw.controlSocket,
        // A REACHABLE daemon's reported session socket is authoritative and must never be
        // re-derived (PROTOCOL.md: a squatter on a derived path would receive the bearer token).
        // Only an UNREACHABLE foreign daemon keeps the configured path (the session connect then
        // fails and the account stays `recovering`).
        sessionSocketPath: info ? requireSessionSocket(info) : identity.raw.sessionSocket,
        daemonVersion: parseAdcVersion(info?.version),
      },
      lost: hb.lost,
      release: async () => {
        hb.stop();
        this.#deps.store.removeHolder(holderId);
        this.#leases.delete(lease);
      },
    };
    return lease;
  }

  async #ownedLease(
    params: AcquireParams,
    holderId: string,
    row: OwnershipRow,
    info: DaemonInfoResult,
    child: { exited: () => unknown; onExit: (cb: () => void) => void; logPath: string } | undefined,
  ): Promise<Lease> {
    const { identity, role } = params;
    // Upgrade (runtime only, through the fence): the bound daemon's version ≠ the bundled one.
    if (role === "runtime") {
      const running = parseAdcVersion(info.version);
      if (running && running !== this.#deps.bundledVersion) {
        const upgraded = await this.#tryUpgrade(params, holderId, row);
        if ("mode" in upgraded) return upgraded;
        if (upgraded.kind === "failed") {
          // We claimed the stop and it did not complete: the row is `stale` and whatever answers on
          // the socket is no longer proven ours — attach foreign, or fail recoverably if nothing answers.
          const probe = await this.#probe(identity.raw.controlSocket, identity, params.signal);
          if (probe) return this.#foreignLease(params, holderId, probe.info);
          throw new DaemonUnreachableError("the Ademú device host could not be upgraded and no longer answers; check the daemon log", undefined);
        }
        // deferred (another live holder): keep the running, still-verified instance.
      }
    }
    const daemonPid = row.daemonPid;
    const hb = this.#startHeartbeat(holderId, () => {
      if (child?.exited()) return true;
      if (daemonPid != null) return !this.#deps.processFacts(daemonPid).alive;
      return false;
    });
    child?.onExit(() => hb.fail(new DaemonLostError("the Ademú device host exited")));
    const lease: Lease = {
      mode: "owned",
      role,
      identity,
      holderId,
      info: {
        controlSocketPath: identity.raw.controlSocket,
        sessionSocketPath: requireSessionSocket(info),
        daemonVersion: parseAdcVersion(info.version),
        generation: row.generation,
        logPath: child?.logPath,
      },
      lost: hb.lost,
      release: async () => {
        hb.stop();
        this.#leases.delete(lease);
        if (role !== "runtime") {
          this.#deps.store.removeHolder(holderId);
          return;
        }
        const closing = this.#releaseRuntime(identity, holderId, "last account stopped");
        this.#closing.set(identity.dataDir, closing);
        try {
          await closing;
        } finally {
          if (this.#closing.get(identity.dataDir) === closing) this.#closing.delete(identity.dataDir);
        }
      },
    };
    return lease;
  }

  #startHeartbeat(holderId: string, lostCheck: () => boolean): { lost: Promise<never>; stop: () => void; fail: (err: Error) => void } {
    let reject!: (err: Error) => void;
    const lost = new Promise<never>((_, rej) => {
      reject = rej;
    });
    lost.catch(() => {});
    let stopped = false;
    const tick = () => {
      if (stopped) return;
      if (!this.#deps.store.heartbeat(holderId)) {
        reject(new DaemonLostError("this lease's holder record was swept; re-acquire"));
        return;
      }
      if (lostCheck()) {
        reject(new DaemonLostError("the Ademú device host is gone"));
        return;
      }
      timer = setTimeout(tick, HEARTBEAT_MS);
      timer.unref?.();
    };
    let timer: NodeJS.Timeout | undefined = setTimeout(tick, HEARTBEAT_MS);
    timer.unref?.();
    return {
      lost,
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
      fail: (err) => reject(err),
    };
  }

  // ------------------------------------------------------------------ stop / upgrade / sweep

  async #releaseRuntime(identity: DaemonIdentity, holderId: string, reason: string): Promise<void> {
    const store = this.#deps.store;
    const row = store.getOwnership(identity.dataDir);
    if (!row || (row.state !== "bound" && row.state !== "pending-publication")) {
      store.removeHolder(holderId);
      return;
    }
    await this.#stopOwnedDaemon(identity, row, holderId, reason);
  }

  /** The fenced stop. Removes our holder afterwards; leaves the daemon running if the fence denies. */
  async #stopOwnedDaemon(identity: DaemonIdentity, row: OwnershipRow, holderId: string, reason: string): Promise<boolean> {
    const store = this.#deps.store;
    const claimed = store.tryClaimShutdown({
      dataDir: identity.dataDir,
      holderId,
      expectedGeneration: row.generation,
      stopperPid: this.#deps.selfPid,
      stopperPidStartedAt: this.#deps.selfPidStartedAt,
      deadlineMs: this.#deps.now() + STOPPING_DEADLINE_MS,
      reason,
      isProcessAlive: this.#isProcessAlive,
    });
    store.removeHolder(holderId);
    if (!claimed) {
      this.#deps.log("daemon_stop_deferred", { dataDir: identity.dataDir, reason });
      return false;
    }
    const exitedCleanly = await this.#terminate(identity, claimed);
    // Re-read the generation immediately before recording the outcome (the fence's last check).
    store.cas({
      dataDir: identity.dataDir,
      from: ["stopping"],
      to: exitedCleanly ? "stopped" : "stale",
      expectedGeneration: claimed.generation,
      set: { ownerPid: null, ownerPidStartedAt: null, deadlineMs: null, reason: exitedCleanly ? reason : "did not exit within the stop budget" },
    });
    this.#deps.log("daemon_stopped", { dataDir: identity.dataDir, clean: exitedCleanly });
    return true;
  }

  /** shutdown op (bounded) → observe exit → SIGTERM → SIGKILL, capped at RELEASE_CAP_MS. */
  async #terminate(identity: DaemonIdentity, row: OwnershipRow): Promise<boolean> {
    const start = this.#deps.now();
    const remaining = () => Math.max(0, RELEASE_CAP_MS - (this.#deps.now() - start));
    const pid = row.daemonPid;
    const verified = pid != null && this.#daemonProcessVerified(row);
    const gone = () => (pid == null ? !existsSync(identity.raw.controlSocket) : !this.#deps.processFacts(pid).alive);

    let control: ControlLike | undefined;
    let connectTimedOut = false;
    try {
      const connecting = this.#deps.connectControl(identity.raw.controlSocket);
      connecting.then((c) => (connectTimedOut ? void c.close().catch(() => {}) : undefined)).catch(() => {});
      try {
        control = await withTimeout(connecting, Math.min(SHUTDOWN_OP_MS, remaining()));
      } catch (err) {
        connectTimedOut = true;
        throw err;
      }
      // Last look immediately BEFORE the daemon-global shutdown op: the row must still be OUR
      // `stopping` generation and the listener must still be the bound instance (a replacement
      // that slipped onto the socket between the fence and this connect is never shut down).
      const info = await withTimeout(control.daemonInfo(), Math.min(SHUTDOWN_OP_MS, remaining()));
      const current = this.#deps.store.getOwnership(identity.dataDir);
      if (!current || current.state !== "stopping" || current.generation !== row.generation || !this.#verifyOwnedInstance(row, info)) {
        this.#deps.log("daemon_shutdown_withheld", { dataDir: identity.dataDir });
        return false;
      }
      await control.request("shutdown", {}, { timeoutMs: Math.min(SHUTDOWN_OP_MS, remaining()) });
    } catch {
      /* unreachable or slow: fall through to the (verified-pid-only) signals */
    } finally {
      if (control) await withTimeout(control.close(), Math.max(1, remaining())).catch(() => {});
    }
    while (!gone() && this.#deps.now() - start < SHUTDOWN_OP_MS && remaining() > 0) await this.#deps.sleep(100);
    if (gone()) return true;
    if (!verified) return false; // never signal a pid we cannot prove is ours
    // Immediately before EACH signal: the row must still be our `stopping` generation and the pid
    // must still carry the recorded start time + command (a reused pid after the daemon's own exit
    // is "gone", never a target — Codex branch round 2 #3).
    const stillOurs = () => {
      const current = this.#deps.store.getOwnership(identity.dataDir);
      return current?.state === "stopping" && current.generation === row.generation && this.#daemonProcessVerified(row);
    };
    if (!stillOurs()) return gone();
    try {
      this.#deps.kill(pid!, "SIGTERM");
    } catch {
      /* already gone */
    }
    const termUntil = this.#deps.now() + SIGTERM_GRACE_MS;
    while (!gone() && this.#deps.now() < termUntil && remaining() > 0) await this.#deps.sleep(100);
    if (gone()) return true;
    if (!stillOurs()) return gone();
    try {
      this.#deps.kill(pid!, "SIGKILL");
    } catch {
      /* already gone */
    }
    while (!gone() && remaining() > 0) await this.#deps.sleep(100);
    return gone();
  }

  async #tryUpgrade(params: AcquireParams, holderId: string, row: OwnershipRow): Promise<Lease | { kind: "deferred" | "failed" }> {
    const { identity } = params;
    const store = this.#deps.store;
    const claimed = store.tryClaimShutdown({
      dataDir: identity.dataDir,
      holderId,
      expectedGeneration: row.generation,
      stopperPid: this.#deps.selfPid,
      stopperPidStartedAt: this.#deps.selfPidStartedAt,
      deadlineMs: this.#deps.now() + STOPPING_DEADLINE_MS,
      reason: `upgrade to ${this.#deps.bundledVersion}`,
      isProcessAlive: this.#isProcessAlive,
    });
    if (!claimed) {
      this.#deps.log("daemon_upgrade_deferred", { dataDir: identity.dataDir });
      return { kind: "deferred" };
    }
    // tryClaimShutdown does not remove our own holder; keep it — we are about to respawn.
    const clean = await this.#terminate(identity, claimed);
    const stopped = store.cas({ dataDir: identity.dataDir, from: ["stopping"], to: clean ? "stopped" : "stale", expectedGeneration: claimed.generation });
    if (!stopped || !clean) {
      this.#deps.log("daemon_upgrade_failed", { dataDir: identity.dataDir, clean });
      return { kind: "failed" };
    }
    const starting = this.#toStarting(identity, ["stopped"], stopped.generation);
    if (!starting) return { kind: "failed" };
    this.#deps.log("daemon_upgrading", { dataDir: identity.dataDir, to: this.#deps.bundledVersion });
    return await this.#spawnAndBind(params, holderId, starting, "existing");
  }

  /**
   * Runtime start sweep: `pending-publication` daemons older than PENDING_PUBLICATION_SWEEP_MS whose
   * enrollment never produced an account are stopped THROUGH THE FENCE.
   */
  async sweepPendingPublications(isReferenced: (dataDir: string) => boolean): Promise<string[]> {
    const swept: string[] = [];
    for (const row of this.#deps.store.listOwnership()) {
      if (row.state !== "pending-publication") continue;
      if (this.#deps.now() - row.updatedAtMs < PENDING_PUBLICATION_SWEEP_MS) continue;
      if (isReferenced(row.dataDir)) continue;
      const identity: DaemonIdentity = {
        dataDir: row.dataDir,
        controlSocket: row.controlSocket,
        sessionSocket: row.sessionSocket,
        raw: { dataDir: row.dataDir, controlSocket: row.controlSocket, sessionSocket: row.sessionSocket },
        explicit: { dataDir: true, socketPath: true },
      };
      const holderId = `runtime:${this.#deps.selfPid}:sweep:${randomUUID()}`;
      if (!this.#deps.store.addHolder({ holderId, dataDir: row.dataDir, role: "runtime", pid: this.#deps.selfPid, pidStartedAt: this.#deps.selfPidStartedAt, heartbeatMs: this.#deps.now() })) continue;
      if (await this.#stopOwnedDaemon(identity, row, holderId, "pending enrollment never published")) swept.push(row.dataDir);
    }
    return swept;
  }
}
