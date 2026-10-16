// The call controller (openclaw-ademu#30 §4.2): one per account session. It tells the device host,
// per seat, that this agent takes calls; decides each ring by policy; runs the voice engine over the
// audio connection; and resumes a call across a seat reattach (decision 8: 10 s grace).
//
//   attach      calls enabled + the hello's call capabilities + an engine → `set_call_handling`, then
//               `get_call`: a ringing entry is decided now (its live event died with the old seat), a
//               connecting/active one is resumed on a fresh audio connection. Every reattach repeats
//               this, in this order (a ticket redeemed by a seat without call handling is refused).
//   ringing     policy → `decline_call`, or `answer_call` → ticket → audio → engine.
//   active      the intro, if configured, is spoken.
//   ended       the engine stops and the connection closes; the record follows as `ct:"call"`.
//   audio lost  the transport recovers below the engine; if it cannot, `end_call`.
//   barge-in    the agent engine mutes its input while it speaks and never clears; the transport
//               clears, and the engine is restarted (a fresh harness, unmuted) on the same connection.
//
// One call at a time (v1); anything that is not the current call is declined. All work runs on one
// sequential queue, beside the ingress loop (a ring never holds up a message). Account stop ends no
// call: the daemon keeps it 10 s for the next seat, then ends it itself.
import type { AdcClient, RetryInfo } from "@ademu/adc-client";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { ResolvedCallsConfig } from "../config.js";
import { CHANNEL_ID } from "../config.js";
import { classifyConversation, normalizeId, type ConversationKind } from "../grammar.js";
import type { Session } from "../monitor/session.js";
import type { MessageAccessInput } from "../security.js";
import type { CallEngineHandle, CallEngineStarter } from "./engine.js";
import { GroupCallBrain } from "./group-brain.js";
import type { GroupEngineHandle, GroupEngineStarter } from "./group-engine.js";
import { decideCall, type CallDecision } from "./policy.js";
import {
  answerCall,
  CALL_AUDIO_RATE,
  CALL_OUTCOMES,
  declineCall,
  endCall,
  errorCode,
  getCall,
  setCallHandling,
  supportsCalls,
  type CallChanged,
  type CallEntry,
  type CallParticipant,
  type CallState,
} from "./protocol.js";
import { CallAudioTransport, CallGoneError, openAudioSocket, type AudioSocket, type CallTransportStats, type ReconnectPolicy } from "./transport.js";

/** How long a transport's reconnect waits for the new seat's `set_call_handling`. */
export const SEAT_WAIT_MS = 10_000;
/** Bound on one engine stop (an engine that hangs must not hold the call queue). */
export const ENGINE_STOP_MS = 3_000;

export type CallsAvailability = "disabled" | "unsupported" | "no_engine" | "pending" | "ready" | "helper_unavailable" | "failed";

/** What `status.ts` shows: ids and states only. */
export type CallsStatus = {
  enabled: boolean;
  availability: CallsAvailability;
  call?: { callId: string; state: CallState; callerUserId?: string; since: number; audio?: CallTransportStats };
};

type CallClient = Pick<AdcClient, "request" | "capabilities" | "on" | "off">;

export type CallControllerParams = {
  accountId: string;
  cfg: OpenClawConfig;
  calls: ResolvedCallsConfig;
  client: CallClient;
  members: Session["members"];
  /** The session's reconnect barrier: a ring is decided on membership refreshed after a reattach. */
  barrier?: (() => Promise<void>) | undefined;
  /** The session socket the session is seated on: the audio connection dials exactly this path. */
  sessionSocketPath: string;
  resolver: MessageAccessInput["resolver"];
  /** `agentName`: the agent's name on Ademú (the account's), the default name that addresses it in a group call. */
  account: { agentUserId: string; ownerUserId: string; agentName?: string | undefined };
  resolveAgentRoute: (input: Record<string, unknown>) => { agentId: string; sessionKey: string };
  /** Undefined = no voice engine in this process (the agent then never takes calls). */
  startEngine: CallEngineStarter | undefined;
  /**
   * #874 group calls in "named" mode: the name-gated realtime engine and the per-turn transcriber.
   * Undefined (or `calls.group.mode: "same"`) = group calls run on `startEngine` like a 1-1.
   */
  group?: GroupCallDeps | undefined;
  onStatus?: ((status: CallsStatus) => void) | undefined;
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
  /** Seams for tests. */
  openAudio?: ((path: string, ticket: string, signal?: AbortSignal) => Promise<AudioSocket>) | undefined;
  reconnect?: ReconnectPolicy | undefined;
  now?: (() => number) | undefined;
  sleep?: ((ms: number, signal: AbortSignal) => Promise<void>) | undefined;
};

