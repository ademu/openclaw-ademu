// Door two (plan T13, reshaped 2026-09-17, page-only since 2026-09-23): the owner-gated `ademu_enroll`
// chat tool with exactly two actions — `start` and `status`. The model never confirms or cancels: the
// human does, on the browser enrollment page the plugin opens on the gateway machine (the user is
// assumed to have direct access to that machine; chat-channel pushes live on another branch). Everything
// the user sees — QR, link, words, outcome — is rendered by host code; the model is told where to look
// and what it must not do. Leases are bound to their creator (session key + sender + agent), expire
// after 3 minutes, and are disposed on every terminal path and on plugin shutdown (registerService).
// The daemon's words are the only words ever confirmed. The ceremony runs over the daemon's
// ENROLLMENT socket (ADC Phase 3b Phase B): `daemon_info` is read BEFORE the mint (the first mint
// closes the connection), a mint whose reply was lost or whose label is taken is never retried with
// `replace` (the operator mints a fresh label at the CLI and pastes it into the wizard's token door),
// a config write that fails after the mint names the label to revoke, and a hardened host with no
// ceremony possible answers with the operator ceremony (spec M20 a–d).
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
import { createDeviceOrRefuse, createEnrollmentLease, EnrollmentError, mintAccountToken, probeIdentity, tokenLabelFor, type EnrollmentLease, type EnrollmentLeaseDeps } from "../ceremony.js";
import { CHANNEL_ID, inspectAdemuAccountForEnrollment, listAdemuAccountIds } from "../config.js";
import { accountExists, applyEnrollment } from "../enroll-config.js";
import { enrollmentPageBaseUrl, enrollmentPageUrl, isLoopbackEnrollmentPageUrl } from "../enrollment-page.js";
import { strings } from "../i18n/strings.js";
import type { Qr } from "../qr.js";
import { DaemonAbortedError } from "../monitor/daemon.js";
import { revokeLabelCommand, type OperatorContext } from "../operator.js";
import { remedyFor } from "../remedies.js";
import { accountIdForAgentName } from "../config.js";

export const TOOL_NAME = "ademu_enroll";

type Action = "start" | "status";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> };
const text = (msg: string, details: Record<string, unknown>): ToolResult => ({ content: [{ type: "text", text: msg }], details });

/** The user-facing phases `status` and the page report. */
export type EnrollmentPhase = "scanning" | "words_shown" | "confirming" | "done" | "failed" | "cancelled" | "expired";

/** One in-progress enrollment, bound to its creator. */
export type ActiveEnrollment = {
  lease: EnrollmentLease;
  /**
   * Bearer capability of the enrollment page; ceremony-scoped, in memory only. It reaches exactly one
   * place: the browser the plugin opens (`pageUrl`). It is never part of a tool result.
   */
  pageToken: string;
  /** A browser fetched the page shell at least once (set by the route); until then `status` may re-open it. */
  pageServed: boolean;
  /** When the launcher was last asked to open the page (`deps.lease.now()` clock), for the re-open grace. */
  lastOpenedAt: number;
  sessionKey: string;
  requesterSenderId: string | undefined;
  agentId: string | undefined;
  agentName: string;
  deviceId: string;
  qrPayload: string;
  pageUrl: string;
  state: "scanning" | "words" | "confirmed" | "enrolled" | "committing" | "done" | "failed" | "cancelled";
  /** A human decision (yes / no) is in flight: duplicates are refused, never joined. */
  busy: boolean;
  words: FourWords | undefined;
  terminal: Promise<PairingSnapshot>;
  terminalState: string | undefined;
  failure: string | undefined;
  /** The human-facing outcome of a failed yes (a remedy, a revoke instruction) for the page's failed screen. */
  failureMessage?: string | undefined;
};

