import { AlreadyAttachedError, type AdcClientOptions } from "@ademu/adc-client";
import { ControlError, type FourWords } from "@ademu/adc-control";
import { describe, expect, it } from "vitest";
import {
  connectExisting,
  createEnrollmentLease,
  EnrollmentError,
  ENROLLMENT_TTL_MS,
  listEnrolledDevices,
  runEnrollment,
  tokenLabelFor,
  type EnrollmentLeaseDeps,
} from "../src/ceremony.js";
import type { DaemonManager, Lease } from "../src/monitor/daemon.js";
import { FakeAdcClient, OWNER } from "./fakes/adc.js";
import { FakeControl, NEW_AGENT, NEW_DEVICE, QR, WORDS } from "./fakes/control.js";

const tick = () => new Promise((r) => setTimeout(r, 2));

function sessionFor(deviceId = NEW_DEVICE, agentUserId = NEW_AGENT) {
  const client = new FakeAdcClient({ deviceId, agentUserId, ownerUserId: OWNER });
  const connects: AdcClientOptions[] = [];
  let attachedOnce = false;
  return {
    client,
    connects,
    attachedOnce: (v: boolean) => (attachedOnce = v),
    connect: async (opts: AdcClientOptions) => {
      connects.push(opts);
      if (attachedOnce && !opts.takeover) {
        attachedOnce = false;
        throw new AlreadyAttachedError();
      }
      return client as never;
    },
  };
}

type Hooks = {
  qr: string[];
  words: FourWords[];
  confirmAnswer: boolean;
  confirmedWith: FourWords[];
  effects: number;
  effectShouldThrow?: boolean;
};

function hooks(over: Partial<Hooks> = {}): Hooks {
  return { qr: [], words: [], confirmAnswer: true, confirmedWith: [], effects: 0, ...over };
}

function startNew(control: FakeControl, h: Hooks, extra: { signal?: AbortSignal | undefined; confirmReplace?: (() => Promise<boolean>) | undefined; confirmTakeover?: (() => Promise<boolean>) | undefined; session?: ReturnType<typeof sessionFor> | undefined } = {}) {
  const s = extra.session ?? sessionFor();
  const devices: string[] = [];
  const run = runEnrollment({
    control,
    connectSession: s.connect,
    accountId: "iris",
    agentName: "Iris",
    beforeEffect: async () => {
      h.effects++;
      if (h.effectShouldThrow) throw new Error("authority expired");
    },
    signal: extra.signal ?? new AbortController().signal,
    onQr: async (p) => {
      h.qr.push(p);
    },
    onWords: async (w) => {
      h.words.push(w);
    },
    confirm: async (w) => {
      h.confirmedWith.push(w);
      return h.confirmAnswer;
    },
    onDevice: (id) => devices.push(id),
    confirmReplace: extra.confirmReplace,
    confirmTakeover: extra.confirmTakeover,
  });
  run.catch(() => {});
  return { run, session: s, devices };
}