/** What a "named" group call needs from the host (`channel.ts`). */
export type GroupCallDeps = {
  startGroupEngine: GroupEngineStarter;
  /** One speaker's turn to text, with the call's names as the vocabulary. Throws on failure. */
  transcribe: (pcm: Buffer, names: string[]) => Promise<string>;
};

/** A running engine; `ownStop` = the controller stopped it (anything else stopping it is a failure). */
type EngineSlot = { handle: CallEngineHandle; ownStop: boolean };

/** After a `set_call_handling` that failed for another reason than a missing helper: first retry, then doubling. */
export const HANDLING_RETRY_MS = 2_000;
export const HANDLING_RETRY_MAX_MS = 60_000;
/** `get_call` right after call handling: attempts and first delay (doubling) before a ring is given up. */
export const GET_CALL_ATTEMPTS = 4;
export const GET_CALL_RETRY_MS = 1_000;
/** The agent's hang-up waits for its last words: this long of quiet after they played … */
export const HANG_UP_QUIET_MS = 800;
/** … or, when nothing is spoken after the consult, this long after it … */
export const HANG_UP_SILENT_MS = 6_000;
/** … and never longer than this after the request. */
export const HANG_UP_MAX_MS = 30_000;
const HANG_UP_POLL_MS = 200;

/** How long `stop()` lets an in-flight step notice the stop and clean up after itself. */
export const STOP_DRAIN_MS = 1_000;

type ActiveCall = {
  callId: string;
  groupId: string;
  kind: ConversationKind;
  callerUserId: string | undefined;
  /** The room as the last `call_changed` named it (#874 G1): the caller while ringing. */
  roster: CallParticipant[];
  /** A "named" group call's turn-taking (#874): set before its transport starts. */
  brain?: GroupCallBrain | undefined;
  state: CallState;
  since: number;
  transport?: CallAudioTransport;
  engine?: EngineSlot | undefined;
  route?: { agentId: string; sessionKey: string };
  introSpoken: boolean;
  /** The agent asked to hang up (`ademu_end_call`): when, and when the asking consult settled. */
  hangUp?: { requestedAt: number; consultSettledAt?: number; timer: ReturnType<typeof setInterval> };
  restarting: boolean;
  over: boolean;
};

