// A fake AdcClient (the shape `openSession` and the ingress loop use) with a pushable event stream,
// recorded acks, controllable reconnect signalling, and configurable members/conversations.
import type {
  AdcClient,
  AdcClientOptions,
  ConversationSummary,
  DeviceEvent,
  DeviceHello,
  MediaItemInput,
  MediaSendSettled,
  MemberEntry,
  RetryInfo,
  SelfInfo,
  SendParams,
  SendResult,
} from "@ademu/adc-client";

export const OWNER = "0f8fad5b-d9cb-469f-a165-70867728950e";
export const AGENT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const GUEST = "16fd2706-8baf-433b-82eb-8c7fada847da";
export const DEVICE = "3d594650-3436-4c91-9f6b-2a3e19b4c8d1";
export const ROOM_DM = "9b2b6d1e-3c1a-4f8e-9a1b-2c3d4e5f6a7b";
export const ROOM_GROUP = "5f0c9a1e-8d2b-4c3a-9e1f-0a1b2c3d4e5f";

/** A #441 daemon's send advert (small max_bytes so tests can cross it). */
export const MEDIA_SEND_ADVERT = { max_bytes: 1_000_000, max_items: 20, types: { file: ["*"], photo: ["image/jpeg", "image/png"] } };

export const member = (user_id: string, kind = "human", display_name = "", username = ""): MemberEntry => ({ user_id, kind, display_name, username });

