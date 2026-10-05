// DaemonAttacher (AdemuMLS #712, DECISIONS.md §7.5): how the plugin reaches the Ademú device host
// (adc daemon). The plugin NEVER runs one: it attaches to the adc the user installed as an OS
// service (user scope, `adc service install`) or to a system install, and never spawns, stops,
// kills or upgrades a daemon. There is no ownership state.
//
//   sockets   = the plugin never opens the control socket. The probe dials the ENROLLMENT socket
//               (`daemon_info` is in its op table); `PrivilegeError` there means "a daemon exists but
//               this uid may not open it" — never "nothing listening". A reachable daemon's reported
//               `session_socket_path` is the authority (PROTOCOL.md, "Resolving the session socket
//               path"); only when nothing answers does the configured/layout path stand in.
//   runtime   = probes once and attaches; it never starts a service and never waits (a deliberate
//               `adc service stop` is respected; the gateway's restart loop and the client's own
//               reconnect loop bring the account back when adc is up).
//   setup     = the enrollment doors (wizard, `ademu_enroll`). When nothing answers and the identity is
//               the installed user service's own enrollment socket, it asks the OS service manager to
//               start that service (`@ademu/adc-control` `startUserService`: launchctl/systemctl, never
//               spawn/stop/kill) and waits for the enrollment socket. A system install, or an explicit
//               path that is not the service's, is never started.
//
// Every effect goes through `AttachDeps` so the ladder is testable with fakes.
import {
  connectEnroll as connectEnrollReal,
  PrivilegeError,
  startUserService as startUserServiceReal,
  userServiceInstalled as userServiceInstalledReal,
  userServiceLayout as userServiceLayoutReal,
  type DaemonInfoResult,
  type UserServiceLayout,
  type UserServiceStartResult,
  type UserServiceState,
} from "@ademu/adc-control";
import { createConnection } from "node:net";
import { canonicalizePath, type DaemonIdentity } from "../config.js";
import { strings } from "../i18n/strings.js";

export const WAIT_POLL_MS = 250;
/** How long an enrollment waits for a just-started service's enrollment socket. */
export const SERVICE_START_WAIT_MS = 20_000;
/** Bound on the "is a pre-enrollment-socket daemon here?" control-socket connect. */
export const CONTROL_CONNECT_MS = 1_000;
/**
 * The first adc whose user service pins all three sockets under its data dir (AdemuMLS #712) and binds
 * the enrollment socket (Phase B). An older daemon is refused as "too old: re-run the installer".
 */
export const MIN_ADC_VERSION = "0.6.0";

/** `"0.2.4 (abc123)"` → `"0.2.4"`; unparsable → undefined. */
export function parseAdcVersion(version: string | undefined): string | undefined {
  const m = /^\s*v?(\d+\.\d+\.\d+)/.exec(version ?? "");
  return m ? m[1] : undefined;
}

/** `a >= b` on parsed `x.y.z` versions; an unparsable side is "not at least" (fail closed). */
export function versionAtLeast(a: string | undefined, b: string): boolean {
  const pa = parseAdcVersion(a);
  const pb = parseAdcVersion(b);
  if (!pa || !pb) return false;
  const [a1, a2, a3] = pa.split(".").map(Number) as [number, number, number];
  const [b1, b2, b3] = pb.split(".").map(Number) as [number, number, number];
  return a1 !== b1 ? a1 > b1 : a2 !== b2 ? a2 > b2 : a3 >= b3;
}

export type Role = "runtime" | "setup";

/** What the attacher needs from an ENROLLMENT-socket connection: `daemon_info` and nothing else. */
export type EnrollLike = {
  daemonInfo(): Promise<DaemonInfoResult>;
  close(): Promise<void>;
};

export type UserServiceSeam = {
  layout: () => UserServiceLayout;
  installed: (layout: UserServiceLayout) => Promise<UserServiceState>;
  start: (layout: UserServiceLayout) => Promise<UserServiceStartResult>;
};

