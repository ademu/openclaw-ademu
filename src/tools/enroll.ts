// Door two (plan T13, reshaped 2026-09-17): the owner-gated `ademu_enroll` chat tool with exactly two
// actions — `start` and `status`. The model never confirms or cancels: the human does, on the browser
// enrollment page (gateway surfaces) or on Yes/No buttons the plugin pushes into the conversation
// (Telegram/Slack/Discord). Everything the user sees — QR, link, words, outcome — is rendered and
// delivered by host code; the model is told where to look and what it must not do. Leases are bound to
// their creator (session key + sender + agent), expire after 3 minutes, and are disposed on every
// terminal path and on plugin shutdown (registerService). The daemon's words are the only words ever
// confirmed; a duplicate token label on a device this ceremony created is our own earlier attempt and
// is replaced without ceremony (the wizard's reconnect path keeps its explicit question).
import type { AdcClient, AdcClientOptions } from "@ademu/adc-client";
import { ControlError, type FourWords, type PairingSnapshot } from "@ademu/adc-control";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { listAgentIds } from "openclaw/plugin-sdk/agent-scope-runtime";
import { readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import { applyRouteBinding, findRouteBinding, RouteBindingConflictError } from "../bindings.js";
import { createEnrollmentLease, EnrollmentError, mintAccountToken, probeIdentity, tokenLabelFor, type EnrollmentLease, type EnrollmentLeaseDeps } from "../ceremony.js";
import { CHANNEL_ID, inspectAdemuAccount, listAdemuAccountIds } from "../config.js";
import { accountExists, applyEnrollment } from "../enroll-config.js";
import { type EnrollmentChannel, type EnrollmentRoute, type Lane, laneFor, registerEnrollmentButtons, routeFromContext } from "../enrollment-channel.js";
import { registerEnrollmentReplyHook } from "../enrollment-reply.js";
import { enrollmentPageUrl, shouldAutoOpenEnrollmentPage } from "../enrollment-page.js";
import { strings } from "../i18n/strings.js";
import type { Qr } from "../qr.js";
import { DaemonAbortedError } from "../monitor/daemon.js";
import { remedyFor } from "../remedies.js";
import { accountIdForAgentName } from "../config.js";

export const TOOL_NAME = "ademu_enroll";

type Action = "start" | "status";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
const text = (msg: string, details: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: msg }], details });

/** The user-facing phases `status`, the page and the channel report. */
export type EnrollmentPhase = "scanning" | "words_shown" | "confirming" | "done" | "failed" | "cancelled" | "expired";

/** One in-progress enrollment, bound to its creator. */
export type ActiveEnrollment = {
  lease: EnrollmentLease;
  /** Bearer capability of the enrollment page (browser surface); ceremony-scoped, in memory only. */
  pageToken: string;
  /** Capability carried by the channel buttons' callback values; ceremony-scoped, in memory only. */
  nonce: string;
  /** Platform id of the words message pushed into the channel; a quoted yes/no reply points at it. */
  wordsMessageId: string | undefined;
  sessionKey: string;
  requesterSenderId: string | undefined;
  agentId: string | undefined;
  agentName: string;
  deviceId: string;
  qrPayload: string;
  pageUrl: string;
  lane: Lane["kind"];
  route: EnrollmentRoute | undefined;
  state: "scanning" | "words" | "confirmed" | "enrolled" | "committing" | "done" | "failed" | "cancelled";
  /** A human decision (yes / no) is in flight: duplicates are refused, never joined. */
  busy: boolean;
  words: FourWords | undefined;
  terminal: Promise<PairingSnapshot>;
  terminalState: string | undefined;
  failure: string | undefined;
  /** Channel-lane pushes, bound to this ceremony's route and config; absent on the page lane. */
  notify: { words: () => Promise<void>; outcome: (text: string) => Promise<void> } | undefined;
  announced: Set<"words" | "outcome">;
};

