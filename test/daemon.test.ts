// DaemonManager against a fake world: fake processes, fake daemons behind fake control sockets, a
// fake `ensureDaemon` with the real probe-then-spawn shape, a manual clock, and the real in-memory
// store. Every path of the T5 state machine that the plan lists is exercised here.
import type { ChildLike, DaemonInfoResult, EnsureDaemonDeps, EnsureDaemonResult } from "@ademu/adc-control";
import { describe, expect, it } from "vitest";
import type { DaemonIdentity } from "../src/config.js";
import {
  DaemonAbortedError,
  DaemonBusyError,
  DaemonManager,
  DaemonUnreachableError,
  DaemonUnsupportedError,
  boundedProbeConnect,
  daemonEnv,
  parseAdcVersion,
  PROBE_CONNECT_MS,
  RELEASE_CAP_MS,
  STARTING_DEADLINE_MS,
  type ControlLike,
  type DaemonDeps,
} from "../src/monitor/daemon.js";
import { AdemuStore } from "../src/store.js";

const SERVER = { restBaseUrl: "https://api.ademu.com", wsUrl: "wss://gateway.ademu.com/v1/ws" };

function identityFor(dir: string): DaemonIdentity {
  return {
    dataDir: dir,
    controlSocket: `${dir}/adc.sock`,
    sessionSocket: `${dir}/adc-session.sock`,
    raw: { dataDir: dir, controlSocket: `${dir}/adc.sock`, sessionSocket: `${dir}/adc-session.sock` },
    explicit: { dataDir: true, socketPath: false },
  };
}

type FakeDaemon = {
  pid: number;
  info: DaemonInfoResult;
  alive: boolean;
  /** When false the daemon ignores the shutdown op (and SIGTERM). */
  honoursShutdown: boolean;
  honoursSigterm: boolean;
  child?: FakeChild;
};

class FakeChild implements ChildLike {
  pid: number;
  #listeners = new Map<string, Array<(...a: unknown[]) => void>>();
  constructor(pid: number) {
    this.pid = pid;
  }
  unref(): void {}
  on(event: "error" | "exit", listener: (...args: unknown[]) => void): void {
    const arr = this.#listeners.get(event) ?? [];
    arr.push(listener);
    this.#listeners.set(event, arr);
  }
  emitExit(code = 0): void {
    for (const l of this.#listeners.get("exit") ?? []) l(code, null);
  }
}

class World {
  clock = 1_000_000;
  nextPid = 5000;
  processes = new Map<number, { alive: boolean; startedAt: string; command: string }>();
  daemons = new Map<string, FakeDaemon>(); // by control socket path
  spawns: Array<{ cmd: string; argv: string[]; env: NodeJS.ProcessEnv }> = [];
  shutdownRequests: string[] = [];
  kills: Array<{ pid: number; signal: string }> = [];
  dirs = new Map<string, "absent" | "empty" | "nonempty">();
  secured: string[] = [];
  unsafeDirs = new Set<string>();
  store = AdemuStore.open({ path: ":memory:", now: () => this.clock });
  logs: Array<{ event: string; fields?: Record<string, unknown> | undefined }> = [];
  /** When set, the next spawned daemon does not come up (control never answers). */
  spawnFailsToListen = false;
  /** When set, ensureDaemon REJECTS after spawnFn (its wait ladder gave up) while the child stays alive. */
  ensureRejectsAfterSpawn = false;
  /** When set, ensureDaemon resolves only after this promise (late-success containment tests). */
  ensureGate: Promise<void> | undefined;
  /** When set, ensureDaemon's pre-spawn probe waits for this promise BEFORE calling spawnFn (abort-before-spawn tests). */
  preSpawnGate: Promise<void> | undefined;
  /** Every `connectFn` handed to the fake ensureDaemon (R9#2 wiring proof). */
  ensureConnectFns: Array<unknown> = [];
  readonly probeConnect = () => {
    throw new Error("the fake ensureDaemon never dials");
  };
  platform = "darwin";
  bundledVersion = "0.2.4";
  selfPid = 100;

  constructor() {
    this.processes.set(this.selfPid, { alive: true, startedAt: "self-start", command: "node openclaw" });
  }

  addDaemon(dir: string, opts: Partial<FakeDaemon> & { version?: string | undefined; sessionSocket?: string | undefined } = {}): FakeDaemon {
    const pid = this.nextPid++;
    this.processes.set(pid, { alive: true, startedAt: `start-${pid}`, command: "/x/adc daemon run" });
    const d: FakeDaemon = {
      pid,
      alive: true,
      honoursShutdown: opts.honoursShutdown ?? true,
      honoursSigterm: opts.honoursSigterm ?? true,
      info: {
        version: `${opts.version ?? this.bundledVersion} (fake)`,
        key_provider: "file",
        kek_rung: 0,
        data_dir: dir,
        socket_path: `${dir}/adc.sock`,
        config_source: "",
        started_at_ms: this.clock,
        attach_policy: "takeover",
        session_socket_path: opts.sessionSocket ?? `${dir}/adc-session.sock`,
      },
    };
    this.daemons.set(`${dir}/adc.sock`, d);
    this.dirs.set(dir, "nonempty");
    return d;
  }

  killDaemon(d: FakeDaemon): void {
    d.alive = false;
    const p = this.processes.get(d.pid);
    if (p) p.alive = false;
    d.child?.emitExit(0);
  }

