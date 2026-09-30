import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { WizardCancelledError } from "openclaw/plugin-sdk/setup";
import { describe, expect, it } from "vitest";
import type { EnrollmentLeaseDeps } from "../src/ceremony.js";
import type { DaemonManager, Lease } from "../src/monitor/daemon.js";
import { DaemonUnreachableError } from "../src/monitor/daemon.js";
import { createAdemuSetupWizard, defaultAgentName, presentQr } from "../src/setup-wizard.js";
import { FakeAdcClient, OWNER } from "./fakes/adc.js";
import { FakeControl, NEW_AGENT, NEW_DEVICE, QR, WORDS } from "./fakes/control.js";

type Script = {
  selects?: unknown[];
  texts?: string[];
  confirms?: boolean[];
  plain?: boolean;
  openUrl?: boolean;
};

function fakePrompter(script: Script) {
  const log: Array<{ kind: string; message?: string; title?: string }> = [];
  const selects = [...(script.selects ?? [])];
  const texts = [...(script.texts ?? [])];
  const confirms = [...(script.confirms ?? [])];
  const progress: Array<{ label: string; stopped: boolean }> = [];
  const prompter = {
    intro: async (t: string) => void log.push({ kind: "intro", message: t }),
    outro: async (m: string) => void log.push({ kind: "outro", message: m }),
    note: async (m: string, title?: string) => void log.push({ kind: "note", message: m, ...(title ? { title } : {}) }),
    ...(script.plain === false ? {} : { plain: async (m: string) => void log.push({ kind: "plain", message: m }) }),
    ...(script.openUrl ? { openUrl: async (u: string) => void log.push({ kind: "openUrl", message: u }) } : {}),
    select: async (p: { message: string }) => {
      log.push({ kind: "select", message: p.message });
      if (!selects.length) throw new Error(`unscripted select: ${p.message}`);
      return selects.shift() as never;
    },
    multiselect: async () => [],
    text: async (p: { message: string }) => {
      log.push({ kind: "text", message: p.message });
      return texts.shift() ?? "";
    },
    confirm: async (p: { message: string }) => {
      log.push({ kind: "confirm", message: p.message });
      if (!confirms.length) throw new Error(`unscripted confirm: ${p.message}`);
      return confirms.shift()!;
    },
    progress: (label: string) => {
      const entry = { label, stopped: false };
      progress.push(entry);
      log.push({ kind: "progress", message: label });
      return { update: () => {}, stop: () => void (entry.stopped = true) };
    },
  };
  return { prompter, log, progress };
}

function world(opts: { acquireError?: unknown; connectSession?: () => Promise<never> } = {}) {
  const control = new FakeControl();
  let released = 0;
  const daemonLease: Lease = {
    mode: "owned",
    role: "setup",
    identity: {} as never,
    holderId: "h",
    info: { enrollSocketPath: "/d/adc-enroll.sock", sessionSocketPath: "/d/adc-session.sock" },
    lost: new Promise<never>(() => {}),
    release: async () => void released++,
  };
  const daemons = {
    acquire: async () => {
      if (opts.acquireError) throw opts.acquireError;
      return daemonLease;
    },
  } as unknown as DaemonManager;
  const lease: EnrollmentLeaseDeps = { daemons, connectEnroll: async () => control, now: () => 0, setTimer: () => 0, clearTimer: () => {} };
  const client = new FakeAdcClient({ deviceId: NEW_DEVICE, agentUserId: NEW_AGENT, ownerUserId: OWNER });
  const wizard = createAdemuSetupWizard({
    lease,
    connectSession: opts.connectSession ?? (async () => client as never),
    qr: { terminal: async (p) => `[QR ${p}]`, pngDataUrl: async () => "data:image/png;base64,AAA" },
  });
  return { wizard, control, released: () => released };
}

const baseCfg = { agents: { entries: { main: { identity: { name: "Iris" } } } } } as unknown as OpenClawConfig;
const effects: string[] = [];
const options = { beforePersistentEffect: async () => void effects.push("effect") } as never;