export type EnrollToolDeps = {
  lease: EnrollmentLeaseDeps;
  connectSession: (opts: AdcClientOptions) => Promise<AdcClient>;
  qr: Qr;
  writeConfig: (mutate: (draft: OpenClawConfig) => OpenClawConfig) => Promise<void>;
  /** Launches the gateway host's browser at `url`; resolves whether the launcher was spawned. */
  openUrl: (url: string) => Promise<boolean>;
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

/** The gateway host's browser could not be launched: the ceremony has no display, so it must not run. */
class PageOpenFailedError extends Error {
  constructor() {
    super("the enrollment page could not be opened in a browser on the gateway machine");
    this.name = "PageOpenFailedError";
  }
}

/** `status` re-opens a never-served page no sooner than this after the last launch (the browser may still be starting). */
export const PAGE_REOPEN_GRACE_MS = 5_000;

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

/** The phase the page and `status` both report, derived from the entry. */
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
   * Finished enrollments (done/failed/cancelled/expired), bounded, so the page and a chat `status` can
   * report the outcome instead of "nothing in progress". Never consulted by the liveness guard (`get`).
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

/**
 * OpenClaw registers a plugin more than once in one gateway process (the startup "full" pass and a
 * fresh "tool-discovery" pass per tool execution). The enrollment page's HTTP route and the tool must
 * see the SAME registry, so it lives on `globalThis`.
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
      // finished so a yes/no made on the page is reported here as its outcome.
      const deviceId =
        readStringParam(args, "deviceId") ?? registry.forSession(sessionKey)?.deviceId ?? registry.recentForSession(sessionKey)?.deviceId;
      const active = deviceId ? registry.lookup(deviceId) : undefined;
      if (!active) return text(strings.enroll.toolNoActive, { ok: false });
      // Every bound axis compares EXACTLY, `undefined` included: an enrollment created without a sender
      // or agent axis is not reachable from a call that has one, and vice versa.
      if (active.sessionKey !== sessionKey || active.requesterSenderId !== ctx.requesterSenderId || active.agentId !== ctx.agentId) {
        return text(strings.enroll.toolLeaseMismatch, { ok: false });
      }
      return reportStatus(active, deps, registry);
    },
  };
}

/**
 * The phase report both `status` and a `start` that finds a live ceremony give. If the launcher said it
 * spawned but no browser ever fetched the page, the page is opened again here — the plugin's own
 * fallback, so the URL still never travels through the model.
 */
async function reportStatus(active: ActiveEnrollment, deps: EnrollToolDeps, registry: EnrollmentRegistry, opts: { alreadyRunning?: boolean } = {}): Promise<ToolResult> {
  const phase = phaseOf(active);
  if (phase === "expired") registry.delete(active.deviceId);
  let reopened = false;
  if (phase === "scanning" && !active.pageServed && deps.lease.now() - active.lastOpenedAt >= PAGE_REOPEN_GRACE_MS) {
    active.lastOpenedAt = deps.lease.now();
    try {
      reopened = await deps.openUrl(active.pageUrl);
    } catch {
      reopened = false;
    }
  }
  const lead = opts.alreadyRunning ? `${strings.enroll.toolStartAlreadyRunning} ` : "";
  return text(`${lead}${strings.enroll.toolStatus(phase, active.agentName)}${reopened ? ` ${strings.enroll.toolStatusReopened}` : ""}`, {
    // `ok` answers the action asked for: a `status` succeeded; a `start` that started nothing did not.
    ok: !opts.alreadyRunning,
    state: phase,
    deviceId: active.deviceId,
    ...(opts.alreadyRunning ? { alreadyRunning: true } : {}),
    ...(reopened ? { pageReopened: true } : {}),
  });
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
  // The display is decided BEFORE any device exists too: the page is shown in a browser on this machine
  // or not at all. A gateway bound to a non-loopback host has no such page → refused, nothing created.
  if (!isLoopbackEnrollmentPageUrl(enrollmentPageBaseUrl(cfg))) {
    return text(strings.enroll.toolPageUnreachable, { ok: false, state: "page_unreachable" });
  }
  // SYNCHRONOUS reservation of the conversation before the first await (two concurrent starts cannot
  // both pass the checks below), then authority (an expired call must not even dispose the previous
  // lease), then admission.
  if (!p.registry.reserve(p.sessionKey)) return text(strings.enroll.toolLeaseMismatch, { ok: false, state: "busy" });
  try {
    await p.beforeEffect();
    return await admitAndStart({ ...p, cfg, agentName, accountId });
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
}): Promise<ToolResult> {
  const { cfg, agentName, accountId } = p;
  // One enrollment per conversation at a time, and a live one is the HUMAN's to finish or cancel (on
  // the page). `start` never disposes it — the model has no cancel action, and this must not be one in
  // disguise. The same creator tuple (session, sender, agent) is answered as `status` would answer,
  // re-opening the page if no browser ever showed it; anyone else sharing the session key is refused.
  const previous = p.registry.forSession(p.sessionKey);
  if (previous) {
    if (previous.requesterSenderId !== p.ctx.requesterSenderId || previous.agentId !== p.ctx.agentId) {
      return text(strings.enroll.toolLeaseMismatch, { ok: false, state: "busy" });
    }
    return reportStatus(previous, p.deps, p.registry, { alreadyRunning: true });
  }

  const account = inspectAdemuAccountForEnrollment(cfg, accountId);
  // The operator context: a hardened host's refusal or a full enrollment budget answer with the
  // operator ceremony naming this host's commands (M20 d).
  const operator: OperatorContext = { identity: account.daemon, label: tokenLabelFor(accountId), agentName };
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
    const remedy = remedyFor(err, operator);
    if (remedy) return text(strings.enroll.toolUnavailable(remedy), { ok: false, state: "unavailable" });
    throw err;
  }
  // From here every failure disposes the lease exactly once (cancel pairing → close → release).
  try {
    return await startWithLease({ ...p, lease, agentName, accountId });
  } catch (err) {
    if (lease.deviceId) p.registry.delete(lease.deviceId);
    await lease.dispose("start-failed");
    if (err instanceof PageOpenFailedError) return text(strings.enroll.toolPageOpenFailed, { ok: false, state: "page_open_failed" });
    const remedy = remedyFor(err, operator);
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
}): Promise<ToolResult> {
  const { lease, agentName, accountId } = p;
  await p.beforeEffect();
  const created = await createDeviceOrRefuse(lease.control, agentName);
  lease.deviceId = created.device_id;

  const pageToken = newPageToken();
  const pageUrl = enrollmentPageUrl(p.cfg, pageToken);
  const entry: ActiveEnrollment = {
    lease,
    pageToken,
    pageServed: false,
    lastOpenedAt: p.deps.lease.now(),
    sessionKey: p.sessionKey,
    requesterSenderId: p.ctx.requesterSenderId,
    agentId: p.ctx.agentId,
    agentName,
    deviceId: created.device_id,
    qrPayload: created.qr_payload,
    pageUrl,
    state: "scanning",
    busy: false,
    words: undefined,
    terminal: Promise.resolve({ state: "created", qrPayload: created.qr_payload }),
    terminalState: undefined,
    failure: undefined,
  };
  // Poll on the lease's control connection; snapshots update the entry synchronously. The words are
  // the scan signal: the page's next poll renders them.
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
          p.registry.forget(entry);
          p.registry.track(lease.dispose("pairing-ended"));
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
        }
        throw err;
      },
    );
  entry.terminal.catch(() => {});
  p.registry.set(entry);

  // The display: the page opens in a browser on this machine (the URL is loopback — checked before the
  // device was created). A launcher that cannot spawn leaves the ceremony without a display, so start
  // fails and admitAndStart disposes the lease; the URL is never offered as a fallback.
  let opened = false;
  try {
    opened = await p.deps.openUrl(pageUrl);
  } catch {
    opened = false;
  }
  if (!opened) throw new PageOpenFailedError();
  // The result names no URL, no QR and no words: the model is told where the user should look.
  return text(strings.enroll.toolStart, {
    ok: true,
    state: "scanning",
    deviceId: created.device_id,
    accountId,
    pageOpened: true,
  });
}