export type EnrollToolDeps = {
  lease: EnrollmentLeaseDeps;
  connectSession: (opts: AdcClientOptions) => Promise<AdcClient>;
  qr: Qr;
  writeConfig: (mutate: (draft: OpenClawConfig) => OpenClawConfig) => Promise<void>;
  /** Launches the gateway host's browser at `url`; resolves whether the launcher was spawned. */
  openUrl: (url: string) => Promise<boolean>;
  /** Host-side pushes into the conversation (media channels). */
  channel: EnrollmentChannel;
};

/** The account id already exists in the CURRENT config draft (created while the enrollment ran). */
export class AccountExistsError extends Error {
  constructor(readonly accountId: string) {
    super(`Ademú account "${accountId}" already exists`);
    this.name = "AccountExistsError";
  }
}

/** The conversation is not attributed to a configured OpenClaw agent, so the account cannot be routed. */
export class EnrollingAgentUnknownError extends Error {
  constructor() {
    super("the enrolling conversation names no configured OpenClaw agent");
    this.name = "EnrollingAgentUnknownError";
  }
}

/** The host refused to deliver the QR into the conversation (push lane). */
class PushFailedError extends Error {
  constructor(readonly channel: string) {
    super("the enrollment code could not be delivered into the conversation");
    this.name = "PushFailedError";
  }
}

/**
 * The enrolling agent: `ctx.agentId` must be present and name a configured agent (`listAgentIds` and
 * the tool context both carry the host's canonical ids, so plain equality is the comparison). There is
 * NO fallback to a default agent — an account that cannot be routed to its enrolling agent is refused.
 */
export function requireEnrollingAgentId(cfg: OpenClawConfig, agentId: string | undefined): string {
  if (!agentId || !listAgentIds(cfg).includes(agentId)) throw new EnrollingAgentUnknownError();
  return agentId;
}

/**
 * The enrollment must still be the live one right before every durable effect: not cancelled
 * (lease aborted/disposed) and still the registry's entry for its device (not superseded).
 */
function assertStillActive(active: ActiveEnrollment, registry: EnrollmentRegistry): void {
  if (active.lease.disposed || active.lease.signal.aborted || registry.get(active.deviceId) !== active) {
    throw new EnrollmentError("cancelled");
  }
}

/** The phase the page, the buttons and `status` all report, derived from the entry. */
export function phaseOf(active: ActiveEnrollment): EnrollmentPhase {
  switch (active.state) {
    case "done":
      return "done";
    case "failed":
      return "failed";
    case "cancelled":
      return "cancelled";
    default:
      break;
  }
  if (active.lease.disposed) return "expired";
  if (active.state === "scanning") return "scanning";
  if (active.state === "words") return "words_shown";
  return "confirming";
}

function timingSafeFind(entries: Iterable<ActiveEnrollment>, pick: (e: ActiveEnrollment) => string, token: string): ActiveEnrollment | undefined {
  const probe = Buffer.from(token, "utf8");
  let found: ActiveEnrollment | undefined;
  for (const e of entries) {
    const candidate = Buffer.from(pick(e), "utf8");
    if (candidate.length === probe.length && timingSafeEqual(candidate, probe)) found = e;
  }
  return found;
}

export class EnrollmentRegistry {
  readonly #active = new Map<string, ActiveEnrollment>();
  readonly #starting = new Set<string>();
  /**
   * Finished enrollments (done/failed/cancelled/expired), bounded, so the page, the buttons and a chat
   * `status` can report the outcome instead of "nothing in progress". Never consulted by the liveness
   * guard (`get`).
   */
  readonly #recent = new Map<string, ActiveEnrollment>();
  #remember(entry: ActiveEnrollment): void {
    this.#recent.delete(entry.deviceId);
    this.#recent.set(entry.deviceId, entry);
    while (this.#recent.size > 16) this.#recent.delete(this.#recent.keys().next().value as string);
  }

