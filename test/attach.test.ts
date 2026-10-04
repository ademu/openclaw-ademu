// DaemonAttacher (AdemuMLS #712): the plugin attaches to an installed adc and never runs one. The
// runtime probes once and never starts a service; an enrollment may ask the service manager to start
// the INSTALLED user service, and only when the identity is that service's own enrollment socket.
import { describe, expect, it, vi } from "vitest";
import { PrivilegeError, type DaemonInfoResult, type UserServiceLayout, type UserServiceStartResult } from "@ademu/adc-control";
import { resolveDaemonIdentity, type DaemonIdentity } from "../src/config.js";
import {
  abortableSleep,
  AdcServiceNotAnsweringError,
  AdcServiceNotInstalledError,
  AdcTooOldError,
  DaemonAbortedError,
  DaemonAttacher,
  DaemonUnreachableError,
  DaemonUnsupportedError,
  MIN_ADC_VERSION,
  SERVICE_START_WAIT_MS,
  versionAtLeast,
  type AttachDeps,
} from "../src/monitor/attach.js";

const DATA = "/tmp/ademu-attach-test/adc";
const SYSTEM_ENROLL = "/run/adc/adc-enroll.sock";

function info(over: Partial<DaemonInfoResult> = {}): DaemonInfoResult {
  return {
    version: `${MIN_ADC_VERSION} (test)`,
    key_provider: "file",
    kek_rung: 0,
    data_dir: DATA,
    socket_path: `${DATA}/adc.sock`,
    config_source: "file",
    started_at_ms: 0,
    session_socket_path: `${DATA}/adc-session.sock`,
    enroll_socket_path: `${DATA}/adc-enroll.sock`,
    ...over,
  };
}

function layout(dataDir = DATA): UserServiceLayout {
  return {
    dataDir,
    dataDirSource: "unit",
    controlSocketPath: `${dataDir}/adc.sock`,
    sessionSocketPath: `${dataDir}/adc-session.sock`,
    enrollSocketPath: `${dataDir}/adc-enroll.sock`,
    unitPath: "/Users/u/Library/LaunchAgents/com.ademu.adc.plist",
    unitKind: "launchd",
    label: "com.ademu.adc",
    unitName: "adc.service",
  };
}

type Answer = "absent" | "privilege" | "stall" | DaemonInfoResult;

type World = {
  deps: AttachDeps;
  /** Per enrollment-socket path, the answers of successive probes (the last one repeats). */
  answers: Map<string, Answer[]>;
  controlAnswers: boolean;
  installed: { installed: boolean; disabled: boolean };
  startResult: UserServiceStartResult;
  startCalls: number;
  installedCalls: number;
  probes: string[];
  sleeps: number[];
  clock: { t: number };
  /** Connections whose daemon_info never answers, and how many of them were closed. */
  stalled: { opened: number; closed: number };
  effects: string[];
};

function world(over: { layout?: UserServiceLayout; platform?: string } = {}): World {
  const w: World = {
    answers: new Map(),
    controlAnswers: false,
    installed: { installed: true, disabled: false },
    startResult: { kind: "started" },
    startCalls: 0,
    installedCalls: 0,
    probes: [],
    sleeps: [],
    clock: { t: 0 },
    stalled: { opened: 0, closed: 0 },
    effects: [],
    deps: undefined as unknown as AttachDeps,
  };
  w.deps = {
    now: () => w.clock.t,
    sleep: async (ms) => {
      w.sleeps.push(ms);
      w.clock.t += ms;
    },
    connectEnroll: async (socketPath) => {
      w.probes.push(socketPath);
      const seq = w.answers.get(socketPath) ?? ["absent"];
      const a = seq.length > 1 ? seq.shift()! : seq[0]!;
      if (a === "absent") throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
      if (a === "privilege") throw new PrivilegeError("denied", "EACCES");
      if (a === "stall") {
        w.stalled.opened++;
        return {
          daemonInfo: () => new Promise<never>(() => {}),
          close: async () => {
            w.stalled.closed++;
          },
        };
      }
      return { daemonInfo: async () => a, close: async () => {} };
    },
    controlSocketAnswers: async () => w.controlAnswers,
    userService: {
      layout: () => over.layout ?? layout(),
      installed: async () => {
        w.installedCalls++;
        return w.installed;
      },
      start: async () => {
        w.startCalls++;
        w.effects.push("start");
        return w.startResult;
      },
    },
    platform: over.platform ?? "darwin",
    log: () => {},
  };
  return w;
}