class Queue<T> {
  #items: T[] = [];
  #waiters: Array<(v: IteratorResult<T>) => void> = [];
  #done = false;
  push(item: T) {
    const w = this.#waiters.shift();
    if (w) w({ value: item, done: false });
    else this.#items.push(item);
  }
  #error: unknown;
  #rejecters: Array<(e: unknown) => void> = [];
  finish() {
    this.#done = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  /** The iterator throws `err` (a terminal client error surfacing after a reconnect). */
  fail(err: unknown) {
    this.#error = err;
    for (const r of this.#rejecters.splice(0)) r(err);
    this.#waiters.splice(0);
  }
  next(): Promise<IteratorResult<T>> {
    if (this.#items.length) return Promise.resolve({ value: this.#items.shift()!, done: false });
    if (this.#error !== undefined) return Promise.reject(this.#error);
    if (this.#done) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((r, rej) => {
      this.#waiters.push(r);
      this.#rejecters.push(rej);
    });
  }
}

/** The services the fake's daemon serves by default — no `get_blob`: a test that wants the file tool adds it. */
export const SERVICES = ["send", "advertise", "received", "get_message", "get_messages", "get_members", "list_conversations", "get_self"];
export const PROTOCOLS = { "ademu.call": "daemon", "ademu.chat": "pass", "ademu.core": "daemon", "ademu.run": "pass", "ademu.surface": "pass" } as const;

/** What a test gives `message()`: the v1-ish facts, translated into a v2 `received` frame. */
export type MessageInput = {
  seq?: number;
  group_id?: string;
  message_id?: string;
  sender_user_id?: string;
  sender_username?: string;
  sender_kind?: string;
  /** The text, or a media message's caption. */
  body?: string;
  /** `"text"` (default), `"media"`, `"view_once"`, or any other chat body type. */
  ct?: string;
  /** A media message's blobs — v2 render fields, no position (the daemon's context carries it). */
  media?: unknown;
  created_at_ms?: number;
  lane?: "durable" | "live";
  protocol?: string;
  /** A verbatim body for a non-chat protocol. */
  rawBody?: unknown;
};

export class FakeAdcClient {
  hello: DeviceHello;
  services = new Set<string>(SERVICES);
  protocols: Record<string, "pass" | "daemon"> = { ...PROTOCOLS };
  acks: number[] = [];
  /** Every `send` as it was called. */
  sends: SendParams[] = [];
  /** Typing pulses (live `activity` sends). */
  typing: Array<{ group_id: string; kind: string }> = [];
  /** Text sends, as `{group_id, body}` (the text). */
  sent: Array<{ group_id: string; body: string }> = [];
  /** Reaction sends. */
  reactions: Array<{ group_id: string; target_message_id: string; emoji: string }> = [];
  members = new Map<string, MemberEntry[]>();
  conversations: ConversationSummary[] = [];
  getMembersCalls = 0;
  seated = true;
  closed = false;
  self: SelfInfo;
  #queue = new Queue<DeviceEvent>();
  #listeners = new Map<string, Array<(arg?: unknown) => void>>();
  #seq = 0;

  constructor(opts: { deviceId?: string | undefined; agentUserId?: string | undefined; ownerUserId?: string | undefined; lastAckedSeq?: number | undefined } = {}) {
    const deviceId = opts.deviceId ?? DEVICE;
    const agentUserId = opts.agentUserId ?? AGENT;
    this.hello = { v: 2, type: "hello", device_id: deviceId, agent_user_id: agentUserId, proto: 2, last_acked_seq: opts.lastAckedSeq ?? -1, services: [...SERVICES], protocols: { ...PROTOCOLS }, media_send: MEDIA_SEND_ADVERT };
    this.self = { user_id: agentUserId, device_id: deviceId, username: "iris", display_name: "Iris", owner_user_id: opts.ownerUserId ?? OWNER };
  }

  room(groupId: string, members: MemberEntry[], active = true) {
    this.members.set(groupId, members);
    this.conversations = this.conversations.filter((c) => c.group_id !== groupId);
    this.conversations.push({ group_id: groupId, member_user_ids: members.map((m) => m.user_id), member_usernames: members.map((m) => m.username), active });
  }

  /** Pushes a v2 `received` frame with the next seq (or an explicit one) and returns it. */
  message(partial: MessageInput = {}) {
    const seq = partial.seq ?? this.#seq++;
    const senderUserId = partial.sender_user_id ?? OWNER;
    const text = partial.body ?? `hello ${seq}`;
    const ct = partial.ct ?? "text";
    const protocol = partial.protocol ?? "ademu.chat";
    let body: unknown;
    let context: Record<string, unknown> | undefined;
    if (partial.rawBody !== undefined) body = partial.rawBody;
    else if (ct === "media") {
      const blobs = Array.isArray(partial.media) ? (partial.media as unknown[]) : [];
      const isObj = (b: unknown): b is Record<string, unknown> => typeof b === "object" && b !== null;
      // The daemon's context names each file's position; the body's blobs carry render fields only.
      // A malformed entry is passed through as it is (the plugin must tolerate it).
      body = { type: "media", blobs: blobs.map((b) => (isObj(b) ? (({ position: _p, fetch_state: _f, ...rest }) => rest)(b) : b)), caption: partial.body ?? "" };
      context = { media: blobs.map((b, i) => ({ position: isObj(b) && typeof b.position === "number" ? b.position : i, fetch_state: "none" })) };
    } else if (ct === "view_once") body = { type: "view_once", blob: { type: "photo" }, caption: "" };
    else if (ct === "text") body = { type: "text", text };
    else body = { type: ct, text };
    const ev = {
      known: true as const,
      type: "event" as const,
      seq,
      event: "received" as const,
      group_id: partial.group_id ?? ROOM_DM,
      message_id: partial.message_id ?? `m-${seq}`,
      protocol,
      body,
      lane: partial.lane ?? ("durable" as const),
      created_at_ms: partial.created_at_ms ?? 1_700_000_000_000 + seq,
      sender: { user_id: senderUserId, username: partial.sender_username ?? "marios", device_id: `d-${senderUserId.slice(0, 8)}`, kind: partial.sender_kind ?? "human" },
      ...(context ? { context } : {}),
    };
    this.#queue.push(ev as unknown as DeviceEvent);
    return ev;
  }

  live(ev: Record<string, unknown>) {
    this.#queue.push({ known: true, type: "event", seq: this.#seq++, ...ev } as unknown as DeviceEvent);
  }

  unknown() {
    this.#queue.push({ known: false, type: "event", seq: this.#seq++, event: "future_thing", raw: { secret: "x" } } as unknown as DeviceEvent);
  }

  /** An unknown (future) event with a given name and raw wire object. */
  unknownEvent(event: string, raw: Record<string, unknown>) {
    this.#queue.push({ known: false, type: "event", seq: this.#seq++, event, raw } as unknown as DeviceEvent);
  }

  endStream() {
    this.#queue.finish();
  }

  /** The event iterator rejects with a terminal client error (what the real client does after a failed reconnect). */
  failStream(err: unknown) {
    this.#queue.fail(err);
  }

  /** Whether `refresh()` calls fail (reconnect warm-up failure). */
  refreshFails = false;
  /** When set, `listConversations` waits for this promise (abort-during-warm-up tests). */
  stallListConversations: Promise<void> | undefined;
  /** When set, `getMembers` rejects (event-processing failure tests). */
  getMembersFails = false;
  /** When set, `getSelf` waits for this promise (cancel-during-probe tests). */
  stallGetSelf: Promise<void> | undefined;

  events(): AsyncIterableIterator<DeviceEvent> {
    const q = this.#queue;
    return {
      next: () => q.next(),
      [Symbol.asyncIterator]() {
        return this;
      },
    } as AsyncIterableIterator<DeviceEvent>;
  }

  on(event: string, fn: (arg?: unknown) => void) {
    const arr = this.#listeners.get(event) ?? [];
    arr.push(fn);
    this.#listeners.set(event, arr);
  }
  off() {}
  emit(event: "retry" | "reconnected" | "close", arg?: RetryInfo) {
    for (const l of this.#listeners.get(event) ?? []) l(arg);
  }

  ack(seq: number) {
    if (!Number.isSafeInteger(seq) || seq < 0) throw new RangeError("bad seq");
    if (!this.seated) throw new Error("DetachedError");
    this.acks.push(seq);
  }
  ackThrough(ev: { seq: number }) {
    this.ack(ev.seq);
  }
  /** When set, `close()` never resolves (hung-close tests). */
  closeHangs = false;
  closeCalls = 0;
  async close() {
    this.closeCalls++;
    this.closed = true;
    this.#queue.finish();
    this.#rejectOnClose?.(new Error("DetachedError: client closed"));
    if (this.closeHangs) await new Promise(() => {});
  }
  async request() {
    throw new Error("not used");
  }
  /** The one send: records every call; a text lands in `sent`, an activity in `typing`, a reaction in `reactions`. */
  async send(params: SendParams): Promise<SendResult> {
    this.sends.push(params);
    const body = params.body as { type?: unknown; text?: unknown; kind?: unknown; target_message_id?: unknown; emoji?: unknown } | undefined;
    if (params.protocol === "ademu.chat" && body?.type === "text") {
      this.sent.push({ group_id: params.group_id, body: String(body.text) });
      return { message_id: `out-${this.sent.length}`, status: "queued" };
    }
    if (params.protocol === "ademu.chat" && body?.type === "activity") {
      this.typing.push({ group_id: params.group_id, kind: String(body.kind) });
      return { message_id: `live-${this.typing.length}`, status: "accepted" };
    }
    if (params.protocol === "ademu.chat" && body?.type === "reaction") {
      this.reactions.push({ group_id: params.group_id, target_message_id: String(body.target_message_id), emoji: String(body.emoji) });
      return { message_id: `r-${this.reactions.length}`, status: "queued" };
    }
    return { message_id: `s-${this.sends.length}`, status: params.lane === "live" ? "accepted" : "queued" };
  }
  async advertise(params: { protocols: string[] }) {
    return { protocols: ["ademu.chat", ...params.protocols] };
  }
  /** Every album declared: the declared items (no bytes) and the caption. */
  mediaSends: Array<{ group_id: string; caption?: string; items: Array<Omit<MediaItemInput, "source">> }> = [];
  /** How the next `sendMedia` ends: an outcome status (+ code) after the wait, or an error it throws. */
  mediaOutcome: { status: MediaSendSettled["status"]; code?: string } | Error = { status: "queued" };
  /** What a later `waitForMediaSend` (no deadline) settles on; never, by default. */
  lateOutcome: Promise<MediaSendSettled> = new Promise(() => {});
  async sendMedia(params: { group_id: string; caption?: string; items: MediaItemInput[] }): Promise<MediaSendSettled> {
    this.mediaSends.push({ group_id: params.group_id, ...(params.caption !== undefined ? { caption: params.caption } : {}), items: params.items.map(({ source: _s, ...item }) => item) });
    if (this.mediaOutcome instanceof Error) throw this.mediaOutcome;
    return { message_id: `media-${this.mediaSends.length}`, ...this.mediaOutcome };
  }
  waitForMediaSend(): Promise<MediaSendSettled> {
    return this.lateOutcome;
  }
  #closedP: Promise<never> | undefined;
  #rejectOnClose: ((e: unknown) => void) | undefined;
  /** Like the real client: a pending request rejects when the client is closed. */
  #untilClosed(): Promise<never> {
    if (!this.#closedP) {
      this.#closedP = new Promise<never>((_, rej) => {
        this.#rejectOnClose = rej;
      });
      this.#closedP.catch(() => {});
    }
    return this.#closedP;
  }
  async listConversations() {
    if (this.refreshFails) throw new Error("list_conversations failed");
    if (this.stallListConversations) await Promise.race([this.stallListConversations, this.#untilClosed()]);
    return { conversations: this.conversations };
  }
  async getMembers(params: { group_id: string }) {
    this.getMembersCalls++;
    if (this.getMembersFails) throw new Error("get_members failed");
    return { members: this.members.get(params.group_id) ?? [] };
  }
  async getSelf() {
    if (this.stallGetSelf) await Promise.race([this.stallGetSelf, this.#untilClosed()]);
    return this.self;
  }
  async getMessages() {
    return { messages: [] };
  }
  async getMessage() {
    throw new Error("not used");
  }
  async getMessageStatus() {
    throw new Error("not used");
  }
  async getConversation() {
    throw new Error("not used");
  }
  async getBacklog() {
    return { backlog: [] };
  }
  async searchMessages() {
    return { messages: [] };
  }
  async _initialAttach() {}
}

export function fakeConnect(client: FakeAdcClient) {
  const calls: AdcClientOptions[] = [];
  return {
    calls,
    connect: async (opts: AdcClientOptions) => {
      calls.push(opts);
      return client as unknown as AdcClient;
    },
  };
}