export type AttachDeps = {
  now: () => number;
  /** Resolves after `ms`, or early on `signal` (a real one clears its timer). */
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
  connectEnroll: (socketPath: string) => Promise<EnrollLike>;
  /** Connect-and-close on the CONTROL socket path, nothing spoken: is a (pre-Phase-B) daemon here? */
  controlSocketAnswers: (socketPath: string) => Promise<boolean>;
  userService: UserServiceSeam;
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
/** Nothing answers at an explicitly configured (or system) device host; the plugin starts nothing. */
export class DaemonUnreachableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DaemonUnreachableError";
  }
}
export class DaemonAbortedError extends Error {
  constructor() {
    super("daemon attach aborted");
    this.name = "DaemonAbortedError";
  }
}
/** No user service is installed for this uid (the unit file is absent). */
export class AdcServiceNotInstalledError extends Error {
  constructor(readonly layout: UserServiceLayout) {
    super("the adc user service is not installed");
    this.name = "AdcServiceNotInstalledError";
  }
}
/** The installed service was asked to start but its enrollment socket did not answer (or it is disabled). */
export class AdcServiceNotAnsweringError extends Error {
  constructor(
    readonly layout: UserServiceLayout,
    readonly disabled: boolean,
    readonly reason?: string,
  ) {
    super(disabled ? "the adc user service is disabled" : "the adc user service did not answer");
    this.name = "AdcServiceNotAnsweringError";
  }
}
/** A device host older than MIN_ADC_VERSION, or one without the enrollment socket. */
export class AdcTooOldError extends Error {
  constructor(readonly version?: string) {
    super("the adc device host is too old");
    this.name = "AdcTooOldError";
  }
}
/** Runtime: the daemon's session socket moved (re-resolved after repeated reconnect failures). */
export class SessionSocketMovedError extends Error {
  constructor() {
    super("the device host's session socket moved");
    this.name = "SessionSocketMovedError";
  }
}

/** Why a runtime attachment found nothing answering — the copy to show while `recovering`. */
export type Unreachable = "not_installed" | "disabled" | "not_running" | "system_down";

export type AttachParams = {
  identity: DaemonIdentity;
  role: Role;
  signal?: AbortSignal | undefined;
  /** Authority re-check (async), awaited immediately before asking the service manager to start. */
  beforeEffect?: (() => Promise<void>) | undefined;
};

export type Attachment = {
  role: Role;
  identity: DaemonIdentity;
  info: {
    /** The enrollment socket the ceremony half dials (never the control socket). */
    enrollSocketPath: string;
    sessionSocketPath: string;
    daemonVersion?: string | undefined;
  };
  /** Runtime only: set when nothing answered — the session path is then the fallback. */
  unreachable?: Unreachable | undefined;
  release(): Promise<void>;
};

export type Attacher = {
  attach(params: AttachParams): Promise<Attachment>;
  /** The session path as the runtime re-resolves it: reported when reachable, else the fallback. */
  resolveSessionSocket(identity: DaemonIdentity, signal?: AbortSignal): Promise<string>;
};

/** The reachable daemon's own session socket path, or a blocked error — never a derived path. */
function requireSessionSocket(info: DaemonInfoResult): string {
  if (!info.session_socket_path) throw new DaemonUnsupportedError(strings.status.noSessionSocket);
  return info.session_socket_path;
}

function controlSocketAnswersReal(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const done = (answered: boolean) => {
      clearTimeout(timer);
      socket.destroy();
      resolve(answered);
    };
    const timer = setTimeout(() => done(false), CONTROL_CONNECT_MS);
    timer.unref?.();
    socket.once("connect", () => done(true));
    socket.once("error", () => done(false));
  });
}