export type HumanDecision = { ok: boolean; state: string; message: string };

/**
 * The human's YES — from the enrollment page's button, never from the model. Runs
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
 * The human's NO ("the words differ") — same surface as the yes. Past the final guard the config write
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
  return { ok: true, state: "cancelled", message: strings.enroll.toolCancelled };
}

async function confirmEnrollment(p: { active: ActiveEnrollment; deps: EnrollToolDeps; registry: EnrollmentRegistry }): Promise<ToolResult> {
  const { active } = p;
  /** Set once a token exists: a failure after this point names the label to revoke (M20 c). */
  let minted: { token: string; tokenId: string; tokenLabel: string } | undefined;
  const operator: OperatorContext = {
    identity: active.lease.daemonLease.identity,
    deviceId: active.deviceId,
    label: tokenLabelFor(normalizeAccountId(active.lease.accountId)),
    agentName: active.agentName,
  };
  /** M20 (c): appended to every failure that happens after a successful mint. */
  const orphaned = (msg: string) => (minted ? `${msg}\n\n${strings.enroll.orphanedToken(revokeLabelCommand({ ...operator, label: minted.tokenLabel }))}` : msg);
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
    // `daemon_info` BEFORE the mint: the first successful mint closes the enrollment connection (M20 a).
    const info = await active.lease.control.daemonInfo();
    if (!info.session_socket_path) throw new EnrollmentError("daemon_too_old");
    // Exactly one mint, never `replace`: a lost reply or a taken label is `mint_lost`/`label_exists`,
    // answered below with the mint-a-fresh-label instruction (M20 b).
    const m = await mintAccountToken({ ...common, deviceId: active.deviceId });
    minted = m;
    const identity = await probeIdentity({ ...common, deviceId: active.deviceId, token: m.token, sessionSocketPath: info.session_socket_path });

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
        token: m.token,
        daemonScope: active.lease.daemonLease.identity.scope,
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
      active.failureMessage = msg;
      p.registry.forget(active);
      await active.lease.dispose(reason);
      return text(msg, { ok: false, ...details });
    };
    if (err instanceof AccountExistsError) {
      return fail("account-exists", orphaned(strings.enroll.toolAccountExists(err.accountId, [err.accountId])), { state: "account_exists" });
    }
    if (err instanceof EnrollingAgentUnknownError) {
      // The agent roster changed underneath the ceremony: the account is NOT written unrouted.
      return fail("agent-unknown", orphaned(strings.enroll.toolAgentUnknown), { state: "agent_unknown" });
    }
    if (err instanceof RouteBindingConflictError) {
      return fail("routing-conflict", orphaned(strings.enroll.toolRoutingConflict(err.accountId, err.existingAgentId)), { state: "routing_conflict", accountId: err.accountId });
    }
    if (err instanceof EnrollmentError) {
      if (err.reason === "words_mismatch") return fail("words_mismatch", strings.enroll.wordsMismatch, { state: "words_mismatch" });
      // Post-mint only (the probe follows the mint), and the mint closed the enrollment connection: there
      // is no retry — the ceremony ends, the minted token is named for revocation.
      if (err.reason === "device_attached") return fail("device_attached", orphaned(strings.enroll.deviceAttachedRefused), { state: "device_attached", deviceId: active.deviceId });
      if (err.reason === "mint_lost" || err.reason === "label_exists") {
        return fail("mint_lost", remedyFor(err, operator)!, { state: "mint_lost", deviceId: active.deviceId });
      }
    }
    // A host write error after the mint (disk full, permissions): the outcome must reach the human
    // through the page and the model through the result, never only a thrown exception (M20 c).
    if (minted) {
      return fail("commit-failed", orphaned(strings.enroll.toolCommitFailed), { state: "commit_failed", deviceId: active.deviceId });
    }
    // Anything else is terminal for this enrollment: release the daemon/enrollment resources now,
    // not at TTL.
    active.state = "failed";
    active.failure = err instanceof Error ? err.name : "confirm_failed";
    p.registry.forget(active);
    await active.lease.dispose("confirm-failed");
    const remedy = remedyFor(err, operator);
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
  return registry;
}