  deps(): DaemonDeps {
    return {
      store: this.store,
      now: () => this.clock,
      sleep: async (ms) => {
        this.clock += ms;
      },
      processFacts: (pid) => {
        const p = this.processes.get(pid);
        return p ? { alive: p.alive, startedAt: p.startedAt, command: p.command } : { alive: false };
      },
      selfPid: this.selfPid,
      selfPidStartedAt: "self-start",
      spawn: (cmd, argv, opts) => {
        const env = (opts as { env: NodeJS.ProcessEnv }).env;
        this.spawns.push({ cmd, argv, env });
        const dir = env.ADC_DATA_DIR!;
        const pid = this.nextPid++;
        const child = new FakeChild(pid);
        this.processes.set(pid, { alive: true, startedAt: `start-${pid}`, command: `${cmd} daemon run` });
        if (!this.spawnFailsToListen) {
          const d = this.addDaemon(dir, { sessionSocket: env.ADC_SESSION_SOCKET_PATH });
          // the spawned process IS the daemon
          this.processes.delete(d.pid);
          d.pid = pid;
          d.child = child;
        }
        this.dirs.set(dir, "nonempty");
        return child;
      },
      ensureDaemon: async (deps: EnsureDaemonDeps = {}): Promise<EnsureDaemonResult> => {
        this.ensureConnectFns.push(deps.connectFn);
        const dir = deps.env!.ADC_DATA_DIR!;
        const socket = deps.env!.ADC_SOCKET_PATH!;
        const base = { socketPath: socket, dataDir: dir, logPath: `${dir}/daemon.log` };
        if (this.daemons.get(socket)?.alive) return { spawned: false, ...base };
        if (this.preSpawnGate) await this.preSpawnGate;
        const child = deps.spawnFn!(deps.binaryPath ?? "adc", ["daemon", "run"], { detached: true, stdio: ["ignore", 1, 1] });
        if (this.ensureGate) await this.ensureGate;
        if (this.ensureRejectsAfterSpawn) throw new Error("hello never arrived");
        return { spawned: true, pid: child.pid ?? undefined, ...base };
      },
      connectControl: async (socketPath): Promise<ControlLike> => {
        const d = this.daemons.get(socketPath);
        if (!d?.alive) throw new Error("ECONNREFUSED");
        return {
          daemonInfo: async () => d.info,
          request: async <R>(op: string) => {
            if (op === "shutdown") {
              this.shutdownRequests.push(socketPath);
              if (d.honoursShutdown) this.killDaemon(d);
              return { ok: true } as R;
            }
            throw new Error(`unexpected op ${op}`);
          },
          close: async () => {},
        };
      },
      resolveBinaryPath: () => "/bundled/adc",
      kill: (pid, signal) => {
        this.kills.push({ pid, signal });
        const d = [...this.daemons.values()].find((x) => x.pid === pid);
        if (!d) return;
        if (signal === "SIGKILL" || (signal === "SIGTERM" && d.honoursSigterm)) this.killDaemon(d);
      },
      probeConnect: this.probeConnect,
      isDirAbsentOrEmpty: (dir) => (this.dirs.get(dir) ?? "absent") !== "nonempty",
      secureEmptyDir: (dir) => {
        this.secured.push(dir);
        if (this.unsafeDirs.has(dir)) return "unsafe";
        return (this.dirs.get(dir) ?? "absent") === "absent" ? "absent" : "ok";
      },
      bundledVersion: this.bundledVersion,
      platform: this.platform,
      log: (event, fields) => {
        this.logs.push({ event, fields });
      },
    };
  }
}

const DIR = "/state/ademu/adc";

describe("fresh spawn (runtime) and env injection", () => {
  it("claims before spawning, injects all five env vars, binds with the child pid, and the lease is owned", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("owned");
    expect(w.spawns).toHaveLength(1);
    const env = w.spawns[0]!.env;
    expect(env.ADC_DATA_DIR).toBe(DIR);
    expect(env.ADC_SOCKET_PATH).toBe(`${DIR}/adc.sock`);
    expect(env.ADC_SESSION_SOCKET_PATH).toBe(`${DIR}/adc-session.sock`);
    expect(env.ADC_REST_BASE_URL).toBe(SERVER.restBaseUrl);
    expect(env.ADC_WS_URL).toBe(SERVER.wsUrl);
    const row = w.store.getOwnership(DIR)!;
    expect(row.state).toBe("bound");
    expect(row.generation).toBe(1);
    expect(row.daemonPid).toBe(w.daemons.get(`${DIR}/adc.sock`)!.pid);
    expect(row.adcVersion).toBe("0.2.4");
    expect(lease.info.sessionSocketPath).toBe(`${DIR}/adc-session.sock`);
    expect(w.store.listHolders(DIR)).toHaveLength(1);
  });

  it("daemonEnv is exactly the five variables on top of the base env", () => {
    const env = daemonEnv(identityFor(DIR), SERVER, { PATH: "/bin" });
    expect(Object.keys(env).sort()).toEqual(["ADC_DATA_DIR", "ADC_REST_BASE_URL", "ADC_SESSION_SOCKET_PATH", "ADC_SOCKET_PATH", "ADC_WS_URL", "PATH"]);
  });

  it("refuses Windows before touching any resolver", async () => {
    const w = new World();
    w.platform = "win32";
    const m = new DaemonManager(w.deps());
    await expect(m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" })).rejects.toBeInstanceOf(DaemonUnsupportedError);
    expect(w.spawns).toHaveLength(0);
  });
});

describe("roles: setup never stops; runtime promotes and releases through the fence", () => {
  it("a setup spawn binds as pending-publication; its release leaves the daemon running; a runtime acquire promotes it", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const setup = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "setup" });
    expect(w.store.getOwnership(DIR)!.state).toBe("pending-publication");
    await setup.release();
    expect(w.daemons.get(`${DIR}/adc.sock`)!.alive).toBe(true);
    expect(w.shutdownRequests).toEqual([]);
    const runtime = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(runtime.mode).toBe("owned");
    expect(w.spawns).toHaveLength(1);
    expect(w.store.getOwnership(DIR)!.state).toBe("bound");
    await runtime.release();
    expect(w.shutdownRequests).toHaveLength(1);
    expect(w.store.getOwnership(DIR)!.state).toBe("stopped");
  });

  it("the runtime's last release stops the daemon; with another live holder it only releases its own row", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const a = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    const b = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(w.spawns).toHaveLength(1);
    await a.release();
    expect(w.daemons.get(`${DIR}/adc.sock`)!.alive).toBe(true);
    expect(w.store.listHolders(DIR)).toHaveLength(1);
    await b.release();
    expect(w.daemons.get(`${DIR}/adc.sock`)!.alive).toBe(false);
    expect(w.store.getOwnership(DIR)!.state).toBe("stopped");
    expect(w.store.listHolders(DIR)).toHaveLength(0);
  });

  it("a live setup holder in ANOTHER process blocks the runtime's stop (daemon keeps running)", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const rt = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    w.processes.set(777, { alive: true, startedAt: "cli", command: "node openclaw channels add" });
    w.store.addHolder({ holderId: "setup:777:x", dataDir: DIR, role: "setup", pid: 777, pidStartedAt: "cli", heartbeatMs: w.clock });
    await rt.release();
    expect(w.daemons.get(`${DIR}/adc.sock`)!.alive).toBe(true);
    expect(w.store.getOwnership(DIR)!.state).toBe("bound");
    expect(w.logs.some((l) => l.event === "daemon_stop_deferred")).toBe(true);
  });

  it("a stopped daemon is re-acquirable (stopped → starting → bound, new generation)", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const a = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    await a.release();
    const b = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(b.mode).toBe("owned");
    expect(w.spawns).toHaveLength(2);
    expect(w.store.getOwnership(DIR)!).toMatchObject({ state: "bound", generation: 3 });
  });
});

