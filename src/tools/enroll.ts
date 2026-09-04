// Door two (plan T13): the owner-gated `ademu_enroll` chat tool. Actions: start (QR as a markdown
// data-URL image + the ademu:// link) → wait (the daemon's four words) → confirm (the human said they
// match) → config write via mutateConfigFile. Leases are bound to their creator (sessionKey + a
// random leaseToken), expire after 3 minutes, and are disposed on every terminal path and on plugin
// shutdown (registerService). The model never supplies the words: `confirm` re-reads them from the
// daemon-fed snapshot held by the lease.
import type { AdcClient, AdcClientOptions } from "@ademu/adc-client";
import { ControlError, type FourWords, type PairingSnapshot } from "@ademu/adc-control";
import { randomBytes } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { optionalPositiveIntegerSchema, readPositiveIntegerParam, readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import { createEnrollmentLease, EnrollmentError, mintAccountToken, probeIdentity, tokenLabelFor, type EnrollmentLease, type EnrollmentLeaseDeps } from "../ceremony.js";
import { inspectAdemuAccount, listAdemuAccountIds } from "../config.js";
import { accountExists, applyEnrollment } from "../enroll-config.js";
import { strings } from "../i18n/strings.js";
import type { Qr } from "../qr.js";
import { remedyFor } from "../remedies.js";
import { accountIdForAgentName } from "../config.js";

export const TOOL_NAME = "ademu_enroll";

type Action = "start" | "wait" | "confirm" | "replace_token" | "cancel" | "status";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
const text = (msg: string, details: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: msg }], details });

/** One in-progress enrollment, bound to its creator. */
type ActiveEnrollment = {
  lease: EnrollmentLease;
  leaseToken: string;
  sessionKey: string;
  requesterSenderId: string | undefined;
  agentId: string | undefined;
  agentName: string;
  deviceId: string;
  qrPayload: string;
  state: "scanning" | "words" | "confirmed" | "enrolled" | "minting_blocked" | "done" | "failed";
  words: FourWords | undefined;
  terminal: Promise<PairingSnapshot>;
  terminalState: string | undefined;
  failure: string | undefined;
};

export type EnrollToolDeps = {
  lease: EnrollmentLeaseDeps;
  connectSession: (opts: AdcClientOptions) => Promise<AdcClient>;
  qr: Qr;
  writeConfig: (mutate: (draft: OpenClawConfig) => OpenClawConfig) => Promise<void>;
};

export class EnrollmentRegistry {
  readonly #active = new Map<string, ActiveEnrollment>();