describe("setup wizard: status", () => {
  it("reports enrolled only for an enabled account with a device id and a token", () => {
    const { wizard } = world();
    expect(wizard.status.resolveConfigured({ cfg: baseCfg })).toBe(false);
    const cfg = { ...baseCfg, channels: { ademu: { accounts: { iris: { deviceId: "d", token: "t" } } } } } as unknown as OpenClawConfig;
    expect(wizard.status.resolveConfigured({ cfg })).toBe(true);
    expect(wizard.status.resolveConfigured({ cfg, accountId: "other" })).toBe(false);
    expect(wizard.credentials).toEqual([]);
  });

  it("defaults the agent name from the default agent's identity, else a plain fallback", () => {
    expect(defaultAgentName(baseCfg)).toBe("Iris");
    expect(defaultAgentName({} as OpenClawConfig)).toBe("Ademú Agent");
  });
});

describe("setup wizard: new enrollment", () => {
  it("runs the ceremony, asks the R3 grant, and returns the whole config with the account + owner entry", async () => {
    const { wizard, control, released } = world();
    const { prompter, log, progress } = fakePrompter({ selects: ["new"], texts: ["Iris"], confirms: [true /* words */, true /* grant */] });
    effects.length = 0;
    const run = Promise.resolve(wizard.finalize!({ cfg: baseCfg, accountId: "iris", credentialValues: {}, runtime: {} as never, prompter: prompter as never, options, forceAllowFrom: false }));
    run.catch(() => {});
    // drive the phone
    for (let i = 0; i < 20 && !log.some((l) => l.kind === "plain"); i++) await new Promise((r) => setTimeout(r, 2));
    expect(log.find((l) => l.kind === "plain")?.message).toContain(`[QR ${QR}]`);
    control.emit({ words: WORDS });
    for (let i = 0; i < 20 && !control.calls.some((c) => c.op === "confirm_words"); i++) await new Promise((r) => setTimeout(r, 2));
    control.finish("enrolled");
    const result = await run;

    const cfg = result!.cfg as unknown as { channels: { ademu: { enabled: boolean; accounts: Record<string, Record<string, unknown>> } }; commands: { ownerAllowFrom: string[] } };
    expect(cfg.channels.ademu.enabled).toBe(true);
    expect(cfg.channels.ademu.accounts.iris).toMatchObject({ enabled: true, agentName: "Iris", deviceId: NEW_DEVICE, agentUserId: NEW_AGENT, ownerUserId: OWNER, token: "adc1_secret_1" });
    expect(cfg.commands.ownerAllowFrom).toEqual([`ademu:${OWNER}`]);
    // routing is the HOST's step on this door (`channels add` asks which agent): the wizard writes no binding
    expect((cfg as unknown as { bindings?: unknown }).bindings).toBeUndefined();
    // the words note shows the daemon words; the grant confirm carries Rider A copy
    expect(log.find((l) => l.kind === "note" && l.title === "Safety words")?.message).toContain(WORDS.join("   "));
    expect(log.filter((l) => l.kind === "confirm").map((l) => l.message)).toEqual([
      "Do these four words match what your phone shows?",
      expect.stringContaining("Say no if the phone belongs to someone other than you."),
    ]);
    expect(log.at(-1)).toMatchObject({ kind: "outro" });
    // every progress handle stopped; lease disposed (control closed, daemon released) once
    expect(progress.every((p) => p.stopped)).toBe(true);
    expect(control.closed).toBe(1);
    expect(released()).toBe(1);
    // authority re-check before createDevice, confirmWords, tokenMint, and the final write
    expect(effects.length).toBeGreaterThanOrEqual(4);
    // the QR never went through `note`
    expect(log.some((l) => l.kind === "note" && l.message?.includes("ademu://"))).toBe(false);
  });

  it("declining the grant writes the account without the owner entry", async () => {
    const { wizard, control } = world();
    const { prompter } = fakePrompter({ selects: ["new"], texts: [""], confirms: [true, false] });
    const run = Promise.resolve(wizard.finalize!({ cfg: baseCfg, accountId: "iris", credentialValues: {}, runtime: {} as never, prompter: prompter as never, options, forceAllowFrom: false }));
    run.catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    control.emit({ words: WORDS });
    await new Promise((r) => setTimeout(r, 5));
    control.finish("enrolled");
    const result = await run;
    const cfg = result!.cfg as unknown as { commands?: unknown; channels: { ademu: { accounts: Record<string, { agentName: string }> } } };
    expect(cfg.commands).toBeUndefined();
    expect(cfg.channels.ademu.accounts.iris?.agentName).toBe("Iris"); // empty text → default name
  });

  it("a words mismatch shows the kind copy and THROWS WizardCancelledError (never a silent success)", async () => {
    const { wizard, control, released } = world();
    const { prompter, log } = fakePrompter({ selects: ["new"], texts: ["Iris"], confirms: [true] });
    control.confirmWordsImpl = async () => {
      throw new (await import("@ademu/adc-control")).ControlError("words_mismatch", "x");
    };
    const run = Promise.resolve(wizard.finalize!({ cfg: baseCfg, accountId: "iris", credentialValues: {}, runtime: {} as never, prompter: prompter as never, options, forceAllowFrom: false }));
    run.catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    control.emit({ words: WORDS });
    await expect(run).rejects.toBeInstanceOf(WizardCancelledError);
    expect(log.some((l) => l.kind === "note" && l.message?.includes("did not match"))).toBe(true);
    expect(released()).toBe(1);
  });

  it("saying no to the words cancels pairing and throws WizardCancelledError", async () => {
    const { wizard, control } = world();
    const { prompter } = fakePrompter({ selects: ["new"], texts: ["Iris"], confirms: [false] });
    const run = Promise.resolve(wizard.finalize!({ cfg: baseCfg, accountId: "iris", credentialValues: {}, runtime: {} as never, prompter: prompter as never, options, forceAllowFrom: false }));
    run.catch(() => {});
    await new Promise((r) => setTimeout(r, 5));
    control.emit({ words: WORDS });
    await expect(run).rejects.toBeInstanceOf(WizardCancelledError);
    expect(control.calls.some((c) => c.op === "cancel_pairing")).toBe(true);
  });

  it("a daemon that cannot start shows the remedy and throws WizardCancelledError", async () => {
    const { wizard } = world({ acquireError: new DaemonUnreachableError("boom", "/var/log/adc.log") });
    const { prompter, log, progress } = fakePrompter({ selects: ["new"] });
    await expect(
      wizard.finalize!({ cfg: baseCfg, accountId: "iris", credentialValues: {}, runtime: {} as never, prompter: prompter as never, options, forceAllowFrom: false }),
    ).rejects.toBeInstanceOf(WizardCancelledError);
    expect(log.find((l) => l.kind === "note")?.message).toContain("/var/log/adc.log");
    expect(progress.every((p) => p.stopped)).toBe(true);
  });
});

