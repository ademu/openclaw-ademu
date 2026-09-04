// A fake AdcClient (the shape `openSession` and the ingress loop use) with a pushable event stream,
// recorded acks, controllable reconnect signalling, and configurable members/conversations.
import type {
  AdcClient,
  AdcClientOptions,
  ConversationSummary,
  DeviceEvent,
  DeviceHello,
  MemberEntry,
  MessageReceivedEvent,
  RetryInfo,
  SelfInfo,
} from "@ademu/adc-client";

export const OWNER = "0f8fad5b-d9cb-469f-a165-70867728950e";
export const AGENT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
export const GUEST = "16fd2706-8baf-433b-82eb-8c7fada847da";
export const DEVICE = "3d594650-3436-4c91-9f6b-2a3e19b4c8d1";
export const ROOM_DM = "9b2b6d1e-3c1a-4f8e-9a1b-2c3d4e5f6a7b";
export const ROOM_GROUP = "5f0c9a1e-8d2b-4c3a-9e1f-0a1b2c3d4e5f";

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
  finish() {
    this.#done = true;
    for (const w of this.#waiters.splice(0)) w({ value: undefined as never, done: true });
  }
  next(): Promise<IteratorResult<T>> {
    if (this.#items.length) return Promise.resolve({ value: this.#items.shift()!, done: false });
    if (this.#done) return Promise.resolve({ value: undefined as never, done: true });
    return new Promise((r) => this.#waiters.push(r));
  }
}

export class FakeAdcClient {
  hello: DeviceHello;
  capabilities = new Set<string>();
  acks: number[] = [];
  typing: Array<{ group_id: string; active: boolean }> = [];
  sent: Array<{ group_id: string; body: string }> = [];
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
    this.hello = { v: 1, type: "hello", device_id: deviceId, agent_user_id: agentUserId, proto: 1, last_acked_seq: opts.lastAckedSeq ?? -1, capabilities: [] };
    this.self = { user_id: agentUserId, device_id: deviceId, username: "iris", display_name: "Iris", owner_user_id: opts.ownerUserId ?? OWNER };
  }

  room(groupId: string, members: MemberEntry[], active = true) {
    this.members.set(groupId, members);
    this.conversations = this.conversations.filter((c) => c.group_id !== groupId);
    this.conversations.push({ group_id: groupId, member_user_ids: members.map((m) => m.user_id), member_usernames: members.map((m) => m.username), active });
  }

  /** Pushes a message_received with the next seq (or an explicit one) and returns it. */
  message(partial: Partial<MessageReceivedEvent> & { seq?: number } = {}) {
    const seq = partial.seq ?? this.#seq++;
    const ev = {
      known: true as const,
      type: "event" as const,
      seq,
      event: "message_received" as const,
      group_id: partial.group_id ?? ROOM_DM,
      message_id: partial.message_id ?? `m-${seq}`,
      sender_user_id: partial.sender_user_id ?? OWNER,
      sender_username: partial.sender_username ?? "marios",
      ct: "text",
      body: partial.body ?? `hello ${seq}`,
      created_at_ms: partial.created_at_ms ?? 1_700_000_000_000 + seq,
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

  endStream() {
    this.#queue.finish();
  }

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
  async close() {
    this.closed = true;
    this.#queue.finish();
  }
  async request() {
    throw new Error("not used");
  }
  async sendText(params: { group_id: string; body: string }) {
    this.sent.push(params);
    return { message_id: `out-${this.sent.length}`, status: "queued" };
  }
  async sendReaction() {
    return { status: "queued" };
  }
  async sendTyping(params: { group_id: string; active: boolean }) {
    this.typing.push(params);
    return { status: "sent" };
  }
  async listConversations() {
    return { conversations: this.conversations };
  }
  async getMembers(params: { group_id: string }) {
    this.getMembersCalls++;
    return { members: this.members.get(params.group_id) ?? [] };
  }
  async getSelf() {
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