const userIdentity = (): DaemonIdentity => resolveDaemonIdentity({ dataDir: DATA }, process.env, () => false);
// The Linux system layout, pinned (the macOS one lives under /private/var/db/adc/run).
const systemIdentity = (): DaemonIdentity => resolveDaemonIdentity({ enrolledScope: "system" }, process.env, () => true, undefined, "linux");

describe("runtime role: probe once, never start, never wait", () => {
  it("a reachable daemon's reported session socket is the authority, even a custom one", async () => {
    const w = world();
    w.answers.set(`${DATA}/adc-enroll.sock`, [info({ session_socket_path: "/custom/adc-session.sock" })]);
    const a = await new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "runtime" });
    expect(a.info.sessionSocketPath).toBe("/custom/adc-session.sock");
    expect(a.unreachable).toBeUndefined();
    expect(w.startCalls).toBe(0);
  });

  it("a gated enrollment socket still attaches on the fallback session path", async () => {
    const w = world();
    w.answers.set(`${DATA}/adc-enroll.sock`, ["privilege"]);
    const a = await new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "runtime" });
    expect(a.info.sessionSocketPath).toBe(`${DATA}/adc-session.sock`);
    expect(w.startCalls).toBe(0);
  });

  it.each([
    [{ installed: true, disabled: false }, "not_running"],
    [{ installed: false, disabled: false }, "not_installed"],
    [{ installed: true, disabled: true }, "disabled"],
  ] as const)("nothing answering (%o) is %s — and nothing is started or awaited", async (state, why) => {
    const w = world();
    w.installed = { ...state };
    const a = await new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "runtime" });
    expect(a.unreachable).toBe(why);
    expect(a.info.sessionSocketPath).toBe(`${DATA}/adc-session.sock`);
    expect(w.startCalls).toBe(0);
    expect(w.sleeps).toEqual([]);
    expect(w.probes).toHaveLength(1);
  });

  it("a system install that is down is system_down, never started", async () => {
    const w = world();
    const a = await new DaemonAttacher(w.deps).attach({ identity: systemIdentity(), role: "runtime" });
    expect(a.unreachable).toBe("system_down");
    expect(w.probes).toEqual([SYSTEM_ENROLL]);
    expect(w.startCalls + w.installedCalls).toBe(0);
  });

  it("resolveSessionSocket re-resolves: reported when reachable, else the fallback", async () => {
    const w = world();
    const attacher = new DaemonAttacher(w.deps);
    w.answers.set(`${DATA}/adc-enroll.sock`, [info({ session_socket_path: "/moved/adc-session.sock" }), "absent"]);
    expect(await attacher.resolveSessionSocket(userIdentity())).toBe("/moved/adc-session.sock");
    expect(await attacher.resolveSessionSocket(userIdentity())).toBe(`${DATA}/adc-session.sock`);
  });
});