describe("ceremony: new enrollment", () => {
  it("renders the QR immediately, presents the daemon's words, confirms them (never user-typed), then mints and probes identity — without awaiting the poll first", async () => {
    const control = new FakeControl();
    const h = hooks();
    const { run, session, devices } = startNew(control, h);
    await tick();
    expect(control.calls.map((c) => c.op)).toEqual(["create_device", "poll"]);
    expect(h.qr).toEqual([QR]);
    expect(devices).toEqual([NEW_DEVICE]);

    control.emit(); // scanned, no words yet
    await tick();
    expect(h.words).toEqual([]);
    control.emit({ state: "paired", words: WORDS });
    await tick();
    expect(h.words).toEqual([WORDS]);
    expect(h.confirmedWith).toEqual([WORDS]);
    // confirm_words was sent with the DAEMON's words while the poll is still open
    const confirm = control.calls.find((c) => c.op === "confirm_words");
    expect(confirm?.params).toEqual({ device_id: NEW_DEVICE, words: WORDS });
    expect(control.polling).toBe(true);

    control.finish("enrolled");
    const result = await run;
    expect(control.calls.map((c) => c.op)).toEqual(["create_device", "poll", "confirm_words", "token_mint", "daemon_info"]);
    expect(control.calls.find((c) => c.op === "token_mint")?.params).toEqual({ device_id: NEW_DEVICE, label: tokenLabelFor("iris") });
    expect(result).toMatchObject({ deviceId: NEW_DEVICE, agentUserId: NEW_AGENT, ownerUserId: OWNER, token: "adc1_secret_1", tokenId: "tid-1", sessionSocketPath: "/d/adc-session.sock" });
    // identity probe: takeover false, reconnect never, closed afterwards
    expect(session.connects).toEqual([{ token: "adc1_secret_1", socketPath: "/d/adc-session.sock", takeover: false, reconnect: "never" }]);
    expect(session.client.closed).toBe(true);
    // authority re-check before createDevice, confirmWords and tokenMint
    expect(h.effects).toBe(3);
  });

  it("a words mismatch surfaces as a typed failure", async () => {
    const control = new FakeControl();
    control.confirmWordsImpl = async () => {
      throw new ControlError("words_mismatch", "nope");
    };
    const { run } = startNew(control, hooks());
    await tick();
    control.emit({ words: WORDS });
    await expect(run).rejects.toMatchObject({ reason: "words_mismatch" });
  });

  it("the human says no → cancelPairing and a cancelled failure; no confirm_words, no mint", async () => {
    const control = new FakeControl();
    const { run } = startNew(control, hooks({ confirmAnswer: false }));
    await tick();
    control.emit({ words: WORDS });
    await expect(run).rejects.toMatchObject({ reason: "cancelled" });
    expect(control.calls.map((c) => c.op)).toEqual(["create_device", "poll", "cancel_pairing"]);
  });

  it("abort while waiting for the words → cancelPairing and aborted", async () => {
    const control = new FakeControl();
    const ac = new AbortController();
    const { run } = startNew(control, hooks(), { signal: ac.signal });
    await tick();
    ac.abort();
    await expect(run).rejects.toMatchObject({ reason: "aborted" });
    expect(control.calls.some((c) => c.op === "cancel_pairing")).toBe(true);
    expect(control.calls.some((c) => c.op === "token_mint")).toBe(false);
  });

  it("revoked / retired before the words → typed failure", async () => {
    for (const state of ["revoked", "retired"] as const) {
      const control = new FakeControl();
      const { run } = startNew(control, hooks());
      await tick();
      control.finish(state);
      await expect(run).rejects.toMatchObject({ reason: state });
    }
  });

  it("a failing authority check before confirm_words aborts without confirming or minting", async () => {
    const control = new FakeControl();
    const h = hooks();
    const { run } = startNew(control, h);
    await tick();
    h.effectShouldThrow = true;
    control.emit({ words: WORDS });
    await expect(run).rejects.toThrow(/authority expired/);
    expect(control.calls.some((c) => c.op === "confirm_words")).toBe(false);
    expect(control.calls.some((c) => c.op === "token_mint")).toBe(false);
  });

  it("an existing token label: refused without consent; rotated with replace:true on consent", async () => {
    const make = (consent?: () => Promise<boolean>) => {
      const control = new FakeControl();
      let first = true;
      control.tokenMintImpl = async (p) => {
        if (first && !p.replace) {
          first = false;
          throw new ControlError("label_exists", "x");
        }
        return { token_id: "tid-r", label: p.label, token: "adc1_rotated", created_at_ms: 1 };
      };
      const { run } = startNew(control, hooks(), { confirmReplace: consent });
      return { control, run };
    };
    const refused = make();
    await tick();
    refused.control.emit({ words: WORDS });
    await tick();
    refused.control.finish("enrolled");
    await expect(refused.run).rejects.toMatchObject({ reason: "label_exists" });

    const rotated = make(async () => true);
    await tick();
    rotated.control.emit({ words: WORDS });
    await tick();
    rotated.control.finish("enrolled");
    const result = await rotated.run;
    expect(result.token).toBe("adc1_rotated");
    const mints = rotated.control.calls.filter((c) => c.op === "token_mint").map((c) => c.params);
    expect(mints).toEqual([
      { device_id: NEW_DEVICE, label: "openclaw-iris" },
      { device_id: NEW_DEVICE, label: "openclaw-iris", replace: true },
    ]);
  });

  it("identity probe: a device with a live mind is refused unless takeover is consented; a foreign device id is a mismatch", async () => {
    const attached = sessionFor();
    attached.attachedOnce(true);
    const c1 = new FakeControl();
    const r1 = startNew(c1, hooks(), { session: attached });
    await tick();
    c1.emit({ words: WORDS });
    await tick();
    c1.finish("enrolled");
    await expect(r1.run).rejects.toMatchObject({ reason: "device_attached" });

    const attached2 = sessionFor();
    attached2.attachedOnce(true);
    const c2 = new FakeControl();
    const r2 = startNew(c2, hooks(), { session: attached2, confirmTakeover: async () => true });
    await tick();
    c2.emit({ words: WORDS });
    await tick();
    c2.finish("enrolled");
    await r2.run;
    expect(attached2.connects.map((c) => c.takeover)).toEqual([false, true]);

    const wrong = sessionFor("cccccccc-1111-4222-8333-444444444444");
    const c3 = new FakeControl();
    const r3 = startNew(c3, hooks(), { session: wrong });
    await tick();
    c3.emit({ words: WORDS });
    await tick();
    c3.finish("enrolled");
    await expect(r3.run).rejects.toMatchObject({ reason: "identity_mismatch" });
  });

  it("a daemon without a session socket path is refused", async () => {
    const control = new FakeControl();
    control.info = { ...control.info, session_socket_path: undefined as never };
    const { run } = startNew(control, hooks());
    await tick();
    control.emit({ words: WORDS });
    await tick();
    control.finish("enrolled");
    await expect(run).rejects.toMatchObject({ reason: "daemon_too_old" });
  });
});