describe("setup wizard: the token door and the hardened host", () => {
  const finalize = (wizard: ReturnType<typeof world>["wizard"], prompter: unknown, accountId = "main") =>
    wizard.finalize!({ cfg: baseCfg, accountId, credentialValues: {}, runtime: {} as never, prompter: prompter as never, options, forceAllowFrom: false });

  it("“I have a device token” enrolls from a pasted token via get_self: no enrollment connection, no list_devices, no mint, no QR", async () => {
    const { wizard, control, released } = world();
    const { prompter, log } = fakePrompter({ selects: ["token"], texts: ["adc1_pasted_secret"], confirms: [true] });
    const result = await finalize(wizard, prompter);
    expect(control.calls).toEqual([]);
    expect(log.some((l) => l.kind === "plain")).toBe(false);
    const text = log.find((l) => l.kind === "text");
    expect(text?.message).toContain("device token");
    const cfg = result!.cfg as unknown as { channels: { ademu: { accounts: Record<string, { deviceId: string; agentUserId: string; ownerUserId: string; token: string; agentName: string }> } }; commands: { ownerAllowFrom: string[] } };
    expect(cfg.channels.ademu.accounts.main).toMatchObject({ deviceId: NEW_DEVICE, agentUserId: NEW_AGENT, ownerUserId: OWNER, token: "adc1_pasted_secret", agentName: "Iris" });
    expect(cfg.commands.ownerAllowFrom).toContain(`ademu:${OWNER}`);
    expect(log.at(-1)?.message).toContain("Connected");
    expect(released()).toBe(1);
    // the token never appears in any prompt copy
    expect(log.map((l) => l.message ?? "").join("\n")).not.toContain("adc1_pasted_secret");
  });

  it("the token door is asked BEFORE any daemon lease and asks the prompter for a sensitive text", async () => {
    const order: string[] = [];
    const { wizard } = world();
    const { prompter } = fakePrompter({ selects: ["token"], texts: ["adc1_x"], confirms: [true] });
    const spy = {
      ...prompter,
      select: async (p: { message: string }) => {
        order.push("select");
        return prompter.select(p);
      },
      text: async (p: { message: string; sensitive?: boolean }) => {
        order.push(`text:${p.sensitive ? "sensitive" : "plain"}`);
        return prompter.text(p);
      },
      progress: (label: string) => {
        order.push("progress");
        return prompter.progress(label);
      },
    };
    await finalize(wizard, spy);
    expect(order.slice(0, 3)).toEqual(["select", "text:sensitive", "progress"]);
  });

  it("a rejected token shows the token copy and throws WizardCancelledError; a device with a live mind asks for takeover", async () => {
    const { InvalidTokenError } = await import("@ademu/adc-client");
    const { wizard: wizardRejecting } = world({
      connectSession: async () => {
        throw new InvalidTokenError();
      },
    });
    const { prompter, log, progress } = fakePrompter({ selects: ["token"], texts: ["adc1_bad"] });
    await expect(finalize(wizardRejecting, prompter)).rejects.toBeInstanceOf(WizardCancelledError);
    expect(log.find((l) => l.kind === "note")?.message).toContain("rejected that token");
    expect(progress.every((p) => p.stopped)).toBe(true);
  });

  it("a hardened host (acquire refused with PrivilegeError) prints the three operator commands and the token door, and never throws the raw error", async () => {
    const { PrivilegeError } = await import("@ademu/adc-control");
    const { wizard } = world({ acquireError: new PrivilegeError("permission denied opening the enrollment socket at /run/adc/adc-enroll.sock", "permission_denied") });
    const { prompter, log, progress } = fakePrompter({ selects: ["new"] });
    await expect(finalize(wizard, prompter, "iris")).rejects.toBeInstanceOf(WizardCancelledError);
    const note = log.find((l) => l.kind === "note")?.message ?? "";
    expect(note).toContain("adc agent add");
    expect(note).toContain("adc token mint <device_id> --label openclaw-iris");
    expect(note).toContain("I have a device token");
    expect(note).not.toContain("permission denied opening"); // the client's message is never shown
    expect(progress.every((p) => p.stopped)).toBe(true);
  });

  it("a failure after the mint names the label to revoke (M20 c)", async () => {
    const { wizard, control } = world();
    const { prompter, log } = fakePrompter({ selects: ["new"], texts: ["Iris"], confirms: [true /* words */] });
    // the owner-grant confirm is unscripted → throws after the mint
    const failing = { ...prompter, confirm: async (p: { message: string }) => {
      if (/owner/i.test(p.message)) throw new (await import("../src/ceremony.js")).EnrollmentError("aborted");
      return prompter.confirm(p);
    } };
    const run = finalize(wizard, failing, "iris");
    await new Promise((r) => setTimeout(r, 5));
    control.emit({ words: WORDS });
    await new Promise((r) => setTimeout(r, 5));
    control.finish("enrolled");
    await expect(run).rejects.toBeInstanceOf(WizardCancelledError);
    const note = log.filter((l) => l.kind === "note").at(-1)?.message ?? "";
    expect(note).toContain(`token revoke ${NEW_DEVICE} --label openclaw-iris`);
    expect(control.calls.filter((c) => c.op === "token_mint")).toHaveLength(1);
  });
});

describe("setup wizard: QR presentation", () => {
  it("uses plain in a terminal; link + openUrl + note when deferred or without plain", async () => {
    const qr = { terminal: async (p: string) => `[QR ${p}]`, pngDataUrl: async () => "" };
    const t = fakePrompter({});
    await presentQr(t.prompter as never, qr, QR, false);
    expect(t.log.map((l) => l.kind)).toEqual(["plain"]);

    const d = fakePrompter({ openUrl: true });
    await presentQr(d.prompter as never, qr, QR, true);
    expect(d.log.map((l) => l.kind)).toEqual(["note", "openUrl"]);
    expect(d.log[0]?.message).toContain(QR);
    expect(d.log[0]?.message).not.toContain("[QR");

    const n = fakePrompter({ plain: false });
    await presentQr(n.prompter as never, qr, QR, false);
    expect(n.log.map((l) => l.kind)).toEqual(["note"]);
  });
});