  #prune(): void {
    for (const [id, e] of this.#active) if (e.lease.disposed) this.#active.delete(id);
  }
  get(deviceId: string): ActiveEnrollment | undefined {
    this.#prune();
    return this.#active.get(deviceId);
  }
  set(entry: ActiveEnrollment): void {
    this.#active.set(entry.deviceId, entry);
  }
  delete(deviceId: string): void {
    this.#active.delete(deviceId);
  }
  /** The single enrollment owned by this conversation, if any. */
  forSession(sessionKey: string): ActiveEnrollment | undefined {
    this.#prune();
    for (const e of this.#active.values()) if (e.sessionKey === sessionKey) return e;
    return undefined;
  }
  async disposeAll(reason: string): Promise<void> {
    const all = [...this.#active.values()];
    this.#active.clear();
    await Promise.all(all.map((e) => e.lease.dispose(reason)));
  }
  get size(): number {
    this.#prune();
    return this.#active.size;
  }
}

function newLeaseToken(): string {
  return randomBytes(12).toString("base64url");
}

export function createEnrollTool(ctx: OpenClawPluginToolContext, deps: EnrollToolDeps, registry: EnrollmentRegistry) {
  if (ctx.senderIsOwner !== true) return null;
  return {
    label: strings.enroll.toolLabel,
    name: TOOL_NAME,
    description: strings.enroll.toolDescription,
    parameters: Type.Object({
      action: Type.Enum(["start", "wait", "confirm", "replace_token", "cancel", "status"], { type: "string" }),
      agentName: Type.Optional(Type.String()),
      accountId: Type.Optional(Type.String()),
      deviceId: Type.Optional(Type.String()),
      leaseToken: Type.Optional(Type.String()),
      timeoutMs: optionalPositiveIntegerSchema(),
    }),
    execute: async (_toolCallId: string, rawArgs: unknown, signal?: AbortSignal): Promise<ToolResult> => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const action = (readStringParam(args, "action") ?? "start") as Action;
      const beforeEffect = async () => {
        if (!signal || signal.aborted) throw new Error(strings.enroll.authorityExpired);
      };
      if (!ctx.sessionKey) return text(strings.enroll.toolNeedsSession, { ok: false });
      const sessionKey = ctx.sessionKey;

      if (action === "start") {
        return startEnrollment({ args, ctx, deps, registry, sessionKey, beforeEffect });
      }

      // Every other action addresses an existing lease bound to this conversation + token.
      const deviceId = readStringParam(args, "deviceId") ?? registry.forSession(sessionKey)?.deviceId;
      const active = deviceId ? registry.get(deviceId) : undefined;
      if (!active) return text(strings.enroll.toolNoActive, { ok: false });
      const leaseToken = readStringParam(args, "leaseToken");
      // Every bound axis compares EXACTLY, `undefined` included: a lease created without a sender or
      // agent axis is not reachable from a call that has one, and vice versa.
      const axisMismatch =
        active.sessionKey !== sessionKey ||
        leaseToken !== active.leaseToken ||
        active.requesterSenderId !== ctx.requesterSenderId ||
        active.agentId !== ctx.agentId;
      if (axisMismatch) {
        return text(strings.enroll.toolLeaseMismatch, { ok: false });
      }
      if (active.lease.disposed) {
        registry.delete(active.deviceId);
        return text(strings.enroll.toolNoActive, { ok: false, expired: true });
      }

      switch (action) {
        case "status":
          return text(strings.enroll.toolStatus(active.state), { ok: true, state: active.state, deviceId: active.deviceId });
        case "cancel": {
          registry.delete(active.deviceId);
          await active.lease.dispose("cancelled");
          return text(strings.enroll.toolCancelled, { ok: true, cancelled: true });
        }
        case "wait": {
          const timeoutMs = readPositiveIntegerParam(args, "timeoutMs") ?? 30_000;
          const words = await waitForWords(active, Math.min(timeoutMs, 120_000));
          if (!words) return text(strings.enroll.toolWaiting, { ok: true, state: active.state, deviceId: active.deviceId, leaseToken: active.leaseToken });
          return text(strings.enroll.toolWords(words), { ok: true, state: "words", deviceId: active.deviceId, leaseToken: active.leaseToken });
        }
        case "confirm":
          return confirmEnrollment({ active, ctx, deps, registry, beforeEffect, replace: false });
        case "replace_token":
          if (active.state !== "minting_blocked") return text(strings.enroll.toolReplaceNotAllowed, { ok: false, state: active.state });
          return confirmEnrollment({ active, ctx, deps, registry, beforeEffect, replace: true });
        default:
          return text(strings.enroll.toolNoActive, { ok: false });
      }
    },
  };
}

async function startEnrollment(p: {
  args: Record<string, unknown>;
  ctx: OpenClawPluginToolContext;
  deps: EnrollToolDeps;
  registry: EnrollmentRegistry;
  sessionKey: string;
  beforeEffect: () => Promise<void>;
}): Promise<ToolResult> {
  const cfg = (p.ctx.runtimeConfig ?? p.ctx.getRuntimeConfig?.() ?? p.ctx.config ?? {}) as OpenClawConfig;
  const agentName = (readStringParam(p.args, "agentName") ?? "").trim() || strings.enroll.agentNameFallback;
  const accountId = normalizeAccountId(readStringParam(p.args, "accountId") ?? accountIdForAgentName(agentName));
  if (accountExists(cfg, accountId)) {
    return text(strings.enroll.toolAccountExists(accountId, listAdemuAccountIds(cfg)), { ok: false, accountId });
  }
  // One enrollment per conversation at a time. Only the SAME creator tuple (session, sender, agent)
  // may supersede it; anyone else sharing the session key is refused instead of disposing it.
  const previous = p.registry.forSession(p.sessionKey);
  if (previous) {
    if (previous.requesterSenderId !== p.ctx.requesterSenderId || previous.agentId !== p.ctx.agentId) {
      return text(strings.enroll.toolLeaseMismatch, { ok: false, state: "busy" });
    }
    p.registry.delete(previous.deviceId);
    await previous.lease.dispose("superseded");
  }

  await p.beforeEffect();
  const account = inspectAdemuAccount(cfg, accountId);
  let lease: EnrollmentLease;
  try {
    lease = await createEnrollmentLease({
      deps: p.deps.lease,
      accountId,
      identity: account.daemon,
      server: account.server,
      beforeEffect: p.beforeEffect,
    });
  } catch (err) {
    // Known acquisition failures become fixed, instruct-only remedy text (never an install attempt).
    const remedy = remedyFor(err);
    if (remedy) return text(strings.enroll.toolUnavailable(remedy), { ok: false, state: "unavailable" });
    throw err;
  }
  // From here every failure disposes the lease exactly once (cancel pairing → close → release).
  try {
    return await startWithLease({ ...p, lease, agentName, accountId });
  } catch (err) {
    if (lease.deviceId) p.registry.delete(lease.deviceId);
    await lease.dispose("start-failed");
    const remedy = remedyFor(err);
    if (remedy) return text(strings.enroll.toolUnavailable(remedy), { ok: false, state: "unavailable" });
    throw err;
  }
}

async function startWithLease(p: {
  ctx: OpenClawPluginToolContext;
  deps: EnrollToolDeps;
  registry: EnrollmentRegistry;
  sessionKey: string;
  beforeEffect: () => Promise<void>;
  lease: EnrollmentLease;
  agentName: string;
  accountId: string;
}): Promise<ToolResult> {
  const { lease, agentName, accountId } = p;
  await p.beforeEffect();
  const created = await lease.control.createDevice({ agent_name: agentName });
  lease.deviceId = created.device_id;

  const entry: ActiveEnrollment = {
    lease,
    leaseToken: newLeaseToken(),
    sessionKey: p.sessionKey,
    requesterSenderId: p.ctx.requesterSenderId,
    agentId: p.ctx.agentId,
    agentName,
    deviceId: created.device_id,
    qrPayload: created.qr_payload,
    state: "scanning",
    words: undefined,
    terminal: Promise.resolve({ state: "created", qrPayload: created.qr_payload }),
    terminalState: undefined,
    failure: undefined,
  };
  // Poll on the lease's control connection; snapshots update the entry synchronously.
  entry.terminal = lease.control
    .pollPairing(created.device_id, (s) => {
      if (s.words && !entry.words) {
        entry.words = s.words;
        if (entry.state === "scanning") entry.state = "words";
      }
    }, { signal: lease.signal })
    .then(
      (last) => {
        entry.terminalState = last.state;
        lease.terminal = true;
        if (last.state !== "enrolled") {
          // revoked / retired in the background: release the resources NOW, not at TTL.
          entry.state = "failed";
          p.registry.delete(entry.deviceId);
          void lease.dispose("pairing-ended").catch(() => {});
        }
        return last;
      },
      (err: unknown) => {
        entry.failure = err instanceof Error ? err.name : "poll_failed";
        entry.state = "failed";
        if (!lease.disposed) {
          p.registry.delete(entry.deviceId);
          void lease.dispose("poll-failed").catch(() => {});
        }
        throw err;
      },
    );
  entry.terminal.catch(() => {});
  p.registry.set(entry);

  const dataUrl = await p.deps.qr.pngDataUrl(created.qr_payload);
  return text(strings.enroll.toolStart(created.qr_payload, dataUrl), {
    ok: true,
    state: "scanning",
    deviceId: created.device_id,
    accountId,
    leaseToken: entry.leaseToken,
  });
}

async function waitForWords(active: ActiveEnrollment, timeoutMs: number): Promise<FourWords | undefined> {
  if (active.words) return active.words;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (active.words) return active.words;
    if (active.state === "failed") throw new EnrollmentError(active.terminalState === "revoked" || active.terminalState === "retired" ? active.terminalState : "unexpected_state");
    await new Promise((r) => setTimeout(r, 250));
  }
  return active.words;
}