describe("foreign mode", () => {
  it("an existing listener with no ownership row is attached, never spawned or stopped", async () => {
    const w = new World();
    const prod = "/Users/me/.local/share/adc";
    w.addDaemon(prod, { version: "0.2.3" });
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(prod), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("foreign");
    expect(lease.info.daemonVersion).toBe("0.2.3");
    expect(w.spawns).toHaveLength(0);
    await lease.release();
    expect(w.shutdownRequests).toEqual([]);
    expect(w.daemons.get(`${prod}/adc.sock`)!.alive).toBe(true);
    expect(w.store.getOwnership(prod)).toBeUndefined();
  });

  it("a non-empty dir with no listener and no row is foreign (attach-only), not a spawn", async () => {
    const w = new World();
    const dir = "/opt/someone/adc";
    w.dirs.set(dir, "nonempty");
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(dir), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("foreign");
    expect(w.spawns).toHaveLength(0);
  });

  it("a listener that wins the probe-then-spawn race is not ours: the starting row is deleted", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    // make ensureDaemon see a live listener at spawn time
    const d = w.addDaemon(DIR, { version: "0.9.9" });
    d.info.data_dir = "/elsewhere"; // not our identity
    w.dirs.set(DIR, "absent");
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("foreign");
    expect(w.spawns).toHaveLength(0);
    expect(w.store.getOwnership(DIR)).toBeUndefined();
  });
});

describe("abort, orphans and recovery", () => {
  it("abort before spawn: no spawn, no row", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const ac = new AbortController();
    ac.abort();
    await expect(m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime", signal: ac.signal })).rejects.toBeInstanceOf(DaemonAbortedError);
    expect(w.spawns).toHaveLength(0);
    expect(w.store.getOwnership(DIR)).toBeUndefined();
    expect(w.store.listHolders(DIR)).toHaveLength(0);
  });

  it("late success after abort (setup): the child is bound as pending-publication and left running", async () => {
    const w = new World();
    let release!: () => void;
    w.ensureGate = new Promise<void>((r) => (release = r));
    const m = new DaemonManager(w.deps());
    const ac = new AbortController();
    const p = m.acquire({ identity: identityFor(DIR), server: SERVER, role: "setup", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(DaemonAbortedError);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(w.store.getOwnership(DIR)!.state).toBe("pending-publication");
    expect(w.daemons.get(`${DIR}/adc.sock`)!.alive).toBe(true);
  });

  it("late success after abort (runtime): bound, then released through the fence (stopped)", async () => {
    const w = new World();
    let release!: () => void;
    w.ensureGate = new Promise<void>((r) => (release = r));
    const m = new DaemonManager(w.deps());
    const ac = new AbortController();
    const p = m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(p).rejects.toBeInstanceOf(DaemonAbortedError);
    release();
    await new Promise((r) => setTimeout(r, 10));
    expect(w.store.getOwnership(DIR)!.state).toBe("stopped");
    expect(w.daemons.get(`${DIR}/adc.sock`)!.alive).toBe(false);
  });

  it("an orphaned `starting` row (dead starter) is reclaimed by generation CAS and the daemon spawned", async () => {
    const w = new World();
    w.store.claim({ dataDir: DIR, controlSocket: `${DIR}/adc.sock`, sessionSocket: `${DIR}/adc-session.sock`, ownerPid: 999, ownerPidStartedAt: "gone" });
    w.store.cas({ dataDir: DIR, from: ["claimed"], to: "starting", bumpGeneration: true, set: { ownerPid: 999, ownerPidStartedAt: "gone", deadlineMs: w.clock + STARTING_DEADLINE_MS } });
    w.dirs.set(DIR, "empty");
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("owned");
    expect(w.spawns).toHaveLength(1);
    expect(w.store.getOwnership(DIR)!).toMatchObject({ state: "bound", generation: 2 });
  });

  it("a live `starting` owner is waited for, then the bound daemon is adopted without a second spawn", async () => {
    const w = new World();
    w.processes.set(555, { alive: true, startedAt: "s", command: "node openclaw" });
    w.store.claim({ dataDir: DIR, controlSocket: `${DIR}/adc.sock`, sessionSocket: `${DIR}/adc-session.sock`, ownerPid: 555, ownerPidStartedAt: "s" });
    w.store.cas({ dataDir: DIR, from: ["claimed"], to: "starting", bumpGeneration: true, set: { ownerPid: 555, ownerPidStartedAt: "s", deadlineMs: w.clock + STARTING_DEADLINE_MS } });
    const m = new DaemonManager(w.deps());
    const p = m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    // the other process finishes: daemon comes up and the row is bound
    const d = w.addDaemon(DIR);
    w.store.cas({ dataDir: DIR, from: ["starting"], to: "bound", expectedGeneration: 1, set: { daemonPid: d.pid, daemonPidStartedAt: `start-${d.pid}`, daemonStartedAtMs: d.info.started_at_ms, daemonDataDir: DIR, daemonSocketPath: d.info.socket_path, daemonSessionSocketPath: d.info.session_socket_path ?? null } });
    const lease = await p;
    expect(lease.mode).toBe("owned");
    expect(w.spawns).toHaveLength(0);
  });

  it("an orphaned `stopping` row (dead stopper, expired) is recovered: dead daemon → stopped → respawn", async () => {
    const w = new World();
    w.store.claim({ dataDir: DIR, controlSocket: `${DIR}/adc.sock`, sessionSocket: `${DIR}/adc-session.sock`, ownerPid: 1, ownerPidStartedAt: "x" });
    w.store.cas({ dataDir: DIR, from: ["claimed"], to: "starting", bumpGeneration: true });
    w.store.cas({ dataDir: DIR, from: ["starting"], to: "bound", expectedGeneration: 1 });
    w.store.cas({ dataDir: DIR, from: ["bound"], to: "stopping", expectedGeneration: 1, bumpGeneration: true, set: { ownerPid: 999, ownerPidStartedAt: "gone", deadlineMs: w.clock - 1 } });
    w.dirs.set(DIR, "nonempty");
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("owned");
    expect(w.spawns).toHaveLength(1);
    expect(w.logs.some((l) => l.event === "daemon_stopping_recovered")).toBe(true);
  });

  it("`lost` rejects when the owned child exits", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    const d = w.daemons.get(`${DIR}/adc.sock`)!;
    const lost = lease.lost.catch((e: Error) => e);
    w.killDaemon(d);
    const err = await lost;
    expect((err as Error).name).toBe("DaemonLostError");
  });
});

describe("stop escalation and upgrade", () => {
  it("shutdown op ignored → SIGTERM ignored → SIGKILL → stopped", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    const d = w.daemons.get(`${DIR}/adc.sock`)!;
    d.honoursShutdown = false;
    d.honoursSigterm = false;
    const t0 = w.clock;
    await lease.release();
    expect(w.shutdownRequests).toHaveLength(1);
    expect(w.kills.map((k) => k.signal)).toEqual(["SIGTERM", "SIGKILL"]);
    expect(w.store.getOwnership(DIR)!.state).toBe("stopped");
    expect(w.clock - t0).toBeLessThanOrEqual(RELEASE_CAP_MS + 200);
  });

  it("an unkillable daemon ends `stale` within the cap", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    const d = w.daemons.get(`${DIR}/adc.sock`)!;
    d.honoursShutdown = false;
    d.honoursSigterm = false;
    w.deps; // (kill for SIGKILL still kills in the fake) → simulate an immortal daemon:
    const deps = w.deps();
    const m2 = new DaemonManager({ ...deps, kill: (pid, signal) => w.kills.push({ pid, signal }) });
    const lease2 = await m2.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    await lease.release(); // other holder present → deferred
    const t0 = w.clock;
    await lease2.release();
    expect(w.store.getOwnership(DIR)!.state).toBe("stale");
    expect(w.clock - t0).toBeLessThanOrEqual(RELEASE_CAP_MS + 200);
  });

  it("runtime upgrades a bound daemon whose version differs from the bundled one (through the fence)", async () => {
    const w = new World();
    w.bundledVersion = "0.2.5";
    const old = w.addDaemon(DIR, { version: "0.2.4" });
    w.store.claim({ dataDir: DIR, controlSocket: `${DIR}/adc.sock`, sessionSocket: `${DIR}/adc-session.sock`, ownerPid: 1, ownerPidStartedAt: "x" });
    w.store.cas({ dataDir: DIR, from: ["claimed"], to: "starting", bumpGeneration: true });
    w.store.cas({ dataDir: DIR, from: ["starting"], to: "bound", expectedGeneration: 1, set: { daemonPid: old.pid, daemonPidStartedAt: `start-${old.pid}`, daemonStartedAtMs: old.info.started_at_ms, adcVersion: "0.2.4" } });
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("owned");
    expect(w.shutdownRequests).toHaveLength(1);
    expect(w.spawns).toHaveLength(1);
    expect(w.store.getOwnership(DIR)!).toMatchObject({ state: "bound", generation: 3 }); // bound → stopping → stopped → starting → bound
    expect(w.logs.some((l) => l.event === "daemon_upgrading")).toBe(true);
  });

  it("the upgrade is deferred while another holder is live", async () => {
    const w = new World();
    w.bundledVersion = "0.2.5";
    const old = w.addDaemon(DIR, { version: "0.2.4" });
    w.store.claim({ dataDir: DIR, controlSocket: `${DIR}/adc.sock`, sessionSocket: `${DIR}/adc-session.sock`, ownerPid: 1, ownerPidStartedAt: "x" });
    w.store.cas({ dataDir: DIR, from: ["claimed"], to: "starting", bumpGeneration: true });
    w.store.cas({ dataDir: DIR, from: ["starting"], to: "bound", expectedGeneration: 1, set: { daemonPid: old.pid, daemonPidStartedAt: `start-${old.pid}`, daemonStartedAtMs: old.info.started_at_ms } });
    w.processes.set(777, { alive: true, startedAt: "cli", command: "node openclaw" });
    w.store.addHolder({ holderId: "setup:777:y", dataDir: DIR, role: "setup", pid: 777, pidStartedAt: "cli", heartbeatMs: w.clock });
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.info.daemonVersion).toBe("0.2.4");
    expect(w.spawns).toHaveLength(0);
    expect(w.logs.some((l) => l.event === "daemon_upgrade_deferred")).toBe(true);
  });

  it("parses build-suffixed versions and refuses to upgrade on garbage", () => {
    expect(parseAdcVersion("0.2.4 (abc123)")).toBe("0.2.4");
    expect(parseAdcVersion("v0.2.4")).toBe("0.2.4");
    expect(parseAdcVersion("")).toBeUndefined();
    expect(parseAdcVersion("source")).toBeUndefined();
  });
});