describe("setup role (the enrollment doors)", () => {
  it("a reachable current daemon attaches without touching the service manager", async () => {
    const w = world();
    w.answers.set(`${DATA}/adc-enroll.sock`, [info()]);
    const a = await new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "setup" });
    expect(a.info.sessionSocketPath).toBe(`${DATA}/adc-session.sock`);
    expect(a.info.daemonVersion).toBe(MIN_ADC_VERSION);
    expect(w.startCalls + w.installedCalls).toBe(0);
  });

  it("a daemon below the floor is too old", async () => {
    const w = world();
    w.answers.set(`${DATA}/adc-enroll.sock`, [info({ version: "0.5.0 (source)" })]);
    await expect(new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "setup" })).rejects.toBeInstanceOf(AdcTooOldError);
  });

  it("no enrollment socket but a control socket that answers is a pre-Phase-B daemon: too old, nothing started", async () => {
    const w = world();
    w.controlAnswers = true;
    await expect(new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "setup" })).rejects.toBeInstanceOf(AdcTooOldError);
    expect(w.startCalls).toBe(0);
  });

  it("an installed service that is down is started (after the authority re-check) and waited for", async () => {
    const w = world();
    w.answers.set(`${DATA}/adc-enroll.sock`, ["absent", "absent", "absent", info()]);
    const a = await new DaemonAttacher(w.deps).attach({
      identity: userIdentity(),
      role: "setup",
      beforeEffect: async () => {
        w.effects.push("beforeEffect");
      },
    });
    expect(w.effects).toEqual(["beforeEffect", "start"]);
    expect(w.startCalls).toBe(1);
    expect(a.info.sessionSocketPath).toBe(`${DATA}/adc-session.sock`);
    expect(w.sleeps.length).toBeGreaterThan(0);
  });

  it("a started service that never answers fails after the wait", async () => {
    const w = world();
    const err = await new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "setup" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdcServiceNotAnsweringError);
    expect((err as AdcServiceNotAnsweringError).disabled).toBe(false);
    expect(w.clock.t).toBeGreaterThanOrEqual(SERVICE_START_WAIT_MS);
    expect(w.startCalls).toBe(1);
  });

  it("a start the service manager refuses carries its reason", async () => {
    const w = world();
    w.startResult = { kind: "failed", reason: "launchctl bootstrap exited 5" };
    const err = await new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "setup" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdcServiceNotAnsweringError);
    expect((err as AdcServiceNotAnsweringError).reason).toBe("launchctl bootstrap exited 5");
  });

  it("a disabled service is reported, never started", async () => {
    const w = world();
    w.installed = { installed: true, disabled: true };
    const err = await new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "setup" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdcServiceNotAnsweringError);
    expect((err as AdcServiceNotAnsweringError).disabled).toBe(true);
    expect(w.startCalls).toBe(0);
  });

  it("no installed service is not-installed", async () => {
    const w = world();
    w.installed = { installed: false, disabled: false };
    await expect(new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "setup" })).rejects.toBeInstanceOf(
      AdcServiceNotInstalledError,
    );
    expect(w.startCalls).toBe(0);
  });

  it("an explicit path that is not the installed service's own is never started", async () => {
    const w = world({ layout: layout("/somewhere/else/adc") });
    await expect(new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "setup" })).rejects.toBeInstanceOf(
      DaemonUnreachableError,
    );
    expect(w.startCalls + w.installedCalls).toBe(0);
  });

  it("a system install is attached as it is — reachable, down, or gated — and never started", async () => {
    for (const answer of [info({ session_socket_path: "/run/adc/adc-session.sock" }), "absent", "privilege"] as Answer[]) {
      const w = world();
      w.answers.set(SYSTEM_ENROLL, [answer]);
      const a = await new DaemonAttacher(w.deps).attach({ identity: systemIdentity(), role: "setup" });
      expect(a.info.sessionSocketPath).toBe("/run/adc/adc-session.sock");
      expect(w.startCalls + w.installedCalls).toBe(0);
    }
  });

  it("a user-scope PrivilegeError propagates (the operator ceremony handles it)", async () => {
    const w = world();
    w.answers.set(`${DATA}/adc-enroll.sock`, ["privilege"]);
    await expect(new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "setup" })).rejects.toBeInstanceOf(PrivilegeError);
  });

  it("an abort during the wait ends it", async () => {
    const w = world();
    const ctl = new AbortController();
    w.deps.sleep = async () => {
      ctl.abort();
    };
    await expect(new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "setup", signal: ctl.signal })).rejects.toBeInstanceOf(
      DaemonAbortedError,
    );
  });
});