export class CallController {
  readonly #p: CallControllerParams;
  readonly #now: () => number;
  #tail: Promise<void> = Promise.resolve();
  #stopped = false;
  #availability: CallsAvailability;
  #call: ActiveCall | undefined;
  /** True while the CURRENT seat has call handling; a reattach clears it until set again. */
  #seatReady = false;
  #seatWaiters: Array<() => void> = [];
  #handlingRetry: ReturnType<typeof setTimeout> | undefined;
  #handlingRetryMs = HANDLING_RETRY_MS;
  readonly #onRetry = (_info: RetryInfo) => {
    this.#seatReady = false;
    // The next seat's attach runs on `reconnected`.
    this.#clearHandlingRetry();
  };
  readonly #onReconnected = () => {
    this.#enqueue("attach", () => this.#attach());
  };

  constructor(params: CallControllerParams) {
    this.#p = params;
    this.#now = params.now ?? (() => Date.now());
    this.#availability = params.calls.enabled ? "pending" : "disabled";
  }

  /** Runs the first attach, and again after every reconnect of the session. */
  start(): void {
    if (!this.#p.calls.enabled) {
      this.#publish();
      return;
    }
    this.#p.client.on("retry", this.#onRetry);
    this.#p.client.on("reconnected", this.#onReconnected);
    this.#enqueue("attach", () => this.#attach());
  }

  /** A `call_changed` live event from the ingress loop (never awaited there). */
  handleEvent(ev: CallChanged): void {
    this.#enqueue("event", () => this.#onEvent(ev));
  }

  /**
   * The agent asks to hang up `callId` (the `ademu_end_call` tool, from inside the call's consult):
   * the call ends once the reply that consult produces has been spoken. False = not the current call.
   */
  endAfterReply(callId: string): boolean {
    const call = this.#call;
    if (!call || call.over || call.callId !== normalizeId(callId) || this.#stopped) return false;
    if (call.hangUp) return true;
    const timer = setInterval(() => this.#checkHangUp(call), HANG_UP_POLL_MS);
    timer.unref?.();
    call.hangUp = { requestedAt: this.#now(), timer };
    this.#p.log("call_hang_up_requested", {});
    return true;
  }

  #consultSettled(call: ActiveCall): void {
    if (call.hangUp && call.hangUp.consultSettledAt === undefined) call.hangUp.consultSettledAt = this.#now();
  }

  /** Ends the call once the agent's last words have played (or the wait ran out). */
  #checkHangUp(call: ActiveCall): void {
    const h = call.hangUp;
    if (!h || call.over) return;
    const now = this.#now();
    const idle = call.transport?.idleMs() ?? Number.POSITIVE_INFINITY;
    const settled = h.consultSettledAt;
    const spokeAfter = settled !== undefined && (call.transport?.lastWriteAt ?? 0) >= settled;
    const done =
      now - h.requestedAt >= HANG_UP_MAX_MS ||
      (settled !== undefined && idle >= HANG_UP_QUIET_MS && (spokeAfter || now - settled >= HANG_UP_SILENT_MS));
    if (!done) return;
    clearInterval(h.timer);
    void this.#enqueue("hang_up", () => this.#end(call, "hang_up"));
  }

  /** The agent hangs up now. The `ended` event follows. */
  hangUp(): Promise<void> {
    return this.#enqueue("hang_up", async () => {
      const call = this.#call;
      if (call) await this.#end(call, "hang_up");
    });
  }

  status(): CallsStatus {
    const call = this.#call;
    return {
      enabled: this.#p.calls.enabled,
      availability: this.#availability,
      ...(call
        ? {
            call: {
              callId: call.callId,
              state: call.state,
              ...(call.callerUserId ? { callerUserId: call.callerUserId } : {}),
              since: call.since,
              ...(call.transport ? { audio: call.transport.stats() } : {}),
            },
          }
        : {}),
    };
  }

  /** Account stop: the engine and the connection go; the call itself is left to the daemon's grace. */
  async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    this.#p.client.off("retry", this.#onRetry);
    this.#p.client.off("reconnected", this.#onReconnected);
    this.#clearHandlingRetry();
    for (const w of this.#seatWaiters.splice(0)) w();
    const call = this.#call;
    if (call) await this.#teardown(call, "account_stopped");
    // A step already running (an answer, an engine start) sees the stop after its await and cleans
    // up after itself; give it a moment, then sweep whatever it left.
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([this.#tail, new Promise<void>((r) => (timer = setTimeout(r, STOP_DRAIN_MS)))]);
    clearTimeout(timer);
    const left = this.#call;
    if (left) await this.#teardown(left, "account_stopped");
  }

  #clearHandlingRetry(): void {
    clearTimeout(this.#handlingRetry);
    this.#handlingRetry = undefined;
  }

  /** The seat lasts, so does the wish to take calls: retry a failed `set_call_handling` with backoff. */
  #scheduleHandlingRetry(): void {
    if (this.#stopped || this.#handlingRetry) return;
    const delay = this.#handlingRetryMs;
    this.#handlingRetryMs = Math.min(delay * 2, HANDLING_RETRY_MAX_MS);
    this.#handlingRetry = setTimeout(() => {
      this.#handlingRetry = undefined;
      void this.#enqueue("attach", () => this.#attach());
    }, delay);
    this.#handlingRetry.unref?.();
  }

  /** The account stopped while a step awaited: the step ends here and cleans up after itself. */
  async #abandoned(call: ActiveCall | undefined): Promise<boolean> {
    if (!this.#stopped && !call?.over) return false;
    if (call) await this.#teardown(call, "account_stopped");
    return true;
  }

  // --- queue ----------------------------------------------------------------------------------

  #enqueue(step: string, fn: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(async () => {
      if (this.#stopped) return;
      try {
        await fn();
      } catch (err) {
        this.#p.log("call_step_failed", { step, errorClass: err instanceof Error ? err.name : typeof err, code: errorCode(err) ?? "" });
      }
    });
    this.#tail = run.catch(() => {});
    return run;
  }

  #publish(): void {
    try {
      this.#p.onStatus?.(this.status());
    } catch {
      // A status sink must not break a call.
    }
  }

  #setAvailability(a: CallsAvailability): void {
    this.#availability = a;
    this.#publish();
  }

  // --- attach -----------------------------------------------------------------------------------

  async #attach(): Promise<void> {
    if (!this.#p.startEngine) {
      if (this.#availability !== "no_engine") this.#p.log("calls_no_engine", {});
      return this.#setAvailability("no_engine");
    }
    if (!supportsCalls(this.#p.client.capabilities)) {
      if (this.#availability !== "unsupported") this.#p.log("calls_unsupported", {});
      return this.#setAvailability("unsupported");
    }
    try {
      // Speaking frames only when group calls are name-gated here (#874 G2).
      await setCallHandling(this.#p.client, CALL_AUDIO_RATE, this.#namedGroups());
    } catch (err) {
      const code = errorCode(err);
      this.#p.log("call_handling_failed", { code: code ?? "", errorClass: err instanceof Error ? err.name : typeof err });
      // A missing adc-call is the user's to install: no retry until the next attach. Anything else
      // (a timeout, a detach race) is retried while this seat lasts.
      if (code === "call_helper_unavailable") return this.#setAvailability("helper_unavailable");
      this.#setAvailability("failed");
      return this.#scheduleHandlingRetry();
    }
    this.#handlingRetryMs = HANDLING_RETRY_MS;
    this.#seatReady = true;
    for (const w of this.#seatWaiters.splice(0)) w();
    this.#setAvailability("ready");
    this.#p.log("call_handling_set", {});
    const entries = await this.#getCallAfterAttach();
    if (entries) await this.#resume(entries);
  }

  /**
   * `get_call` after `set_call_handling`, retried: a ring whose live event died with the old seat is
   * only learned here, and its 45 s window must not pass undecided on one failed request. A seat that
   * went away meanwhile stops the retries (its `reconnected` runs the whole attach again).
   */
  async #getCallAfterAttach(): Promise<CallEntry[] | undefined> {
    let delay = GET_CALL_RETRY_MS;
    for (let attempt = 1; ; attempt++) {
      try {
        return await getCall(this.#p.client);
      } catch (err) {
        this.#p.log("call_get_failed", { attempt, code: errorCode(err) ?? "", errorClass: err instanceof Error ? err.name : typeof err });
        if (attempt >= GET_CALL_ATTEMPTS) return undefined;
      }
      await new Promise<void>((r) => setTimeout(r, delay).unref?.());
      delay *= 2;
      if (this.#stopped || !this.#seatReady) return undefined;
    }
  }

  /** What the device host says is going on, after an attach. */
  async #resume(entries: CallEntry[]): Promise<void> {
    const current = this.#call;
    if (current && !entries.some((e) => e.call_id === current.callId && e.state !== "ended")) {
      // It ended while the seat was away (its `ended` event went with the old seat).
      await this.#teardown(current, "gone");
    }
    for (const entry of entries) {
      if (entry.state === "ended") continue;
      const mine = this.#call?.callId === entry.call_id ? this.#call : undefined;
      if (entry.state === "ringing") {
        if (mine || entry.direction !== "incoming") continue;
        if (this.#call) await this.#decline(entry.call_id, "busy_local");
        else await this.#onRinging(entry);
        continue;
      }
      if (mine) {
        mine.state = entry.state;
        // The new seat needs its own connection; the helper switches to it.
        if (mine.transport) mine.transport.replace();
        this.#publish();
        continue;
      }
      if (this.#call) {
        // Not ours, and we have another: v1 holds one call.
        await this.#decline(entry.call_id, "busy_local");
        continue;
      }
      // Answered by a previous seat of this account (a gateway restart within the grace): take it over.
      await this.#adopt(entry);
    }
  }

  // --- events ------------------------------------------------------------------------------------

  async #onEvent(ev: CallChanged): Promise<void> {
    const call = this.#call;
    const mine = call?.callId === ev.call_id ? call : undefined;
    switch (ev.state) {
      case "ringing":
        if (mine) return;
        if (ev.direction !== "incoming") return this.#p.log("call_ignored", { state: ev.state, direction: ev.direction });
        if (call) return this.#decline(ev.call_id, "busy_local");
        return this.#onRinging(ev);
      case "connecting":
      case "active":
        if (!mine) return this.#p.log("call_ignored", { state: ev.state, direction: ev.direction });
        mine.state = ev.state;
        mine.roster = ev.participants;
        mine.brain?.setRoster(ev.participants);
        this.#publish();
        if (ev.state === "active") this.#speakIntro(mine);
        return;
      case "ended":
        if (mine) {
          this.#p.log("call_ended", { outcome: CALL_OUTCOMES.find((o) => o === ev.outcome) ?? "other" });
          await this.#teardown(mine, "ended");
        }
        return;
    }
  }

  async #onRinging(ring: Pick<CallEntry, "call_id" | "group_id" | "participants" | "state" | "caller_user_id">): Promise<void> {
    let decision: CallDecision;
    try {
      // Call events are read ahead of the message loop, so they also skip its barrier: wait for it here.
      await this.#p.barrier?.();
      decision = await decideCall({
        call: ring,
        mode: this.#p.calls.answer,
        cfg: this.#p.cfg,
        accountId: this.#p.accountId,
        members: this.#p.members,
        resolver: this.#p.resolver,
        account: this.#p.account,
        resolveAgentRoute: this.#p.resolveAgentRoute,
      });
    } catch (err) {
      // A caller is never left ringing for 45 s on our failure.
      this.#p.log("call_policy_failed", { errorClass: err instanceof Error ? err.name : typeof err });
      return this.#decline(ring.call_id, "policy_failed");
    }
    // Stopped meanwhile: leave it ringing for the next seat (its get_call lists it).
    if (this.#stopped) return;
    if (!decision.answer) return this.#decline(ring.call_id, decision.reason);

    const call: ActiveCall = {
      callId: ring.call_id,
      groupId: ring.group_id,
      kind: decision.kind,
      // While ringing the caller is also participants[0] (#874 G1).
      callerUserId: ring.caller_user_id ?? ring.participants[0]?.user_id,
      roster: ring.participants,
      state: "ringing",
      since: this.#now(),
      introSpoken: false,
      restarting: false,
      over: false,
    };
    this.#call = call;
    this.#publish();
    let ticket: string;
    try {
      ({ audio_ticket: ticket } = await answerCall(this.#p.client, call.callId));
    } catch (err) {
      const code = errorCode(err);
      this.#p.log("call_answer_failed", { code: code ?? "", errorClass: err instanceof Error ? err.name : typeof err });
      if (code === "call_helper_unavailable") this.#setAvailability("helper_unavailable");
      // unknown_call: it stopped ringing meanwhile. Anything else: say no rather than leave it ringing.
      if (code !== "unknown_call") await endCall(this.#p.client, call.callId).catch(() => {});
      return this.#teardown(call, "answer_failed");
    }
    // Answered, but the account stopped: the daemon keeps the call 10 s for the next seat to take over.
    if (await this.#abandoned(call)) return;
    this.#p.log("call_answered", { kind: call.kind });
    if (call.state === "ringing") call.state = "connecting";
    await this.#startMedia(call, ticket);
  }

  async #adopt(entry: CallEntry): Promise<void> {
    const members = await this.#p.members.get(entry.group_id);
    if (this.#stopped || this.#call) return;
    const call: ActiveCall = {
      callId: entry.call_id,
      groupId: entry.group_id,
      kind: classifyConversation({ members, agentUserId: this.#p.account.agentUserId, ownerUserId: this.#p.account.ownerUserId }).kind,
      // An answered call's participants are its room (#874 G1): the caller is named apart.
      callerUserId: entry.state === "ringing" ? (entry.caller_user_id ?? entry.participants[0]?.user_id) : entry.caller_user_id,
      roster: entry.participants,
      state: entry.state,
      since: this.#now(),
      introSpoken: true,
      restarting: false,
      over: false,
    };
    this.#call = call;
    this.#p.log("call_adopted", { state: entry.state });
    await this.#startMedia(call, entry.audio_ticket);
  }

  // --- media ------------------------------------------------------------------------------------

  #openAudio(ticket: string, signal?: AbortSignal): Promise<AudioSocket> {
    return this.#p.openAudio ? this.#p.openAudio(this.#p.sessionSocketPath, ticket, signal) : openAudioSocket({ path: this.#p.sessionSocketPath, ticket, signal });
  }

  #waitSeat(signal: AbortSignal): Promise<void> {
    if (this.#seatReady) return Promise.resolve();
    return new Promise<void>((resolve, reject) => {
      const done = () => {
        clearTimeout(timer);
        signal.removeEventListener("abort", done);
        this.#seatWaiters = this.#seatWaiters.filter((w) => w !== done);
        if (this.#seatReady) resolve();
        else reject(new Error("seat not ready"));
      };
      const timer = setTimeout(done, SEAT_WAIT_MS);
      signal.addEventListener("abort", done, { once: true });
      this.#seatWaiters.push(done);
    });
  }

  /** A fresh connection for `call`: on the ready seat, with `get_call`'s fresh ticket. */
  async #reopen(call: ActiveCall, signal: AbortSignal): Promise<AudioSocket> {
    await this.#waitSeat(signal);
    if (call.over) throw new CallGoneError();
    const entry = (await getCall(this.#p.client)).find((e) => e.call_id === call.callId);
    if (!entry || entry.state === "ended" || entry.state === "ringing") throw new CallGoneError();
    if (!entry.audio_ticket) throw new CallGoneError();
    return this.#openAudio(entry.audio_ticket, signal);
  }

  async #startMedia(call: ActiveCall, ticket: string | undefined): Promise<void> {
    let first: AudioSocket | undefined;
    if (ticket) {
      try {
        first = await this.#openAudio(ticket);
      } catch (err) {
        // The ticket is spent; the transport recovers with a fresh one.
        this.#p.log("call_audio_open_failed", { errorClass: err instanceof Error ? err.name : typeof err });
      }
    }
    if (call.over || this.#stopped) {
      first?.socket.destroy();
      await this.#abandoned(call);
      return;
    }
    const route = this.#p.resolveAgentRoute({
      cfg: this.#p.cfg,
      channel: CHANNEL_ID,
      accountId: this.#p.accountId,
      peer: { kind: call.kind, id: normalizeId(call.groupId) },
    });
    call.route = { agentId: route.agentId, sessionKey: route.sessionKey };
    const group = this.#groupDepsFor(call);
    if (group) {
      const agentName = this.#agentName(route.agentId);
      const brain = new GroupCallBrain({
        agentName,
        wakeNames: this.#p.calls.group.wakeNames ?? [agentName],
        ownerUserId: normalizeId(this.#p.account.ownerUserId),
        rate: CALL_AUDIO_RATE,
        transcribe: group.transcribe,
        ask: (text) => (call.engine?.handle as GroupEngineHandle | undefined)?.ask(text),
        log: this.#p.log,
        now: this.#now,
      });
      brain.setRoster(call.roster);
      call.brain = brain;
    }
    const brain = call.brain;
    const bargeIn = this.#p.calls.bargeIn;
    const transport = new CallAudioTransport({
      first,
      rate: CALL_AUDIO_RATE,
      reopen: (signal) => this.#reopen(call, signal),
      reconnect: this.#p.reconnect,
      ...(bargeIn.enabled
        ? {
            bargeIn: {
              rmsThreshold: bargeIn.rmsThreshold,
              holdMs: bargeIn.holdMs,
              onBargeIn: () => {
                this.#p.log("call_barge_in", {});
                if (this.#p.calls.engine === "agent") void this.#enqueue("restart_engine", () => this.#restartEngine(call));
              },
            },
          }
        : {}),
      ...(brain
        ? {
            tap: { onPcm: (pcm: Buffer) => brain.onPcm(pcm), onSpeaking: (userId: string, active: boolean) => brain.onSpeaking(userId, active) },
            bargeInGate: () => brain.bargeInGate(),
          }
        : {}),
      onLost: () => void this.#enqueue("audio_lost", () => this.#end(call, "audio_lost")),
      log: this.#p.log,
      now: this.#now,
      sleep: this.#p.sleep,
    });
    call.transport = transport;
    this.#publish();
    try {
      await this.#startEngine(call);
    } catch (err) {
      this.#p.log("call_engine_failed", { errorClass: err instanceof Error ? err.name : typeof err });
      return this.#end(call, "engine_failed");
    }
    if (call.state === "active") this.#speakIntro(call);
  }

  async #startEngine(call: ActiveCall): Promise<void> {
    if (!call.transport || !call.route || !this.#p.startEngine) return;
    let slot: EngineSlot | undefined;
    const view = call.transport.view(() => {
      // The engine stopped its transport by itself (a provider error or close): nobody is on the
      // line any more, so the call ends. A failed START is not this (slot unset): its caller ends it.
      if (!slot || slot.ownStop || call.over || this.#stopped) return;
      this.#p.log("call_engine_stopped", {});
      void this.#enqueue("engine_stopped", () => this.#end(call, "engine_stopped"));
    });
    const common = {
      transport: view,
      callId: call.callId,
      agentId: call.route.agentId,
      sessionKey: call.route.sessionKey,
      toolPolicy: this.#toolPolicyFor(call),
      onConsultSettled: () => this.#consultSettled(call),
    };
    const group = call.brain ? this.#groupDepsFor(call) : undefined;
    const handle: CallEngineHandle =
      group && call.brain
        ? await group.startGroupEngine({
            ...common,
            agentName: this.#agentName(call.route.agentId),
            onAgentSaid: (text) => call.brain?.onAgentSaid(text),
          })
        : await this.#p.startEngine(common);
    slot = { handle, ownStop: false };
    if (call.over || this.#stopped) {
      await this.#stopEngine(slot);
      await this.#abandoned(call);
      return;
    }
    call.engine = slot;
  }

  /**
   * The owner's tools only in the owner's 1-1 call: a room call is one mixed stream, so anyone in it
   * who speaks drives the agent, whoever placed the call.
   */
  /** Group calls are name-gated when the host can run that engine and config does not opt out. */
  #namedGroups(): boolean {
    return this.#p.calls.group.mode === "named" && this.#p.group !== undefined;
  }

  #groupDepsFor(call: ActiveCall): GroupCallDeps | undefined {
    return call.kind === "group" && this.#namedGroups() ? this.#p.group : undefined;
  }

  /**
   * The agent's name: its name on Ademú (the account's `agentName`, what people in the room see and
   * say), else the OpenClaw agent's configured name (OpenClaw's own activation-name source), else "OpenClaw".
   */
  #agentName(agentId: string): string {
    const own = this.#p.account.agentName?.trim();
    if (own) return own;
    const agents = (this.#p.cfg as { agents?: { list?: Array<{ id?: string; name?: string; identity?: { name?: string } }> } }).agents;
    const agent = agents?.list?.find((a) => a.id === agentId);
    return agent?.name?.trim() || agent?.identity?.name?.trim() || "OpenClaw";
  }

  #toolPolicyFor(call: ActiveCall): ResolvedCallsConfig["toolPolicy"] {
    const ownerAlone = call.kind === "direct" && call.callerUserId === normalizeId(this.#p.account.ownerUserId);
    return ownerAlone ? this.#p.calls.ownerToolPolicy : this.#p.calls.toolPolicy;
  }

  async #stopEngine(slot: EngineSlot): Promise<void> {
    slot.ownStop = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([
      slot.handle.stop().catch((err: unknown) => this.#p.log("call_engine_stop_failed", { errorClass: err instanceof Error ? err.name : typeof err })),
      new Promise<void>((r) => {
        timer = setTimeout(r, ENGINE_STOP_MS);
      }),
    ]);
    clearTimeout(timer);
  }

  /** Agent engine barge-in: its harness keeps input muted for the cut clip; a new engine starts unmuted. */
  async #restartEngine(call: ActiveCall): Promise<void> {
    if (call.over || call.restarting || this.#call !== call) return;
    call.restarting = true;
    try {
      const old = call.engine;
      call.engine = undefined;
      if (old) await this.#stopEngine(old);
      if (!call.over) await this.#startEngine(call);
      this.#p.log("call_engine_restarted", {});
    } catch (err) {
      this.#p.log("call_engine_failed", { errorClass: err instanceof Error ? err.name : typeof err });
      await this.#end(call, "engine_failed");
    } finally {
      call.restarting = false;
    }
  }

  #speakIntro(call: ActiveCall): void {
    const intro = this.#p.calls.introMessage;
    if (!intro || call.introSpoken || !call.engine) return;
    call.introSpoken = true;
    try {
      call.engine.handle.speak(intro);
    } catch (err) {
      this.#p.log("call_intro_failed", { errorClass: err instanceof Error ? err.name : typeof err });
    }
  }

  // --- ending ------------------------------------------------------------------------------------

  async #decline(callId: string, reason: string): Promise<void> {
    try {
      await declineCall(this.#p.client, callId);
      this.#p.log("call_declined", { reason });
    } catch (err) {
      this.#p.log("call_decline_failed", { reason, code: errorCode(err) ?? "", errorClass: err instanceof Error ? err.name : typeof err });
    }
  }

  /** The agent's side ends the call (hang-up, lost audio, a failed engine). */
  async #end(call: ActiveCall, reason: string): Promise<void> {
    if (call.over) return;
    try {
      await endCall(this.#p.client, call.callId);
    } catch (err) {
      this.#p.log("call_end_failed", { reason, code: errorCode(err) ?? "", errorClass: err instanceof Error ? err.name : typeof err });
    }
    // The `ended` event follows; tear down now so a lost event never leaves the engine running.
    await this.#teardown(call, reason);
  }

  async #teardown(call: ActiveCall, reason: string): Promise<void> {
    if (call.over) return;
    call.over = true;
    call.brain?.stop();
    if (call.hangUp) clearInterval(call.hangUp.timer);
    if (this.#call === call) this.#call = undefined;
    const engine = call.engine;
    call.engine = undefined;
    if (engine) await this.#stopEngine(engine);
    await call.transport?.stop();
    this.#p.log("call_closed", { reason });
    this.#publish();
  }
}