describe("ceremony: connect an already-enrolled device", () => {
  it("mints the account label and probes identity; refuses a device that is not enrolled", async () => {
    const control = new FakeControl();
    const s = sessionFor();
    const common = { control, connectSession: s.connect, accountId: "bob", beforeEffect: async () => {}, signal: new AbortController().signal };
    const result = await connectExisting({ ...common, deviceId: NEW_DEVICE });
    expect(result.ownerUserId).toBe(OWNER);
    expect(control.calls.find((c) => c.op === "token_mint")?.params).toEqual({ device_id: NEW_DEVICE, label: "openclaw-bob" });

    control.statusState = "created";
    await expect(connectExisting({ ...common, deviceId: NEW_DEVICE })).rejects.toMatchObject({ reason: "not_enrolled" });
  });

  it("lists only enrolled devices", async () => {
    const control = new FakeControl();
    control.devices = [
      { device_id: "a", agent_user_id: "ua", agent_name: "A", state: "enrolled" },
      { device_id: "b", agent_user_id: "ub", agent_name: "B", state: "created" },
    ];
    expect(await listEnrolledDevices(control)).toEqual([{ deviceId: "a", agentName: "A", agentUserId: "ua" }]);
  });
});

describe("ceremony: EnrollmentLease", () => {
  function leaseWorld() {
    let released = 0;
    const acquired: unknown[] = [];
    const daemonLease: Lease = {
      mode: "owned",
      role: "setup",
      identity: {} as never,
      holderId: "h",
      info: { controlSocketPath: "/d/adc.sock", sessionSocketPath: "/d/adc-session.sock" },
      lost: new Promise<never>(() => {}),
      release: async () => {
        released++;
      },
    };
    const daemons = {
      acquire: async (p: unknown) => {
        acquired.push(p);
        return daemonLease;
      },
    } as unknown as DaemonManager;
    const control = new FakeControl();
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const disposed: string[] = [];
    const deps: EnrollmentLeaseDeps = {
      daemons,
      connectControl: async () => control,
      now: () => 1000,
      setTimer: (fn, ms) => {
        const t = { fn, ms, cleared: false };
        timers.push(t);
        return t;
      },
      clearTimer: (h) => {
        (h as { cleared: boolean }).cleared = true;
      },
      onDisposed: (_l, reason) => disposed.push(reason),
    };
    return { deps, control, timers, disposed, acquired, released: () => released };
  }

  it("acquires a SETUP lease, disposes exactly once (cancel pairing → close → release), and clears the TTL timer", async () => {
    const w = leaseWorld();
    const lease = await createEnrollmentLease({ deps: w.deps, accountId: "iris", identity: {} as never, server: { restBaseUrl: "r", wsUrl: "w" }, beforeEffect: async () => {} });
    expect((w.acquired[0] as { role: string }).role).toBe("setup");
    expect(lease.expiresAt).toBe(1000 + ENROLLMENT_TTL_MS);
    lease.deviceId = NEW_DEVICE;
    await lease.dispose("done");
    await lease.dispose("again");
    expect(w.control.calls.filter((c) => c.op === "cancel_pairing")).toHaveLength(1);
    expect(w.control.closed).toBe(1);
    expect(w.released()).toBe(1);
    expect(w.disposed).toEqual(["done"]);
    expect(w.timers[0]?.cleared).toBe(true);
    expect(lease.signal.aborted).toBe(true);
  });

  it("does not cancel pairing once the device is terminal; the TTL timer disposes with reason expired", async () => {
    const w = leaseWorld();
    const lease = await createEnrollmentLease({ deps: w.deps, accountId: "iris", identity: {} as never, server: { restBaseUrl: "r", wsUrl: "w" }, beforeEffect: async () => {}, ttlMs: 5 });
    lease.deviceId = NEW_DEVICE;
    lease.terminal = true;
    expect(w.timers[0]?.ms).toBe(5);
    w.timers[0]!.fn();
    await tick();
    expect(lease.disposed).toBe(true);
    expect(w.disposed).toEqual(["expired"]);
    expect(w.control.calls.some((c) => c.op === "cancel_pairing")).toBe(false);
    expect(w.released()).toBe(1);
  });

  it("releases the daemon lease when the control connection cannot be opened", async () => {
    const w = leaseWorld();
    w.deps.connectControl = async () => {
      throw new Error("no socket");
    };
    await expect(createEnrollmentLease({ deps: w.deps, accountId: "iris", identity: {} as never, server: { restBaseUrl: "r", wsUrl: "w" }, beforeEffect: async () => {} })).rejects.toThrow(/no socket/);
    expect(w.released()).toBe(1);
  });
});