async function confirmEnrollment(p: {
  active: ActiveEnrollment;
  ctx: OpenClawPluginToolContext;
  deps: EnrollToolDeps;
  registry: EnrollmentRegistry;
  beforeEffect: () => Promise<void>;
  replace: boolean;
}): Promise<ToolResult> {
  const { active } = p;
  const common = {
    control: active.lease.control,
    connectSession: p.deps.connectSession,
    accountId: normalizeAccountId(active.lease.accountId),
    beforeEffect: p.beforeEffect,
    signal: active.lease.signal,
  };
  try {
    if (active.state === "words" || active.state === "scanning") {
      const words = active.words; // the DAEMON's words, never the model's
      if (!words) return text(strings.enroll.toolWaiting, { ok: false, state: active.state });
      await p.beforeEffect();
      try {
        await active.lease.control.confirmWords({ device_id: active.deviceId, words });
      } catch (err) {
        if (err instanceof ControlError && err.code === "words_mismatch") throw new EnrollmentError("words_mismatch");
        throw err;
      }
      active.state = "confirmed";
      const last = await active.terminal;
      if (last.state !== "enrolled") throw new EnrollmentError(last.state === "revoked" || last.state === "retired" ? last.state : "unexpected_state");
      active.state = "enrolled";
    }
    if (active.state !== "enrolled" && active.state !== "minting_blocked") {
      return text(strings.enroll.toolStatus(active.state), { ok: false, state: active.state });
    }
    let minted: { token: string; tokenId: string };
    if (p.replace) {
      // Explicit second consent already given (the dedicated action): rotate directly.
      await p.beforeEffect();
      const m = await active.lease.control.tokenMint({ device_id: active.deviceId, label: tokenLabelFor(common.accountId), replace: true });
      minted = { token: m.token, tokenId: m.token_id };
    } else {
      try {
        minted = await mintAccountToken({ ...common, deviceId: active.deviceId });
      } catch (err) {
        if (err instanceof EnrollmentError && err.reason === "label_exists") {
          active.state = "minting_blocked";
          return text(strings.enroll.toolLabelExists, { ok: false, state: "label_exists", deviceId: active.deviceId, leaseToken: active.leaseToken });
        }
        throw err;
      }
    }
    const info = await active.lease.control.daemonInfo();
    if (!info.session_socket_path) throw new EnrollmentError("daemon_too_old");
    const identity = await probeIdentity({ ...common, deviceId: active.deviceId, token: minted.token, sessionSocketPath: info.session_socket_path });

    await p.beforeEffect();
    await p.deps.writeConfig((draft) =>
      applyEnrollment(draft, {
        accountId: common.accountId,
        agentName: active.agentName,
        deviceId: active.deviceId,
        agentUserId: identity.agentUserId,
        ownerUserId: identity.ownerUserId,
        token: minted.token,
        grantOwnerAuthority: true, // the initiator is owner-by-scope and confirmed the words from the same phone
      }),
    );
    active.state = "done";
    // Tool-door accelerator: the account is committed → publish the setup-spawned daemon now.
    if (active.lease.daemonLease.mode === "owned") {
      try {
        p.deps.lease.daemons.promotePendingPublication(active.lease.daemonLease.identity.dataDir);
      } catch {
        /* the runtime's next acquire promotes it anyway */
      }
    }
    p.registry.delete(active.deviceId);
    await active.lease.dispose("done");
    return text(strings.enroll.toolConfirmed(active.agentName), { ok: true, state: "done", accountId: common.accountId, deviceId: active.deviceId });
  } catch (err) {
    if (err instanceof EnrollmentError) {
      if (err.reason === "words_mismatch") {
        p.registry.delete(active.deviceId);
        await active.lease.dispose("words-mismatch");
        return text(strings.enroll.wordsMismatch, { ok: false, state: "words_mismatch" });
      }
      if (err.reason === "device_attached") return text(strings.enroll.deviceAttachedRefused, { ok: false, state: "device_attached" });
    }
    // Anything else is terminal for this enrollment: release the daemon/control resources now,
    // not at TTL.
    p.registry.delete(active.deviceId);
    await active.lease.dispose("confirm-failed");
    const remedy = remedyFor(err);
    if (remedy) return text(strings.enroll.toolUnavailable(remedy), { ok: false, state: "failed" });
    throw err;
  }
}

export function registerEnrollTool(api: OpenClawPluginApi, deps: EnrollToolDeps, registry = new EnrollmentRegistry()): EnrollmentRegistry {
  api.registerTool((ctx) => createEnrollTool(ctx, deps, registry) as never, { name: TOOL_NAME });
  api.registerService({
    id: "ademu-enroll-leases",
    start: () => {},
    stop: async () => {
      await registry.disposeAll("plugin-stop");
    },
  });
  return registry;
}