  /** Synchronous admission: one `start` per conversation at a time (released when start settles). */
  reserve(sessionKey: string): boolean {
    if (this.#starting.has(sessionKey)) return false;
    this.#starting.add(sessionKey);
    return true;
  }
  unreserve(sessionKey: string): void {
    this.#starting.delete(sessionKey);
  }

  #prune(): void {
    for (const [id, e] of this.#active) {
      if (e.lease.disposed) {
        this.#active.delete(id);
        this.#remember(e);
      }
    }
  }
  /** The LIVE entry for a device (the liveness guard's view). */
  get(deviceId: string): ActiveEnrollment | undefined {
    this.#prune();
    return this.#active.get(deviceId);
  }
  /** Live or recently finished: the addressing view (a finished entry reports its outcome). */
  lookup(deviceId: string): ActiveEnrollment | undefined {
    return this.get(deviceId) ?? this.#recent.get(deviceId);
  }
  set(entry: ActiveEnrollment): void {
    this.#active.set(entry.deviceId, entry);
  }
  delete(deviceId: string): void {
    const e = this.#active.get(deviceId);
    this.#active.delete(deviceId);
    if (e) this.#remember(e);
  }
  /** Forget `entry` only if it is still the registry's entry for its device (a successor is left alone). */
  forget(entry: ActiveEnrollment): void {
    if (this.#active.get(entry.deviceId) === entry) {
      this.#active.delete(entry.deviceId);
      this.#remember(entry);
    }
  }
  /** The single LIVE enrollment owned by this conversation, if any. */
  forSession(sessionKey: string): ActiveEnrollment | undefined {
    this.#prune();
    for (const e of this.#active.values()) if (e.sessionKey === sessionKey) return e;
    return undefined;
  }
  /** The most recently finished enrollment of this conversation, if any. */
  recentForSession(sessionKey: string): ActiveEnrollment | undefined {
    this.#prune();
    let found: ActiveEnrollment | undefined;
    for (const e of this.#recent.values()) if (e.sessionKey === sessionKey) found = e;
    return found;
  }
  #all(): ActiveEnrollment[] {
    this.#prune();
    return [...this.#recent.values(), ...this.#active.values()];
  }
  /** The live or recent enrollment whose page token is `token` (timing-safe; single-digit entry counts). */
  findByPageToken(token: string): ActiveEnrollment | undefined {
    return timingSafeFind(this.#all(), (e) => e.pageToken, token);
  }
  /** The live or recent enrollment whose button nonce is `nonce` (timing-safe). */
  findByNonce(nonce: string): ActiveEnrollment | undefined {
    return timingSafeFind(this.#all(), (e) => e.nonce, nonce);
  }
  /** The live or recent enrollment whose pushed words message has platform id `id` (plain equality: ids are public). */
  findByWordsMessageId(id: string): ActiveEnrollment | undefined {
    for (const e of this.#all()) if (e.wordsMessageId !== undefined && e.wordsMessageId === id) return e;
    return undefined;
  }
  /** The live enrollment of this conversation that is showing its words (the quoted-body fallback). */
  liveWordsForSession(sessionKey: string): ActiveEnrollment | undefined {
    const e = this.forSession(sessionKey);
    return e && e.state === "words" && e.words ? e : undefined;
  }
  readonly #pending = new Set<Promise<void>>();
  /** Background disposals stay tracked until they settle, so plugin shutdown waits for them too. */
  track(disposal: Promise<void>): void {
    const p = disposal.catch(() => {});
    this.#pending.add(p);
    void p.finally(() => this.#pending.delete(p));
  }
  async disposeAll(reason: string): Promise<void> {
    const all = [...this.#active.values()];
    this.#active.clear();
    await Promise.all([...all.map((e) => e.lease.dispose(reason)), ...this.#pending]);
  }
  get size(): number {
    this.#prune();
    return this.#active.size;
  }
}

/** 160 bits, lowercase hex: URL-safe and matched by `ENROLLMENT_PAGE_TOKEN_RE` in the page module. */
function newPageToken(): string {
  return randomBytes(20).toString("hex");
}
/** 96 bits, lowercase hex: fits Telegram's 64-byte callback data with the `ademu:yes:` prefix. */
function newNonce(): string {
  return randomBytes(12).toString("hex");
}

/**
 * OpenClaw registers a plugin more than once in one gateway process (the startup "full" pass and a
 * fresh "tool-discovery" pass per tool execution). The enrollment page's HTTP route, the button
 * handlers and the tool must see the SAME registry, so it lives on `globalThis`.
 */
const SHARED_REGISTRY_KEY = Symbol.for("ademu.openclaw.enrollmentRegistry");
export function sharedEnrollmentRegistry(): EnrollmentRegistry {
  const globals = globalThis as { [SHARED_REGISTRY_KEY]?: EnrollmentRegistry };
  globals[SHARED_REGISTRY_KEY] ??= new EnrollmentRegistry();
  return globals[SHARED_REGISTRY_KEY];
}

export function createEnrollTool(ctx: OpenClawPluginToolContext, deps: EnrollToolDeps, registry: EnrollmentRegistry) {
  // Every lease disposal — including TTL expiry — is tracked by the registry so plugin shutdown waits for it.
  deps.lease.onDisposing = (_lease, disposal) => registry.track(disposal);
  if (ctx.senderIsOwner !== true) return null;
  return {
    label: strings.enroll.toolLabel,
    name: TOOL_NAME,
    description: strings.enroll.toolDescription,
    parameters: Type.Object({
      action: Type.Enum(["start", "status"], { type: "string" }),
      agentName: Type.Optional(Type.String()),
      accountId: Type.Optional(Type.String()),
      deviceId: Type.Optional(Type.String()),
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
        return startEnrollment({ args, ctx, deps, registry, sessionKey, beforeEffect, signal });
      }

      // `status` (the only other action) addresses this conversation's enrollment — live, or recently
      // finished so a yes/no made on the page or a button is reported here as its outcome.
      const deviceId =
        readStringParam(args, "deviceId") ?? registry.forSession(sessionKey)?.deviceId ?? registry.recentForSession(sessionKey)?.deviceId;
      const active = deviceId ? registry.lookup(deviceId) : undefined;
      if (!active) return text(strings.enroll.toolNoActive, { ok: false });
      // Every bound axis compares EXACTLY, `undefined` included: an enrollment created without a sender
      // or agent axis is not reachable from a call that has one, and vice versa.
      if (active.sessionKey !== sessionKey || active.requesterSenderId !== ctx.requesterSenderId || active.agentId !== ctx.agentId) {
        return text(strings.enroll.toolLeaseMismatch, { ok: false });
      }
      const phase = phaseOf(active);
      if (phase === "expired") registry.delete(active.deviceId);
      return text(strings.enroll.toolStatus(phase, active.agentName), { ok: true, state: phase, deviceId: active.deviceId, lane: active.lane });
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
  /** The tool call's execution signal: a cancelled call aborts a slow daemon acquisition too. */
  signal: AbortSignal | undefined;
}): Promise<ToolResult> {
  const cfg = (p.ctx.runtimeConfig ?? p.ctx.getRuntimeConfig?.() ?? p.ctx.config ?? {}) as OpenClawConfig;
  const agentName = (readStringParam(p.args, "agentName") ?? "").trim() || strings.enroll.agentNameFallback;
  const accountId = normalizeAccountId(readStringParam(p.args, "accountId") ?? accountIdForAgentName(agentName));
  if (accountExists(cfg, accountId)) {
    return text(strings.enroll.toolAccountExists(accountId, listAdemuAccountIds(cfg)), { ok: false, accountId });
  }
  // Routing is decided BEFORE any device exists: the enrolling agent must be a configured agent, and the
  // account's route must not already belong to another agent. Both are re-checked at confirm.
  try {
    requireEnrollingAgentId(cfg, p.ctx.agentId);
  } catch (err) {
    if (err instanceof EnrollingAgentUnknownError) return text(strings.enroll.toolAgentUnknown, { ok: false, state: "agent_unknown" });
    throw err;
  }
  const routed = findRouteBinding(cfg, { channel: CHANNEL_ID, accountId });
  if (routed && routed.agentId !== p.ctx.agentId) {
    return text(strings.enroll.toolRoutingConflict(accountId, routed.agentId), { ok: false, state: "routing_conflict", accountId });
  }
  // The display lane is decided BEFORE any device exists too: a channel where no human can press yes
  // (no buttons, page unreachable) is refused with the way out, and nothing is created.
  const lane = laneFor(routeFromContext(p.ctx), cfg);
  if (lane.kind === "unsupported") {
    return text(strings.enroll.toolChannelUnsupported(lane.route.channel), { ok: false, state: "channel_unsupported", channel: lane.route.channel });
  }
  // SYNCHRONOUS reservation of the conversation before the first await (two concurrent starts cannot
  // both pass the checks below), then authority (an expired call must not even dispose the previous
  // lease), then admission.
  if (!p.registry.reserve(p.sessionKey)) return text(strings.enroll.toolLeaseMismatch, { ok: false, state: "busy" });
  try {
    await p.beforeEffect();
    return await admitAndStart({ ...p, cfg, agentName, accountId, lane });
  } finally {
    p.registry.unreserve(p.sessionKey);
  }
}

async function admitAndStart(p: {
  ctx: OpenClawPluginToolContext;
  deps: EnrollToolDeps;
  registry: EnrollmentRegistry;
  sessionKey: string;
  beforeEffect: () => Promise<void>;
  signal: AbortSignal | undefined;
  cfg: OpenClawConfig;
  agentName: string;
  accountId: string;
  lane: Lane;
}): Promise<ToolResult> {
  const { cfg, agentName, accountId } = p;
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

  const account = inspectAdemuAccount(cfg, accountId);
  let lease: EnrollmentLease;
  try {
    lease = await createEnrollmentLease({
      deps: p.deps.lease,
      accountId,
      identity: account.daemon,
      server: account.server,
      beforeEffect: p.beforeEffect,
      signal: p.signal,
    });
  } catch (err) {
    if (err instanceof DaemonAbortedError) return text(strings.enroll.toolCancelled, { ok: false, state: "cancelled" });
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
    if (err instanceof PushFailedError) return text(strings.enroll.toolPushFailed(err.channel), { ok: false, state: "push_failed" });
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
  cfg: OpenClawConfig;
  lease: EnrollmentLease;
  agentName: string;
  accountId: string;
  lane: Lane;
}): Promise<ToolResult> {
  const { lease, agentName, accountId, lane } = p;
  await p.beforeEffect();
  const created = await lease.control.createDevice({ agent_name: agentName });
  lease.deviceId = created.device_id;

  const pageToken = newPageToken();
  const pageUrl = enrollmentPageUrl(p.cfg, pageToken);
  const route = lane.kind === "push" ? lane.route : undefined;
  const pageReachable = lane.kind === "push" && lane.pageReachable;
  const buttons = lane.kind === "push" && lane.buttons;
  const reply = lane.kind === "push" && lane.reply;
  const entry: ActiveEnrollment = {
    lease,
    pageToken,
    nonce: newNonce(),
    wordsMessageId: undefined,
    sessionKey: p.sessionKey,
    requesterSenderId: p.ctx.requesterSenderId,
    agentId: p.ctx.agentId,
    agentName,
    deviceId: created.device_id,
    qrPayload: created.qr_payload,
    pageUrl,
    lane: lane.kind,
    route,
    state: "scanning",
    busy: false,
    words: undefined,
    terminal: Promise.resolve({ state: "created", qrPayload: created.qr_payload }),
    terminalState: undefined,
    failure: undefined,
    notify: undefined,
    announced: new Set(),
  };
  if (route) {
    const cfg = p.cfg;
    const channel = p.deps.channel;
    entry.notify = {
      words: async () => {
        if (!entry.words || entry.announced.has("words")) return;
        entry.announced.add("words");
        const sent = await channel.pushWords({ cfg, route, words: entry.words, nonce: entry.nonce, buttons, reply, pageUrl: pageReachable ? pageUrl : undefined });
        if (sent.ok) entry.wordsMessageId = sent.messageId;
      },
      outcome: async (msg) => {
        if (entry.announced.has("outcome")) return;
        entry.announced.add("outcome");
        await channel.pushText({ cfg, route, text: msg });
      },
    };
  }
  // Poll on the lease's control connection; snapshots update the entry synchronously. The words are
  // the scan signal: on the push lane they go straight into the conversation, with the buttons.
  entry.terminal = lease.control
    .pollPairing(created.device_id, (s) => {
      if (s.words && !entry.words) {
        entry.words = s.words;
        if (entry.state === "scanning") entry.state = "words";
        void entry.notify?.words();
      }
    }, { signal: lease.signal })
    .then(
      (last) => {
        entry.terminalState = last.state;
        lease.terminal = true;
        if (last.state !== "enrolled") {
          // revoked / retired in the background: release the resources NOW, not at TTL.
          entry.state = "failed";
          p.registry.forget(entry);
          p.registry.track(lease.dispose("pairing-ended"));
          void entry.notify?.outcome(strings.enroll.pushEnded(last.state));
        }
        return last;
      },
      (err: unknown) => {
        // A poll aborted by our own dispose (cancel, supersession, mismatch, TTL) is not a failure of
        // the enrollment: the entry keeps the state/failure that led to the dispose (the page reads them).
        if (!lease.disposed && !lease.signal.aborted) {
          entry.failure = err instanceof Error ? err.name : "poll_failed";
          entry.state = "failed";
          p.registry.forget(entry);
          p.registry.track(lease.dispose("poll-failed"));
          void entry.notify?.outcome(strings.enroll.pushEnded("poll failed"));
        }
        throw err;
      },
    );
  entry.terminal.catch(() => {});
  p.registry.set(entry);

  const dataUrl = await p.deps.qr.pngDataUrl(created.qr_payload);
  let opened = false;
  if (route) {
    // Push lane: the plugin itself puts the code and the exact link into the conversation. A refused
    // delivery ends the ceremony before the user ever saw it (admitAndStart disposes the lease).
    const delivered = await p.deps.channel.pushQr({ cfg: p.cfg, route, agentName, dataUrl, link: created.qr_payload, pageUrl: pageReachable ? pageUrl : undefined });
    if (!delivered) throw new PushFailedError(route.channel);
  } else if (shouldAutoOpenEnrollmentPage(p.cfg, pageUrl)) {
    // Page lane: auto-opened only when its URL is loopback (the user is then on this machine);
    // best-effort, never fatal — the URL in the result is the fallback.
    try {
      opened = await p.deps.openUrl(pageUrl);
    } catch {
      opened = false;
    }
  }
  return text(
    strings.enroll.toolStart({ payload: created.qr_payload, dataUrl, pageUrl, opened, lane: route ? "push" : "page", buttons, reply, pageReachable, channel: route?.channel }),
    {
      ok: true,
      state: "scanning",
      deviceId: created.device_id,
      accountId,
      lane: route ? "push" : "page",
      channel: route?.channel,
      pageUrl,
      pageOpened: opened,
    },
  );
}

export type HumanDecision = { ok: boolean; state: string; message: string };

/**
 * The human's YES — from the enrollment page's button or a channel button, never from the model. Runs
 * the ceremony's confirm path (the daemon's words, the token mint, the config write with the routing
 * binding). Refuses to join an in-flight decision.
 */
export async function confirmByHuman(active: ActiveEnrollment, deps: EnrollToolDeps, registry: EnrollmentRegistry): Promise<HumanDecision> {
  if (active.busy) return { ok: false, state: phaseOf(active), message: strings.enroll.toolStatus(phaseOf(active), active.agentName) };
  active.busy = true;
  try {
    const r = await confirmEnrollment({ active, deps, registry });
    const details = r.details as { ok?: boolean; state?: string };
    return { ok: details.ok === true, state: details.state ?? active.state, message: r.content[0]?.text ?? "" };
  } finally {
    active.busy = false;
  }
}

/**
 * The human's NO ("the words differ") — same surfaces as the yes. Past the final guard the config write
 * is committing and cannot be taken back; terminal enrollments answer idempotently.
 */
export async function cancelByHuman(active: ActiveEnrollment, registry: EnrollmentRegistry): Promise<HumanDecision> {
  const phase = phaseOf(active);
  if (phase === "done" || phase === "failed" || phase === "cancelled" || phase === "expired") {
    return { ok: phase === "cancelled", state: phase, message: strings.enroll.toolStatus(phase, active.agentName) };
  }
  if (active.state === "committing") return { ok: false, state: "committing", message: strings.enroll.toolStatus("confirming", active.agentName) };
  active.state = "cancelled";
  registry.delete(active.deviceId);
  await active.lease.dispose("cancelled");
  void active.notify?.outcome(strings.enroll.toolCancelled);
  return { ok: true, state: "cancelled", message: strings.enroll.toolCancelled };
}

async function confirmEnrollment(p: { active: ActiveEnrollment; deps: EnrollToolDeps; registry: EnrollmentRegistry }): Promise<ToolResult> {
  const { active } = p;
  // The liveness guard runs immediately before each durable effect: the enrollment is still live (not
  // cancelled/superseded) after the awaits that preceded it.
  const guard = async () => {
    assertStillActive(active, p.registry);
  };
  const common = {
    control: active.lease.control,
    connectSession: p.deps.connectSession,
    accountId: normalizeAccountId(active.lease.accountId),
    beforeEffect: guard,
    signal: active.lease.signal,
  };
  try {
    if (active.state === "words" || active.state === "scanning") {
      const words = active.words; // the DAEMON's words, never anyone's typing
      if (!words) return text(strings.enroll.toolStatus("scanning", active.agentName), { ok: false, state: "scanning" });
      await guard();
      try {
        await active.lease.control.confirmWords({ device_id: active.deviceId, words });
      } catch (err) {
        if (err instanceof ControlError && err.code === "words_mismatch") throw new EnrollmentError("words_mismatch");
        throw err;
      }
      active.state = "confirmed";
      let last: PairingSnapshot;
      try {
        last = await active.terminal;
      } catch (err) {
        // A cancel/supersession aborts the poll: report it as cancelled, not as a transport error.
        if (active.lease.disposed || active.lease.signal.aborted) throw new EnrollmentError("cancelled");
        throw err;
      }
      if (last.state !== "enrolled") throw new EnrollmentError(last.state === "revoked" || last.state === "retired" ? last.state : "unexpected_state");
      active.state = "enrolled";
    }
    if (active.state !== "enrolled") {
      return text(strings.enroll.toolStatus(phaseOf(active), active.agentName), { ok: false, state: phaseOf(active) });
    }
    assertStillActive(active, p.registry);
    let minted: { token: string; tokenId: string };
    try {
      minted = await mintAccountToken({ ...common, deviceId: active.deviceId });
    } catch (err) {
      if (!(err instanceof EnrollmentError) || err.reason !== "label_exists") throw err;
      // This device was created by THIS ceremony seconds ago, so the only token that can carry our label
      // is our own earlier attempt (a retry after a retryable failure). Replace it: there is no foreign
      // credential to protect, and the user must never hear about tokens.
      await guard();
      const m = await active.lease.control.tokenMint({ device_id: active.deviceId, label: tokenLabelFor(common.accountId), replace: true });
      minted = { token: m.token, tokenId: m.token_id };
    }
    const info = await active.lease.control.daemonInfo();
    if (!info.session_socket_path) throw new EnrollmentError("daemon_too_old");
    const identity = await probeIdentity({ ...common, deviceId: active.deviceId, token: minted.token, sessionSocketPath: info.session_socket_path });

    await guard();
    // The final guard runs INSIDE the mutation callback (when the host hands us its current draft),
    // and from here the enrollment is `committing`: a NO can no longer claim "nothing written".
    active.state = "committing";
    let routedAgentId = "";
    await p.deps.writeConfig((draft) => {
      assertStillActive(active, p.registry);
      // Re-check against the CURRENT draft: an account created while this enrollment ran is never overwritten.
      if (accountExists(draft, common.accountId)) throw new AccountExistsError(common.accountId);
      // The enrolling agent (captured at start) must still be configured; the route is written in the SAME
      // mutation as the account so the account never exists unrouted. A conflict throws → nothing written.
      routedAgentId = requireEnrollingAgentId(draft, active.agentId);
      const enrolled = applyEnrollment(draft, {
        accountId: common.accountId,
        agentName: active.agentName,
        deviceId: active.deviceId,
        agentUserId: identity.agentUserId,
        ownerUserId: identity.ownerUserId,
        token: minted.token,
        grantOwnerAuthority: true, // the initiator is owner-by-scope and confirmed the words from the same phone
      });
      return applyRouteBinding(enrolled, { channel: CHANNEL_ID, accountId: common.accountId, agentId: routedAgentId });
    });
    active.state = "done";
    // Tool-door accelerator: the account is committed → publish the setup-spawned daemon now.
    if (active.lease.daemonLease.mode === "owned") {
      try {
        p.deps.lease.daemons.promotePendingPublication(active.lease.daemonLease.identity.dataDir);
      } catch {
        /* the runtime's next acquire promotes it anyway */
      }
    }
    p.registry.forget(active);
    await active.lease.dispose("done");
    void active.notify?.outcome(strings.enroll.pushEnrolled(active.agentName));
    return text(`${strings.enroll.toolConfirmed(active.agentName)}\n\n${strings.enroll.toolRouted(routedAgentId, common.accountId)}`, {
      ok: true,
      state: "done",
      accountId: common.accountId,
      deviceId: active.deviceId,
      routing: { agentId: routedAgentId, accountId: common.accountId },
    });
  } catch (err) {
    const cancelled =
      (err instanceof EnrollmentError && (err.reason === "cancelled" || err.reason === "aborted")) ||
      (!(err instanceof EnrollmentError) && (active.lease.disposed || active.lease.signal.aborted));
    if (cancelled) {
      // It failed because the enrollment was cancelled/superseded underneath us: release, report cancelled.
      p.registry.forget(active);
      await active.lease.dispose("cancelled");
      return text(strings.enroll.toolCancelled, { ok: false, state: "cancelled" });
    }
    const fail = async (reason: string, msg: string, details: Record<string, unknown>) => {
      active.state = "failed";
      active.failure = reason;
      p.registry.forget(active);
      await active.lease.dispose(reason);
      void active.notify?.outcome(msg);
      return text(msg, { ok: false, ...details });
    };
    if (err instanceof AccountExistsError) {
      return fail("account-exists", strings.enroll.toolAccountExists(err.accountId, [err.accountId]), { state: "account_exists" });
    }
    if (err instanceof EnrollingAgentUnknownError) {
      // The agent roster changed underneath the ceremony: the account is NOT written unrouted.
      return fail("agent-unknown", strings.enroll.toolAgentUnknown, { state: "agent_unknown" });
    }
    if (err instanceof RouteBindingConflictError) {
      return fail("routing-conflict", strings.enroll.toolRoutingConflict(err.accountId, err.existingAgentId), { state: "routing_conflict", accountId: err.accountId });
    }
    if (err instanceof EnrollmentError) {
      if (err.reason === "words_mismatch") return fail("words_mismatch", strings.enroll.wordsMismatch, { state: "words_mismatch" });
      if (err.reason === "device_attached") return text(strings.enroll.deviceAttachedRefused, { ok: false, state: "device_attached" });
    }
    // Anything else is terminal for this enrollment: release the daemon/control resources now,
    // not at TTL.
    active.state = "failed";
    active.failure = err instanceof Error ? err.name : "confirm_failed";
    p.registry.forget(active);
    await active.lease.dispose("confirm-failed");
    void active.notify?.outcome(strings.enroll.pushEnded("failed"));
    const remedy = remedyFor(err);
    if (remedy) return text(strings.enroll.toolUnavailable(remedy), { ok: false, state: "failed" });
    throw err;
  }
}

export function registerEnrollTool(api: OpenClawPluginApi, deps: EnrollToolDeps, registry = sharedEnrollmentRegistry()): EnrollmentRegistry {
  api.registerTool((ctx) => createEnrollTool(ctx, deps, registry) as never, { name: TOOL_NAME });
  api.registerService({
    id: "ademu-enroll-leases",
    start: () => {},
    stop: async () => {
      await registry.disposeAll("plugin-stop");
    },
  });
  // The channel buttons' yes/no and the quoted-reply yes/no land here, on the same registry and the
  // same confirm/cancel paths.
  const human = {
    registry,
    confirm: (active: ActiveEnrollment) => confirmByHuman(active, deps, registry),
    cancel: (active: ActiveEnrollment) => cancelByHuman(active, registry),
  };
  registerEnrollmentButtons(api, human);
  registerEnrollmentReplyHook(api, human);
  return registry;
}