describe("cancellation and the setup budget (Codex branch pass, #712 PR-b)", () => {
  it("setup: a started service whose daemon_info stalls is bounded by the 20 s budget, and the late connection is closed", async () => {
    const w = world();
    w.answers.set(`${DATA}/adc-enroll.sock`, ["absent", "absent", "stall"]);
    // The first pause jumps the clock to 50 ms before the deadline: the stalled probe then has 50 ms.
    let jumped = false;
    w.deps.sleep = async (ms) => {
      w.sleeps.push(ms);
      w.clock.t += jumped ? ms : SERVICE_START_WAIT_MS - 50;
      jumped = true;
    };
    const t0 = Date.now();
    const err = await new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "setup" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(AdcServiceNotAnsweringError);
    expect(Date.now() - t0).toBeLessThan(5_000);
    await new Promise((r) => setTimeout(r, 5));
    expect(w.stalled).toEqual({ opened: 1, closed: 1 });
  });

  it("setup: an abort during a stalled probe is an abort, not 'not answering'", async () => {
    const w = world();
    w.answers.set(`${DATA}/adc-enroll.sock`, ["absent", "stall"]);
    const ctl = new AbortController();
    const run = new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "setup", signal: ctl.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    expect(await run).toBeInstanceOf(DaemonAbortedError);
  });

  it("runtime: an abort while the service-state lookup is pending ends the attach at once", async () => {
    const w = world();
    w.deps.userService.installed = () => new Promise(() => {}); // launchctl print-disabled hanging
    const ctl = new AbortController();
    const run = new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "runtime", signal: ctl.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    ctl.abort();
    expect(await run).toBeInstanceOf(DaemonAbortedError);
  });

  it("setup: an abort during the authority re-check never reaches the service start (Codex branch pass 2)", async () => {
    const w = world();
    const ctl = new AbortController();
    const err = await new DaemonAttacher(w.deps)
      .attach({ identity: userIdentity(), role: "setup", signal: ctl.signal, beforeEffect: async () => ctl.abort() })
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(DaemonAbortedError);
    expect(w.startCalls).toBe(0);
  });

  it("setup: an abort while the service manager is still starting ends the attach at once, and a late failure is not reported (Codex branch pass 2)", async () => {
    const w = world();
    let finishStart!: (r: UserServiceStartResult) => void;
    w.deps.userService.start = () => {
      w.startCalls++;
      return new Promise((r) => (finishStart = r));
    };
    const ctl = new AbortController();
    const run = new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "setup", signal: ctl.signal }).catch((e: unknown) => e);
    await new Promise((r) => setTimeout(r, 10));
    expect(w.startCalls).toBe(1);
    ctl.abort();
    expect(await run).toBeInstanceOf(DaemonAbortedError);
    finishStart({ kind: "failed", reason: "launchctl bootstrap exited 5" }); // late: nobody is listening
  });

  it("the real sleep resolves early on abort and leaves no timer behind", async () => {
    vi.useFakeTimers();
    try {
      const ctl = new AbortController();
      let done = false;
      const p = abortableSleep(30_000, ctl.signal).then(() => (done = true));
      expect(vi.getTimerCount()).toBe(1);
      ctl.abort();
      await p;
      expect(done).toBe(true);
      expect(vi.getTimerCount()).toBe(0);
      await abortableSleep(10, ctl.signal); // already aborted: resolves at once, arms nothing
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("refusals that hold for both roles", () => {
  it("Windows is unsupported", async () => {
    const w = world({ platform: "win32" });
    await expect(new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "runtime" })).rejects.toBeInstanceOf(
      DaemonUnsupportedError,
    );
  });

  it("a reachable daemon that reports no session socket is unsupported, never a derived path", async () => {
    const w = world();
    w.answers.set(`${DATA}/adc-enroll.sock`, [info({ session_socket_path: "" })]);
    await expect(new DaemonAttacher(w.deps).attach({ identity: userIdentity(), role: "runtime" })).rejects.toBeInstanceOf(
      DaemonUnsupportedError,
    );
  });

  it("versionAtLeast fails closed on an unparsable side", () => {
    expect(versionAtLeast("0.6.0 (source)", "0.6.0")).toBe(true);
    expect(versionAtLeast("0.10.0", "0.6.0")).toBe(true);
    expect(versionAtLeast("0.5.9", "0.6.0")).toBe(false);
    expect(versionAtLeast(undefined, "0.6.0")).toBe(false);
  });
});