describe("pending-publication sweep", () => {
  it("sweeps an unreferenced pending daemon older than an hour through the fence, keeps a referenced one", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const setup = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "setup" });
    await setup.release();
    const other = "/state/ademu/adc-two";
    const setup2 = await m.acquire({ identity: identityFor(other), server: SERVER, role: "setup" });
    await setup2.release();
    w.clock += 3_600_001;
    const swept = await m.sweepPendingPublications((dir) => dir === other);
    expect(swept).toEqual([DIR]);
    expect(w.store.getOwnership(DIR)!.state).toBe("stopped");
    expect(w.store.getOwnership(other)!.state).toBe("pending-publication");
  });

  it("promotePendingPublication publishes a pending row (tool door) and is a no-op otherwise", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const setup = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "setup" });
    await setup.release();
    expect(w.store.getOwnership(DIR)!.state).toBe("pending-publication");
    expect(m.promotePendingPublication(DIR)).toBe(true);
    expect(w.store.getOwnership(DIR)!.state).toBe("bound");
    expect(m.promotePendingPublication(DIR)).toBe(false);
    expect(m.promotePendingPublication("/nowhere")).toBe(false);
  });
});

function withoutSessionSocket(info: DaemonInfoResult): DaemonInfoResult {
  const { session_socket_path: _omitted, ...rest } = info;
  return rest;
}

