import { AlreadyAttachedError, type AdcClientOptions } from "@ademu/adc-client";
import { ConnectionClosedError, ControlError, ControlTimeoutError, type FourWords } from "@ademu/adc-control";
import { describe, expect, it } from "vitest";
import {
  createEnrollmentLease,
  EnrollmentError,
  ENROLLMENT_TTL_MS,
  probeTokenIdentity,
  runEnrollment,
  tokenLabelFor,
  type EnrollmentLeaseDeps,
} from "../src/ceremony.js";
import type { Attacher, Attachment } from "../src/monitor/attach.js";
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

function startNew(control: FakeControl, h: Hooks, extra: { signal?: AbortSignal | undefined; confirmTakeover?: (() => Promise<boolean>) | undefined; session?: ReturnType<typeof sessionFor> | undefined } = {}) {
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
    // daemon_info is requested BEFORE token_mint: the first successful mint closes the enrollment connection (M20 a)
    expect(control.calls.map((c) => c.op)).toEqual(["create_device", "poll", "confirm_words", "daemon_info", "token_mint"]);
    expect(control.calls.find((c) => c.op === "token_mint")?.params).toEqual({ device_id: NEW_DEVICE, label: tokenLabelFor("iris") });
    expect(result).toMatchObject({ deviceId: NEW_DEVICE, agentUserId: NEW_AGENT, ownerUserId: OWNER, token: "adc1_secret_1", tokenId: "tid-1", tokenLabel: "openclaw-iris", sessionSocketPath: "/d/adc-session.sock" });
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

  it("the mint happens exactly once and never with replace: label_exists, a lost reply and a timeout are typed dead ends (M20 b)", async () => {
    const drive = async (impl: NonNullable<FakeControl["tokenMintImpl"]>) => {
      const control = new FakeControl();
      control.tokenMintImpl = impl;
      const { run } = startNew(control, hooks());
      await tick();
      control.emit({ words: WORDS });
      await tick();
      control.finish("enrolled");
      const outcome = await run.then(
        (r) => ({ ok: true as const, r }),
        (e: unknown) => ({ ok: false as const, e }),
      );
      const mints = control.calls.filter((c) => c.op === "token_mint").map((c) => c.params as { replace?: true });
      return { outcome, mints, control };
    };
    const exists = await drive(async () => {
      throw new ControlError("label_exists", "x");
    });
    expect(exists.outcome).toMatchObject({ ok: false, e: { reason: "label_exists" } });
    expect(exists.mints).toHaveLength(1);
    expect(exists.mints.some((m) => m.replace)).toBe(false);

    const lost = await drive(async () => {
      throw new ConnectionClosedError({ op: "token_mint", id: "7" });
    });
    expect(lost.outcome).toMatchObject({ ok: false, e: { reason: "mint_lost" } });
    expect(lost.mints).toHaveLength(1);

    const timedOut = await drive(async () => {
      throw new ControlTimeoutError("token_mint", "8", 30_000);
    });
    expect(timedOut.outcome).toMatchObject({ ok: false, e: { reason: "mint_lost" } });
    expect(timedOut.mints).toHaveLength(1);

    // a closed connection with a DIFFERENT op in flight is not a lost mint
    const other = await drive(async () => {
      throw new ConnectionClosedError({ op: "daemon_info", id: "9" });
    });
    expect(other.outcome.ok).toBe(false);
    expect((other.outcome as { e: unknown }).e).toBeInstanceOf(ConnectionClosedError);
  });

  it("a full enrollment budget (enroll_quota) on create_device is a typed refusal with no device and no poll; enroll_scope is unexpected", async () => {
    const quota = new FakeControl();
    quota.createDeviceImpl = async () => {
      throw new ControlError("enroll_quota", "full");
    };
    const q = startNew(quota, hooks());
    await expect(q.run).rejects.toMatchObject({ reason: "enroll_quota" });
    expect(quota.calls.map((c) => c.op)).toEqual(["create_device"]);
    expect(q.devices).toEqual([]);

    const scope = new FakeControl();
    scope.createDeviceImpl = async () => {
      throw new ControlError("enroll_scope", "nope");
    };
    await expect(startNew(scope, hooks()).run).rejects.toMatchObject({ reason: "unexpected_state" });
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

describe("ceremony: the token door (probeTokenIdentity)", () => {
  const signal = new AbortController().signal;

  it("a pasted token yields the device and identities from the session's hello + get_self; nothing is minted", async () => {
    const s = sessionFor();
    const r = await probeTokenIdentity({ token: "adc1_pasted", sessionSocketPath: "/d/adc-session.sock", connectSession: s.connect, signal });
    expect(r).toEqual({ deviceId: NEW_DEVICE, agentUserId: NEW_AGENT, ownerUserId: OWNER, agentUsername: s.client.self.username, agentDisplayName: s.client.self.display_name });
    expect(s.connects).toEqual([{ token: "adc1_pasted", socketPath: "/d/adc-session.sock", takeover: false, reconnect: "never" }]);
    expect(s.client.closed).toBe(true);
  });

  it("hello and get_self must agree on the device and the agent (identity_mismatch otherwise)", async () => {
    const s = sessionFor();
    s.client.hello.device_id = "cccccccc-1111-4222-8333-444444444444";
    await expect(probeTokenIdentity({ token: "t", sessionSocketPath: "/d/adc-session.sock", connectSession: s.connect, signal })).rejects.toMatchObject({ reason: "identity_mismatch" });
    const s2 = sessionFor();
    s2.client.hello.agent_user_id = "dddddddd-1111-4222-8333-444444444444";
    await expect(probeTokenIdentity({ token: "t", sessionSocketPath: "/d/adc-session.sock", connectSession: s2.connect, signal })).rejects.toMatchObject({ reason: "identity_mismatch" });
    expect(s2.client.closed).toBe(true);
  });

  it("a device with a live mind is refused unless takeover is consented", async () => {
    const refused = sessionFor();
    refused.attachedOnce(true);
    await expect(probeTokenIdentity({ token: "t", sessionSocketPath: "/d/adc-session.sock", connectSession: refused.connect, signal })).rejects.toMatchObject({ reason: "device_attached" });
    const consented = sessionFor();
    consented.attachedOnce(true);
    await probeTokenIdentity({ token: "t", sessionSocketPath: "/d/adc-session.sock", connectSession: consented.connect, signal, confirmTakeover: async () => true });
    expect(consented.connects.map((c) => c.takeover)).toEqual([false, true]);
  });
});

describe("ceremony: EnrollmentLease", () => {
  function leaseWorld() {
    let released = 0;
    const acquired: unknown[] = [];
    const attachment: Attachment = {
      role: "setup",
      identity: {} as never,
      info: { enrollSocketPath: "/d/adc-enroll.sock", sessionSocketPath: "/d/adc-session.sock" },
      release: async () => {
        released++;
      },
    };
    const attacher = {
      attach: async (p: unknown) => {
        acquired.push(p);
        return attachment;
      },
      resolveSessionSocket: async () => attachment.info.sessionSocketPath,
    } satisfies Attacher;
    const control = new FakeControl();
    const timers: Array<{ fn: () => void; ms: number; cleared: boolean }> = [];
    const disposed: string[] = [];
    const dialled: string[] = [];
    const deps: EnrollmentLeaseDeps = {
      attacher,
      connectEnroll: async (path) => {
        dialled.push(path);
        return control;
      },
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
    return { deps, control, timers, disposed, acquired, dialled, released: () => released };
  }

  it("A38: the ceremony lease dials the ENROLLMENT socket the attachment names and never a control endpoint", async () => {
    const w = leaseWorld();
    expect("connectControl" in w.deps).toBe(false);
    const lease = await createEnrollmentLease({ deps: w.deps, accountId: "iris", identity: {} as never, beforeEffect: async () => {} });
    expect(w.dialled).toEqual(["/d/adc-enroll.sock"]);
    await lease.dispose("done");
  });

  it("attaches in the SETUP role, disposes exactly once (cancel pairing → close → release), and clears the TTL timer", async () => {
    const w = leaseWorld();
    const lease = await createEnrollmentLease({ deps: w.deps, accountId: "iris", identity: {} as never, beforeEffect: async () => {} });
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

  it("R7#2 concurrent dispose calls JOIN the one cleanup in progress (all await the release)", async () => {
    const w = leaseWorld();
    let releaseClose!: () => void;
    const slow = new Promise<void>((r) => {
      releaseClose = r;
    });
    w.control.close = async () => {
      w.control.closed++;
      await slow;
    };
    const lease = await createEnrollmentLease({ deps: w.deps, accountId: "iris", identity: {} as never, beforeEffect: async () => {} });
    let secondDone = false;
    const first = lease.dispose("a");
    const second = lease.dispose("b").then(() => {
      secondDone = true;
    });
    await tick();
    expect(secondDone).toBe(false); // the second caller waits for the cleanup, it does not return early
    releaseClose();
    await Promise.all([first, second]);
    expect(w.released()).toBe(1);
    expect(w.control.closed).toBe(1);
    expect(w.disposed).toEqual(["a"]);
  });

  it("does not cancel pairing once the device is terminal; the TTL timer disposes with reason expired", async () => {
    const w = leaseWorld();
    const lease = await createEnrollmentLease({ deps: w.deps, accountId: "iris", identity: {} as never, beforeEffect: async () => {}, ttlMs: 5 });
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

  it("releases the daemon lease when the enrollment connection cannot be opened", async () => {
    const w = leaseWorld();
    w.deps.connectEnroll = async () => {
      throw new Error("no socket");
    };
    await expect(createEnrollmentLease({ deps: w.deps, accountId: "iris", identity: {} as never, beforeEffect: async () => {} })).rejects.toThrow(/no socket/);
    expect(w.released()).toBe(1);
  });
});