/** A real sleep that resolves early on abort and leaves neither its timer nor its listener behind. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    signal?.addEventListener("abort", done, { once: true });
  });
}

export function realAttachDeps(params: { log: AttachDeps["log"] }): AttachDeps {
  return {
    now: () => Date.now(),
    sleep: abortableSleep,
    connectEnroll: async (socketPath) => (await connectEnrollReal({ socketPath })) as unknown as EnrollLike,
    controlSocketAnswers: controlSocketAnswersReal,
    userService: {
      layout: () => userServiceLayoutReal(),
      installed: (layout) => userServiceInstalledReal(layout),
      start: (layout) => startUserServiceReal(layout),
    },
    platform: process.platform,
    log: params.log,
  };
}

export class DaemonAttacher implements Attacher {
  readonly #deps: AttachDeps;

  constructor(deps: AttachDeps) {
    this.#deps = deps;
  }

  /**
   * Probe the ENROLLMENT socket. Every stage is raced against the signal: an abort during a slow
   * hello / daemon_info throws DaemonAbortedError at once (a late connection is closed). `undefined`
   * = nothing listening. A `PrivilegeError` (a daemon exists, this uid may not open it) is RETHROWN.
   */
  async #probe(enrollSocket: string, signal?: AbortSignal): Promise<DaemonInfoResult | undefined> {
    if (signal?.aborted) throw new DaemonAbortedError();
    let control: EnrollLike | undefined;
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DaemonAbortedError());
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    aborted.catch(() => {});
    let abortWon = false;
    try {
      const connecting = this.#deps.connectEnroll(enrollSocket);
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
      return await Promise.race([control.daemonInfo(), aborted]);
    } catch (err) {
      if (err instanceof DaemonAbortedError || err instanceof PrivilegeError) throw err;
      return undefined;
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
      void control?.close().catch(() => {});
    }
  }

  /** The installed user service's layout when THIS identity is that service's enrollment socket. */
  #serviceLayoutFor(identity: DaemonIdentity): UserServiceLayout | undefined {
    if (identity.scope !== "user") return undefined;
    const layout = this.#deps.userService.layout();
    return canonicalizePath(layout.enrollSocketPath) === identity.enrollSocket ? layout : undefined;
  }

  #attachment(params: AttachParams, info: DaemonInfoResult | undefined, unreachable?: Unreachable): Attachment {
    const { identity, role } = params;
    return {
      role,
      identity,
      info: {
        enrollSocketPath: identity.raw.enrollSocket,
        sessionSocketPath: info ? requireSessionSocket(info) : identity.raw.sessionSocket,
        daemonVersion: parseAdcVersion(info?.version),
      },
      unreachable,
      release: async () => {},
    };
  }

  #checkVersion(info: DaemonInfoResult): void {
    if (!versionAtLeast(info.version, MIN_ADC_VERSION)) throw new AdcTooOldError(parseAdcVersion(info.version));
  }

  /**
   * The ceremony's effects run on the socket we dialled, so the daemon must say that socket IS its
   * enrollment socket: a control socket answers the same handshake, and the ceremony would then run
   * with ambient operator authority. Asked of the daemon — whatever the config aliases.
   */
  #checkEnrollRole(identity: DaemonIdentity, info: DaemonInfoResult): void {
    const reported = info.enroll_socket_path;
    if (reported && canonicalizePath(reported) !== identity.enrollSocket) {
      throw new DaemonUnsupportedError(strings.status.notEnrollSocket(identity.raw.enrollSocket, reported));
    }
  }

  async attach(params: AttachParams): Promise<Attachment> {
    if (this.#deps.platform === "win32") {
      throw new DaemonUnsupportedError("Ademú is not available on Windows yet (no adc daemon build).");
    }
    return params.role === "runtime" ? await this.#attachRuntime(params) : await this.#attachSetup(params);
  }

  async #attachRuntime(params: AttachParams): Promise<Attachment> {
    const { identity } = params;
    let info: DaemonInfoResult | undefined;
    try {
      info = await this.#probe(identity.raw.enrollSocket, params.signal);
    } catch (err) {
      if (!(err instanceof PrivilegeError)) throw err;
      // The runtime needs only the session socket: a gated enrollment socket is not its problem.
      this.#deps.log("daemon_enroll_privilege_denied", { scope: identity.scope });
    }
    if (info) {
      this.#deps.log("daemon_attached", { scope: identity.scope, reachable: true });
      return this.#attachment(params, info);
    }
    // The service-state lookup (launchctl print-disabled, up to 5 s) must not hold a shutdown.
    const unreachable = await this.#unlessAborted(this.#whyUnreachable(identity), params.signal);
    this.#deps.log("daemon_attached", { scope: identity.scope, reachable: false, unreachable });
    return this.#attachment(params, undefined, unreachable);
  }

  async #whyUnreachable(identity: DaemonIdentity): Promise<Unreachable> {
    if (identity.scope === "system") return "system_down";
    const layout = this.#serviceLayoutFor(identity);
    if (!layout) return "not_running";
    try {
      const state = await this.#deps.userService.installed(layout);
      if (!state.installed) return "not_installed";
      return state.disabled ? "disabled" : "not_running";
    } catch {
      return "not_running";
    }
  }

  async #attachSetup(params: AttachParams): Promise<Attachment> {
    const { identity, signal } = params;
    if (identity.scope === "system") {
      // Attach-only: the probe decides only the session path; a gated enrollment socket still yields
      // the attachment (the ceremony meets the same PrivilegeError on connectEnroll and prints the
      // operator copy). Nothing is ever started for a system install.
      let info: DaemonInfoResult | undefined;
      try {
        info = await this.#probe(identity.raw.enrollSocket, signal);
      } catch (err) {
        if (!(err instanceof PrivilegeError)) throw err;
        this.#deps.log("daemon_enroll_privilege_denied", { scope: "system" });
      }
      if (info) {
        this.#checkVersion(info);
        this.#checkEnrollRole(identity, info);
      }
      this.#deps.log("daemon_attached", { scope: "system", reachable: Boolean(info) });
      return this.#attachment(params, info);
    }

    const first = await this.#probe(identity.raw.enrollSocket, signal); // PrivilegeError propagates
    if (first) {
      this.#checkVersion(first);
      this.#checkEnrollRole(identity, first);
      this.#deps.log("daemon_attached", { scope: "user", reachable: true });
      return this.#attachment(params, first);
    }
    // No enrollment socket. A daemon on the control socket is one from before the enrollment socket
    // (or from before #712 pinned all three sockets under the data dir): never speak to it, never
    // start anything beside it — re-running the installer is the fix.
    if (await this.#deps.controlSocketAnswers(identity.raw.controlSocket)) throw new AdcTooOldError();

    const layout = this.#serviceLayoutFor(identity);
    if (!layout) {
      // An explicit path that is not the installed service's own: the plugin starts nothing for it.
      throw new DaemonUnreachableError(strings.status.adcNotRunningAt(identity.raw.enrollSocket));
    }
    const state = await this.#unlessAborted(this.#deps.userService.installed(layout), signal);
    if (!state.installed) throw new AdcServiceNotInstalledError(layout);
    if (state.disabled) throw new AdcServiceNotAnsweringError(layout, true);

    if (signal?.aborted) throw new DaemonAbortedError();
    await params.beforeEffect?.();
    if (signal?.aborted) throw new DaemonAbortedError();
    // launchd's helper runs several commands with 5 s timeouts each: an abort must not wait for them
    // (a late result is dropped; starting the installed service is the effect asked for anyway).
    const started = await this.#unlessAborted(this.#deps.userService.start(layout), signal);
    this.#deps.log("daemon_service_start", { result: started.kind });
    if (started.kind === "disabled") throw new AdcServiceNotAnsweringError(layout, true);
    if (started.kind === "failed") throw new AdcServiceNotAnsweringError(layout, false, started.reason);

    // Every probe and pause is bounded by what is left of the budget: a daemon that accepts but
    // stalls hello / daemon_info cannot stretch the advertised wait (the late connection is closed).
    const deadline = this.#deps.now() + SERVICE_START_WAIT_MS;
    for (;;) {
      const remaining = deadline - this.#deps.now();
      if (remaining <= 0) throw new AdcServiceNotAnsweringError(layout, false);
      const budget = AbortSignal.timeout(remaining);
      const bounded = signal ? AbortSignal.any([signal, budget]) : budget;
      let info: DaemonInfoResult | undefined;
      try {
        info = await this.#probe(identity.raw.enrollSocket, bounded);
        if (!info) await this.#sleepOrAbort(WAIT_POLL_MS, bounded);
      } catch (err) {
        if (err instanceof DaemonAbortedError && !signal?.aborted) throw new AdcServiceNotAnsweringError(layout, false);
        throw err;
      }
      if (info) {
        this.#checkVersion(info);
        this.#checkEnrollRole(identity, info);
        this.#deps.log("daemon_attached", { scope: "user", reachable: true, started: true });
        return this.#attachment(params, info);
      }
    }
  }

  /** `step`, unless `signal` aborts first (DaemonAbortedError); no listener is left behind. */
  async #unlessAborted<T>(step: Promise<T>, signal?: AbortSignal): Promise<T> {
    if (signal?.aborted) throw new DaemonAbortedError();
    if (!signal) return await step;
    let onAbort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DaemonAbortedError());
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      return await Promise.race([step, aborted]);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  async #sleepOrAbort(ms: number, signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new DaemonAbortedError();
    let onAbort: (() => void) | undefined;
    const aborted = new Promise<never>((_, reject) => {
      onAbort = () => reject(new DaemonAbortedError());
      signal?.addEventListener("abort", onAbort, { once: true });
    });
    try {
      await Promise.race([this.#deps.sleep(ms, signal), aborted]);
    } finally {
      if (onAbort) signal?.removeEventListener("abort", onAbort);
    }
  }

  async resolveSessionSocket(identity: DaemonIdentity, signal?: AbortSignal): Promise<string> {
    try {
      const info = await this.#probe(identity.raw.enrollSocket, signal);
      if (info) return requireSessionSocket(info);
    } catch (err) {
      if (err instanceof DaemonAbortedError) throw err;
    }
    return identity.raw.sessionSocket;
  }
}