describe("Codex branch-review folds (daemon)", () => {
  function bindLive(w: World, d: FakeDaemon, over: Partial<{ daemonStartedAtMs: number | null; daemonPidStartedAt: string | null }> = {}) {
    w.store.claim({ dataDir: DIR, controlSocket: `${DIR}/adc.sock`, sessionSocket: `${DIR}/adc-session.sock`, ownerPid: 1, ownerPidStartedAt: "x" });
    w.store.cas({ dataDir: DIR, from: ["claimed"], to: "starting", bumpGeneration: true });
    w.store.cas({
      dataDir: DIR,
      from: ["starting"],
      to: "bound",
      expectedGeneration: 1,
      set: {
        daemonPid: d.pid,
        daemonPidStartedAt: "daemonPidStartedAt" in over ? over.daemonPidStartedAt! : `start-${d.pid}`,
        daemonStartedAtMs: "daemonStartedAtMs" in over ? over.daemonStartedAtMs! : d.info.started_at_ms,
      },
    });
  }

  it("#11 an existing empty dir is secured before the claim; an unsafe one (symlink / other owner) blocks, no spawn", async () => {
    const ok = new World();
    ok.dirs.set(DIR, "empty");
    const m = new DaemonManager(ok.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("owned");
    expect(ok.secured).toEqual([DIR]);

    const bad = new World();
    bad.dirs.set(DIR, "empty");
    bad.unsafeDirs.add(DIR);
    const m2 = new DaemonManager(bad.deps());
    await expect(m2.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" })).rejects.toBeInstanceOf(DaemonUnsupportedError);
    expect(bad.spawns).toHaveLength(0);
    expect(bad.store.getOwnership(DIR)).toBeUndefined();
  });

  it("#6 a bound row whose instance facts do not match the live daemon (different start time) reattaches as FOREIGN and is never stopped", async () => {
    const w = new World();
    const d = w.addDaemon(DIR);
    bindLive(w, d, { daemonStartedAtMs: d.info.started_at_ms - 1 });
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("foreign");
    expect(w.logs.some((l) => l.event === "daemon_unverified_foreign")).toBe(true);
    await lease.release();
    expect(w.shutdownRequests).toHaveLength(0);
    expect(w.kills).toHaveLength(0);
    expect(d.alive).toBe(true);
  });

  it("#6 missing pid facts fail closed: a bound row without a pid start time is foreign", async () => {
    const w = new World();
    const d = w.addDaemon(DIR);
    bindLive(w, d, { daemonPidStartedAt: null });
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("foreign");
  });

  it("#7 a listener replaced between the fence and the shutdown connect is NOT shut down; the row goes stale", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    const ours = w.daemons.get(`${DIR}/adc.sock`)!;
    // Someone else's daemon takes over our socket path (different start time / pid).
    w.clock += 10;
    const impostor = w.addDaemon(DIR);
    expect(impostor.pid).not.toBe(ours.pid);
    await lease.release();
    expect(w.shutdownRequests).toHaveLength(0);
    expect(w.kills).toHaveLength(0);
    expect(impostor.alive).toBe(true);
    expect(w.store.getOwnership(DIR)!.state).toBe("stale");
    expect(w.logs.some((l) => l.event === "daemon_shutdown_withheld")).toBe(true);
  });

  it("R2#1 a reachable daemon that reports no session socket is refused (never a derived path) — owned spawn and foreign attach", async () => {
    const owned = new World();
    const m = new DaemonManager(owned.deps());
    // the spawned daemon comes up without a session socket path
    const origAdd = owned.addDaemon.bind(owned);
    owned.addDaemon = (dir, opts = {}) => {
      const d = origAdd(dir, opts);
      d.info = withoutSessionSocket(d.info);
      return d;
    };
    await expect(m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" })).rejects.toBeInstanceOf(DaemonUnsupportedError);

    const foreign = new World();
    const d = foreign.addDaemon(DIR);
    d.info = withoutSessionSocket(d.info);
    const m2 = new DaemonManager(foreign.deps());
    await expect(m2.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" })).rejects.toBeInstanceOf(DaemonUnsupportedError);

    // unreachable foreign (no daemon answers, dir non-empty): the configured path stays (connect fails later)
    const dark = new World();
    dark.dirs.set(DIR, "nonempty");
    const m3 = new DaemonManager(dark.deps());
    const lease = await m3.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("foreign");
    expect(lease.info.sessionSocketPath).toBe(`${DIR}/adc-session.sock`);
  });

  it("R2#2 a listener answering after an orphaned `starting` row is FOREIGN (never bound to the recorded pid), so it is never stopped", async () => {
    const w = new World();
    // crashed starter recorded child pid facts; a (possibly different) daemon now listens
    const listener = w.addDaemon(DIR);
    w.store.claim({ dataDir: DIR, controlSocket: `${DIR}/adc.sock`, sessionSocket: `${DIR}/adc-session.sock`, ownerPid: 999, ownerPidStartedAt: "gone" });
    w.store.cas({ dataDir: DIR, from: ["claimed"], to: "starting", bumpGeneration: true, set: { ownerPid: 999, ownerPidStartedAt: "gone", deadlineMs: w.clock - 1, daemonPid: listener.pid, daemonPidStartedAt: `start-${listener.pid}` } });
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("foreign");
    expect(w.store.getOwnership(DIR)).toBeUndefined();
    await lease.release();
    expect(w.shutdownRequests).toHaveLength(0);
    expect(w.kills).toHaveLength(0);
    expect(listener.alive).toBe(true);
  });

  it("R2#3 a pid reused after the daemon exited during the shutdown wait is never signalled", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    const d = w.daemons.get(`${DIR}/adc.sock`)!;
    d.honoursShutdown = false;
    d.honoursSigterm = false;
    // The daemon ignores shutdown; meanwhile the pid is reused by an unrelated process.
    const proc = w.processes.get(d.pid)!;
    const deps = w.deps();
    const m2 = new DaemonManager({
      ...deps,
      kill: (pid, signal) => w.kills.push({ pid, signal }),
      connectControl: async (socketPath) => {
        const c = await deps.connectControl(socketPath);
        return {
          ...c,
          request: async <R>(op: string, params?: object, options?: { timeoutMs?: number }) => {
            const r = await c.request<R>(op, params, options);
            // right after the shutdown op is accepted, the pid is reused
            proc.startedAt = "reused-much-later";
            proc.command = "python3 unrelated.py";
            return r;
          },
        };
      },
    });
    const lease2 = await m2.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    await lease.release(); // deferred: another holder
    await lease2.release();
    expect(w.kills).toEqual([]);
    expect(["stale", "stopped"]).toContain(w.store.getOwnership(DIR)!.state);
  });

  it("R3#6 pid facts or the generation changing AFTER SIGTERM withhold SIGKILL", async () => {
    // (a) pid reused between SIGTERM and SIGKILL
    const a = new World();
    const ma = new DaemonManager(a.deps());
    const la = await ma.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    const da = a.daemons.get(`${DIR}/adc.sock`)!;
    da.honoursShutdown = false;
    da.honoursSigterm = false;
    const procA = a.processes.get(da.pid)!;
    const depsA = a.deps();
    const ma2 = new DaemonManager({
      ...depsA,
      kill: (pid, signal) => {
        a.kills.push({ pid, signal });
        if (signal === "SIGTERM") {
          procA.startedAt = "reused";
          procA.command = "sleep 1000";
        }
      },
    });
    const la2 = await ma2.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    await la.release();
    await la2.release();
    expect(a.kills.map((k) => k.signal)).toEqual(["SIGTERM"]);

    // (b) the stopping generation moves between SIGTERM and SIGKILL
    const b = new World();
    const mb = new DaemonManager(b.deps());
    const lb = await mb.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    const db = b.daemons.get(`${DIR}/adc.sock`)!;
    db.honoursShutdown = false;
    db.honoursSigterm = false;
    const depsB = b.deps();
    const mb2 = new DaemonManager({
      ...depsB,
      kill: (pid, signal) => {
        b.kills.push({ pid, signal });
        if (signal === "SIGTERM") b.store.cas({ dataDir: DIR, from: ["stopping"], to: "stopping", bumpGeneration: true });
      },
    });
    const lb2 = await mb2.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    await lb.release();
    await lb2.release();
    expect(b.kills.map((k) => k.signal)).toEqual(["SIGTERM"]);
  });

  it("R3#4 a claimed upgrade whose stop fails leaves `stale` and yields a FOREIGN lease (never 'owned' over an unproven instance)", async () => {
    const w = new World();
    w.bundledVersion = "0.2.5";
    const old = w.addDaemon(DIR, { version: "0.2.4", honoursShutdown: false, honoursSigterm: false });
    bindLive(w, old);
    const deps = w.deps();
    const m = new DaemonManager({ ...deps, kill: (pid, signal) => w.kills.push({ pid, signal }) });
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("foreign");
    expect(w.store.getOwnership(DIR)!.state).toBe("stale");
    expect(w.spawns).toHaveLength(0);
    expect(w.logs.some((l) => l.event === "daemon_upgrade_failed")).toBe(true);
  });

  it("R4#4 a claimed upgrade whose stop fails AND whose listener then vanishes → DaemonUnreachableError, holder removed, no owned lease", async () => {
    const w = new World();
    w.bundledVersion = "0.2.5";
    const old = w.addDaemon(DIR, { version: "0.2.4", honoursShutdown: false, honoursSigterm: false });
    bindLive(w, old);
    const deps = w.deps();
    let controlCalls = 0;
    const m = new DaemonManager({
      ...deps,
      kill: (pid, signal) => w.kills.push({ pid, signal }),
      connectControl: async (socketPath) => {
        controlCalls++;
        // 1 = the acquire probe, 2 = the shutdown attempt; afterwards the listener is gone
        if (controlCalls > 2) throw new Error("ECONNREFUSED");
        return deps.connectControl(socketPath);
      },
    });
    await expect(m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" })).rejects.toBeInstanceOf(DaemonUnreachableError);
    expect(w.store.getOwnership(DIR)!.state).toBe("stale");
    expect(w.store.listHolders(DIR)).toHaveLength(0);
    expect(m.activeLeases).toBe(0);
  });

  it("R7#1 an abort during a stalled daemon_info probe rejects at once (DaemonAbortedError), removes the holder, spawns nothing", async () => {
    const w = new World();
    w.addDaemon(DIR);
    const deps = w.deps();
    let closes = 0;
    const m = new DaemonManager({
      ...deps,
      connectControl: async (socketPath) => {
        const c = await deps.connectControl(socketPath);
        return { ...c, daemonInfo: () => new Promise(() => {}), close: async () => void closes++ };
      },
    });
    const ac = new AbortController();
    const acquiring = m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(acquiring).rejects.toBeInstanceOf(DaemonAbortedError);
    expect(w.store.listHolders(DIR)).toHaveLength(0);
    expect(w.spawns).toHaveLength(0);
    expect(closes).toBe(1); // the stalled connection is closed
  });

  it("R8#1 an abort during the orphaned-`stopping` recovery probe rejects at once", async () => {
    const w = new World();
    w.addDaemon(DIR);
    w.store.claim({ dataDir: DIR, controlSocket: `${DIR}/adc.sock`, sessionSocket: `${DIR}/adc-session.sock`, ownerPid: 1, ownerPidStartedAt: "x" });
    w.store.cas({ dataDir: DIR, from: ["claimed"], to: "stopping", bumpGeneration: true, set: { ownerPid: 999, ownerPidStartedAt: "gone", deadlineMs: w.clock - 1 } });
    const deps = w.deps();
    const m = new DaemonManager({
      ...deps,
      connectControl: async (socketPath) => {
        const c = await deps.connectControl(socketPath);
        return { ...c, daemonInfo: () => new Promise(() => {}) };
      },
    });
    const ac = new AbortController();
    const acquiring = m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(acquiring).rejects.toBeInstanceOf(DaemonAbortedError);
    expect(w.store.listHolders(DIR)).toHaveLength(0);
    expect(w.spawns).toHaveLength(0);
  });

  it("R8#2 a control connection that resolves only AFTER the probe was aborted is closed exactly once", async () => {
    const w = new World();
    w.addDaemon(DIR);
    const deps = w.deps();
    let releaseConnect!: () => void;
    const gate = new Promise<void>((r) => {
      releaseConnect = r;
    });
    let closes = 0;
    const m = new DaemonManager({
      ...deps,
      connectControl: async (socketPath) => {
        await gate;
        const c = await deps.connectControl(socketPath);
        return { ...c, close: async () => void closes++ };
      },
    });
    const ac = new AbortController();
    const acquiring = m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(acquiring).rejects.toBeInstanceOf(DaemonAbortedError);
    expect(closes).toBe(0);
    releaseConnect();
    await new Promise((r) => setTimeout(r, 5));
    expect(closes).toBe(1);
  });

  it("R8#3 abort BEFORE ensureDaemon reached spawnFn drops the exact `starting` row; the next acquire proceeds at once", async () => {
    const w = new World();
    let releaseProbe!: () => void;
    w.preSpawnGate = new Promise<void>((r) => {
      releaseProbe = r;
    });
    const m = new DaemonManager(w.deps());
    const ac = new AbortController();
    const acquiring = m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(acquiring).rejects.toBeInstanceOf(DaemonAbortedError);
    releaseProbe(); // ensureDaemon now calls spawnFn, which throws DaemonAbortedError → ensure rejects
    await new Promise((r) => setTimeout(r, 5));
    expect(w.spawns).toHaveLength(0);
    expect(w.store.getOwnership(DIR)).toBeUndefined(); // no lingering `starting` row
    w.preSpawnGate = undefined;
    const t0 = w.clock;
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("owned");
    expect(w.clock - t0).toBeLessThan(1000); // no "still starting" wait
  });

  it("R9#1 a rejected authority re-check right before the spawn drops the exact `starting` row; reacquire is immediate", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    await expect(
      m.acquire({
        identity: identityFor(DIR),
        server: SERVER,
        role: "setup",
        beforeEffect: async () => {
          throw new Error("authority expired");
        },
      }),
    ).rejects.toThrow(/authority expired/);
    expect(w.spawns).toHaveLength(0);
    expect(w.store.getOwnership(DIR)).toBeUndefined();
    expect(w.store.listHolders(DIR)).toHaveLength(0);
    const t0 = w.clock;
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("owned");
    expect(w.clock - t0).toBeLessThan(1000);
  });

  it("R9#2 boundedProbeConnect destroys a connect that neither connects nor errors within PROBE_CONNECT_MS", async () => {
    const events = new Map<string, () => void>();
    let destroyed: Error | undefined;
    const fake = {
      once: (ev: string, cb: () => void) => void events.set(ev, cb),
      destroy: (err?: Error) => {
        destroyed = err;
      },
    } as unknown as import("node:stream").Duplex & { destroy: (err?: Error) => unknown };
    const vi = await import("vitest");
    vi.vi.useFakeTimers();
    try {
      boundedProbeConnect("/nowhere.sock", () => fake);
      vi.vi.advanceTimersByTime(PROBE_CONNECT_MS + 1);
      expect(destroyed?.message).toMatch(/timed out/);
      // a connect that arrives in time clears the timer: no destroy
      destroyed = undefined;
      boundedProbeConnect("/nowhere.sock", () => fake);
      events.get("connect")!();
      vi.vi.advanceTimersByTime(PROBE_CONNECT_MS + 1);
      expect(destroyed).toBeUndefined();
    } finally {
      vi.vi.useRealTimers();
    }
    expect(PROBE_CONNECT_MS).toBeLessThanOrEqual(1000);
  });

  it("R10#1 a rejected authority check on a RESPAWN keeps ownership (stopped), never deletes it; reacquire is owned", async () => {
    for (const from of ["stopped", "bound"] as const) {
      const w = new World();
      const d = w.addDaemon(DIR);
      bindLive(w, d);
      if (from === "stopped") w.store.cas({ dataDir: DIR, from: ["bound"], to: "stopped", expectedGeneration: 1 });
      w.killDaemon(d); // nothing listens; a respawn is due
      const m = new DaemonManager(w.deps());
      await expect(
        m.acquire({
          identity: identityFor(DIR),
          server: SERVER,
          role: "runtime",
          beforeEffect: async () => {
            throw new Error("authority expired");
          },
        }),
      ).rejects.toThrow(/authority expired/);
      expect(w.store.getOwnership(DIR)!.state).toBe("stopped"); // preserved, not deleted
      const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
      expect(lease.mode).toBe("owned");
      expect(w.spawns).toHaveLength(1);
    }
  });

  it("R10#2 a starter whose `starting` generation expired and was reclaimed during its slow authority check does NOT spawn", async () => {
    const w = new World();
    let releaseAuthority!: () => void;
    const gate = new Promise<void>((r) => {
      releaseAuthority = r;
    });
    const slow = new DaemonManager(w.deps());
    const first = slow.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime", beforeEffect: () => gate });
    first.catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(w.store.getOwnership(DIR)!.state).toBe("starting");
    // the starter's deadline passes; another process (dead-looking starter) reclaims and spawns
    w.clock += STARTING_DEADLINE_MS + 1;
    const other = new World();
    void other;
    const reclaimer = new DaemonManager({ ...w.deps(), selfPid: 200, selfPidStartedAt: "other-start", processFacts: (pid) => (pid === 100 ? { alive: false } : (w.deps().processFacts(pid))) });
    const second = await reclaimer.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(second.mode).toBe("owned");
    expect(w.spawns).toHaveLength(1);
    releaseAuthority();
    await expect(first).rejects.toBeInstanceOf(DaemonBusyError);
    expect(w.spawns).toHaveLength(1); // the superseded starter never spawned
    expect(w.store.getOwnership(DIR)!.state).toBe("bound");
  });

  it("R9#2 (wiring) ensureDaemon receives the bounded probe connectFn", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(w.ensureConnectFns).toEqual([w.probeConnect]);
  });

  it("R10#6 a control connection resolving after the shutdown connect timed out is closed once", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    const d = w.daemons.get(`${DIR}/adc.sock`)!;
    let releaseConnect!: () => void;
    const gate = new Promise<void>((r) => {
      releaseConnect = r;
    });
    let closes = 0;
    let gateActive = false;
    const deps = w.deps();
    const m2 = new DaemonManager({
      ...deps,
      connectControl: async (socketPath) => {
        if (gateActive) await gate;
        const c = await deps.connectControl(socketPath);
        return { ...c, close: async () => void closes++ };
      },
      kill: (pid, signal) => {
        w.kills.push({ pid, signal });
        if (signal === "SIGTERM") w.killDaemon(d);
      },
    });
    const lease2 = await m2.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    await lease.release();
    gateActive = true;
    const releasing = lease2.release(); // the shutdown connect hangs → real-clock timeout → signals
    await releasing;
    expect(w.store.getOwnership(DIR)!.state).toBe("stopped");
    releaseConnect();
    await new Promise((r) => setTimeout(r, 5));
    expect(closes).toBe(1);
  }, 10_000);

  it("R11#1 post-spawn probe failures abandon the generation (stale, pid facts kept) on fresh AND existing origins", async () => {
    // (a) fresh: the spawned child never answers → stale with the child's pid, not deleted
    const a = new World();
    a.spawnFailsToListen = true;
    const ma = new DaemonManager(a.deps());
    await expect(ma.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" })).rejects.toBeInstanceOf(DaemonUnreachableError);
    const rowA = a.store.getOwnership(DIR)!;
    expect(rowA.state).toBe("stale");
    expect(rowA.daemonPid).not.toBeNull();
    // (b) existing: a respawn whose probe is aborted → stale, ownership preserved
    const b = new World();
    const d = b.addDaemon(DIR);
    bindLive(b, d);
    b.killDaemon(d);
    b.spawnFailsToListen = true;
    const mb = new DaemonManager(b.deps());
    await expect(mb.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" })).rejects.toBeInstanceOf(DaemonUnreachableError);
    expect(b.store.getOwnership(DIR)!.state).toBe("stale");
    // (c) late abort: the spawned child never answers after an aborted start → stale, not lingering `starting`
    const c = new World();
    let releaseEnsure!: () => void;
    c.ensureGate = new Promise<void>((r) => (releaseEnsure = r));
    c.spawnFailsToListen = true;
    const mc = new DaemonManager(c.deps());
    const ac = new AbortController();
    const acquiring = mc.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(acquiring).rejects.toBeInstanceOf(DaemonAbortedError);
    releaseEnsure();
    await new Promise((r) => setTimeout(r, 10));
    expect(c.store.getOwnership(DIR)!.state).toBe("stale");
  });

  it("R12#1 abort, then ensureDaemon REJECTS after it had spawned a child → stale with the child's pid facts; no second spawn while it lives", async () => {
    const w = new World();
    let releaseEnsure!: () => void;
    w.ensureGate = new Promise<void>((r) => (releaseEnsure = r));
    w.ensureRejectsAfterSpawn = true;
    w.spawnFailsToListen = true;
    const m = new DaemonManager(w.deps());
    const ac = new AbortController();
    const acquiring = m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime", signal: ac.signal });
    await new Promise((r) => setTimeout(r, 5));
    ac.abort();
    await expect(acquiring).rejects.toBeInstanceOf(DaemonAbortedError);
    releaseEnsure(); // the ladder gives up → ensureDaemon rejects, child alive
    await new Promise((r) => setTimeout(r, 10));
    const row = w.store.getOwnership(DIR)!;
    expect(row.state).toBe("stale");
    expect(row.daemonPid).not.toBeNull();
    expect(row.daemonPidStartedAt).not.toBeNull();
    w.ensureRejectsAfterSpawn = false;
    w.spawnFailsToListen = false;
    await expect(m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" })).rejects.toBeInstanceOf(DaemonUnreachableError);
    expect(w.spawns).toHaveLength(1);
  });

  it("R11#2 a spawned child that never listened stays recorded; while it is alive no second daemon is started; once it exits the respawn proceeds", async () => {
    const w = new World();
    w.ensureRejectsAfterSpawn = true;
    w.spawnFailsToListen = true;
    const m = new DaemonManager(w.deps());
    await expect(m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" })).rejects.toBeInstanceOf(DaemonUnreachableError);
    const row = w.store.getOwnership(DIR)!;
    expect(row.state).toBe("stale");
    expect(row.daemonPid).not.toBeNull();
    expect(w.spawns).toHaveLength(1);
    // the child is alive (never listened): a retry must NOT spawn beside it
    w.ensureRejectsAfterSpawn = false;
    w.spawnFailsToListen = false;
    await expect(m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" })).rejects.toBeInstanceOf(DaemonUnreachableError);
    expect(w.spawns).toHaveLength(1);
    expect(w.logs.some((l) => l.event === "daemon_child_alive_not_listening")).toBe(true);
    // the child exits → the next acquire respawns
    w.processes.get(row.daemonPid!)!.alive = false;
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease.mode).toBe("owned");
    expect(w.spawns).toHaveLength(2);
  });

  it("R11#3 the SYNCHRONOUS generation guard inside spawnFn: a starter whose generation was reclaimed while ensureDaemon was probing never spawns", async () => {
    const w = new World();
    let releaseProbe!: () => void;
    w.preSpawnGate = new Promise<void>((r) => (releaseProbe = r));
    const first = new DaemonManager(w.deps());
    const p1 = first.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    p1.catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    expect(w.store.getOwnership(DIR)!.state).toBe("starting");
    // the refreshed deadline passes while ensureDaemon is inside its pre-spawn probe; another process reclaims
    w.clock += STARTING_DEADLINE_MS + 1;
    w.preSpawnGate = undefined;
    const second = new DaemonManager({ ...w.deps(), selfPid: 200, selfPidStartedAt: "other-start", processFacts: (pid) => (pid === 100 ? { alive: false } : w.deps().processFacts(pid)) });
    const lease2 = await second.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lease2.mode).toBe("owned");
    expect(w.spawns).toHaveLength(1);
    releaseProbe(); // the stale starter reaches spawnFn now → exact-generation guard throws
    await expect(p1).rejects.toBeInstanceOf(DaemonUnreachableError);
    expect(w.spawns).toHaveLength(1);
    expect(w.store.getOwnership(DIR)!.state).toBe("bound"); // the winner's row is untouched
  });

  it("R10#6 (bounded close) a shutdown connection whose close() never resolves cannot hold the release past the cap", async () => {
    const w = new World();
    const m = new DaemonManager(w.deps());
    const lease = await m.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    const deps = w.deps();
    const m2 = new DaemonManager({
      ...deps,
      connectControl: async (socketPath) => {
        const c = await deps.connectControl(socketPath);
        return { ...c, close: () => new Promise<void>(() => {}) };
      },
    });
    const lease2 = await m2.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    await lease.release();
    const t0 = Date.now();
    await lease2.release();
    expect(Date.now() - t0).toBeLessThan(RELEASE_CAP_MS + 1500);
    expect(w.store.getOwnership(DIR)!.state).toBe("stopped");
  }, 15_000);

  it("#9 an orphaned `stopping` row is recovered when the stopper is dead OR its deadline passed; our live instance has its stop RESUMED", async () => {
    // (a) live stopper, expired deadline → recovered, stop resumed (shutdown op sent), then respawn
    const a = new World();
    const da = a.addDaemon(DIR);
    bindLive(a, da);
    a.store.cas({ dataDir: DIR, from: ["bound"], to: "stopping", expectedGeneration: 1, bumpGeneration: true, set: { ownerPid: a.selfPid, ownerPidStartedAt: "self-start", deadlineMs: a.clock - 1 } });
    const ma = new DaemonManager(a.deps());
    const la = await ma.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(a.shutdownRequests).toHaveLength(1);
    expect(la.mode).toBe("owned");
    expect(a.spawns).toHaveLength(1);
    expect(a.logs.find((l) => l.event === "daemon_stopping_recovered")?.fields).toMatchObject({ to: "stopped" });

    // (b) dead stopper, fresh deadline → recovered as well
    const b = new World();
    b.store.claim({ dataDir: DIR, controlSocket: `${DIR}/adc.sock`, sessionSocket: `${DIR}/adc-session.sock`, ownerPid: 1, ownerPidStartedAt: "x" });
    b.store.cas({ dataDir: DIR, from: ["claimed"], to: "stopping", bumpGeneration: true, set: { ownerPid: 999, ownerPidStartedAt: "gone", deadlineMs: b.clock + 60_000 } });
    b.dirs.set(DIR, "nonempty");
    const mb = new DaemonManager(b.deps());
    const lb = await mb.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lb.mode).toBe("owned");
    expect(b.logs.some((l) => l.event === "daemon_stopping_recovered")).toBe(true);

    // (c) an unverified listener on our socket → the row is stale and we attach foreign
    const c = new World();
    const dc = c.addDaemon(DIR);
    bindLive(c, dc, { daemonStartedAtMs: dc.info.started_at_ms - 1 });
    c.store.cas({ dataDir: DIR, from: ["bound"], to: "stopping", expectedGeneration: 1, bumpGeneration: true, set: { ownerPid: 999, ownerPidStartedAt: "gone", deadlineMs: c.clock - 1 } });
    const mc = new DaemonManager(c.deps());
    const lc = await mc.acquire({ identity: identityFor(DIR), server: SERVER, role: "runtime" });
    expect(lc.mode).toBe("foreign");
    expect(c.shutdownRequests).toHaveLength(0);
    expect(c.logs.find((l) => l.event === "daemon_stopping_recovered")?.fields).toMatchObject({ to: "stale" });
  });
});
