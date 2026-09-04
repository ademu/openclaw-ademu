// The device session (plan T6): connect to the daemon's SESSION socket with the account token,
// bind the runtime identity to the configured account (fail closed), cache conversations/members,
// and keep a reconnect barrier so replayed events are never processed against stale live-only state
// (membership/reactions/status are not replayed by the daemon).
import {
  connect as connectReal,
  type AdcClient,
  type AdcClientOptions,
  type ConversationSummary,
  type DeviceHello,
  type MemberEntry,
  type RetryInfo,
  type SelfInfo,
} from "@ademu/adc-client";
import { normalizeId } from "../grammar.js";
import { IdentityMismatchError, SessionAbortedError, SessionWarmupError } from "../status.js";

export type SessionDeps = {
  connect: (opts: AdcClientOptions) => Promise<AdcClient>;
  now: () => number;
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

export function realSessionDeps(log: SessionDeps["log"]): SessionDeps {
  return { connect: connectReal, now: () => Date.now(), log };
}

export type AccountIdentity = {
  deviceId: string;
  agentUserId: string;
  ownerUserId?: string | undefined;
};

export type OpenSessionParams = {
  token: string;
  sessionSocketPath: string;
  account: AccountIdentity;
  deps: SessionDeps;
  onRetry?: ((info: RetryInfo) => void) | undefined;
  onReconnected?: (() => void) | undefined;
  /** Account shutdown: aborts the connect/warm-up (a late connect success is closed). */
  signal?: AbortSignal | undefined;
};

/** Live-only state: conversations and members, refreshed after every (re)attach. */
export class MembersCache {
  readonly #client: AdcClient;
  readonly #members = new Map<string, MemberEntry[]>();
  readonly #inactive = new Set<string>();
  #conversations: ConversationSummary[] = [];

  constructor(client: AdcClient) {
    this.#client = client;
  }

  get conversations(): readonly ConversationSummary[] {
    return this.#conversations;
  }

  isInactive(groupId: string): boolean {
    return this.#inactive.has(normalizeId(groupId));
  }

  markInactive(groupId: string): void {
    this.#inactive.add(normalizeId(groupId));
    this.#members.delete(normalizeId(groupId));
  }

  invalidate(groupId?: string): void {
    if (groupId === undefined) this.#members.clear();
    else this.#members.delete(normalizeId(groupId));
  }

  /** Warm-up / reconnect barrier body: conversations + members of every active room. */
  async refresh(signal?: AbortSignal): Promise<void> {
    if (signal?.aborted) throw new SessionAbortedError();
    const { conversations } = await this.#client.listConversations();
    if (signal?.aborted) throw new SessionAbortedError();
    this.#conversations = conversations;
    this.#members.clear();
    this.#inactive.clear();
    for (const c of conversations) {
      if (!c.active) {
        this.#inactive.add(normalizeId(c.group_id));
        continue;
      }
      const { members } = await this.#client.getMembers({ group_id: c.group_id });
      if (signal?.aborted) throw new SessionAbortedError();
      this.#members.set(normalizeId(c.group_id), members);
    }
  }

  /** Synchronous cache read (outbound target classification); undefined when not cached. */
  peek(groupId: string): MemberEntry[] | undefined {
    return this.#members.get(normalizeId(groupId));
  }

  async get(groupId: string): Promise<MemberEntry[]> {
    const key = normalizeId(groupId);
    const cached = this.#members.get(key);
    if (cached) return cached;
    const { members } = await this.#client.getMembers({ group_id: groupId });
    this.#members.set(key, members);
    return members;
  }

  /** Unknown sender → refresh that room once. */
  async getWithSender(groupId: string, senderUserId: string): Promise<MemberEntry[]> {
    const members = await this.get(groupId);
    if (members.some((m) => normalizeId(m.user_id) === normalizeId(senderUserId))) return members;
    this.invalidate(groupId);
    return this.get(groupId);
  }
}

export type Session = {
  client: AdcClient;
  hello: DeviceHello;
  self: SelfInfo;
  members: MembersCache;
  /** Resolves immediately when the session is fresh; blocks while a reconnect refresh is in flight. */
  barrier: () => Promise<void>;
  /** Consecutive retry count since the last successful (re)attach. */
  retries: () => number;
  close: () => Promise<void>;
};

/**
 * Identity binding (Codex R3 #10): the token's device and agent must equal the configured account's;
 * the owner learned from `get_self` must equal the configured one when present.
 */
export function assertIdentity(hello: DeviceHello, self: SelfInfo, account: AccountIdentity): void {
  const eq = (a: string | undefined, b: string | undefined) => a !== undefined && b !== undefined && normalizeId(a) === normalizeId(b);
  if (!eq(hello.device_id, self.device_id) || !eq(self.device_id, account.deviceId)) throw new IdentityMismatchError();
  if (!eq(hello.agent_user_id, self.user_id) || !eq(self.user_id, account.agentUserId)) throw new IdentityMismatchError();
  if (account.ownerUserId && !eq(self.owner_user_id, account.ownerUserId)) throw new IdentityMismatchError();
}

export async function openSession(params: OpenSessionParams): Promise<Session> {
  const signal = params.signal;
  if (signal?.aborted) throw new SessionAbortedError();
  const connecting = params.deps.connect({
    token: params.token,
    socketPath: params.sessionSocketPath,
    takeover: true,
    reconnect: "auto",
  });
  // Abort during connect: contain a late success (close it) and give up now.
  const client = await new Promise<AdcClient>((resolve, reject) => {
    const onAbort = () => {
      connecting.then((c) => c.close().catch(() => {})).catch(() => {});
      reject(new SessionAbortedError());
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    connecting.then(
      (c) => {
        signal?.removeEventListener("abort", onAbort);
        resolve(c);
      },
      (err: unknown) => {
        signal?.removeEventListener("abort", onAbort);
        reject(err);
      },
    );
  });
  let self: SelfInfo;
  const members = new MembersCache(client);
  // Abort during warm-up: closing the client rejects its pending requests, so the awaits below wake.
  let abortWarmup!: () => void;
  const aborted = new Promise<never>((_, reject) => {
    abortWarmup = () => reject(new SessionAbortedError());
  });
  aborted.catch(() => {});
  const onAbortWarmup = () => {
    abortWarmup();
    void client.close().catch(() => {});
  };
  signal?.addEventListener("abort", onAbortWarmup, { once: true });
  try {
    if (signal?.aborted) throw new SessionAbortedError();
    // The warm-up is RACED against abort as well: even a request the client never rejects cannot
    // hold the account past shutdown.
    self = await Promise.race([client.getSelf(), aborted]);
    assertIdentity(client.hello, self, params.account);
    // The initial warm-up is inside the close-on-failure scope too: a seated, auto-reconnecting
    // client must never be leaked holding the device seat when openSession rejects.
    await Promise.race([members.refresh(signal), aborted]);
  } catch (err) {
    await client.close().catch(() => {});
    throw signal?.aborted ? new SessionAbortedError() : err;
  } finally {
    signal?.removeEventListener("abort", onAbortWarmup);
  }

  // Reconnect barrier: `retry` marks live state stale; `reconnected` refreshes it before the loop
  // may continue. Retry counting feeds the owned-daemon loss rule (5 consecutive retries).
  // Generation-fenced: only the warm-up of the LATEST reconnect may open the barrier, and only when
  // it succeeded. A failed warm-up keeps the barrier closed and closes the client — the event
  // iterator ends, the loop halts, the account restarts (never "ready" on a partial cache).
  let retries = 0;
  let generation = 0;
  let stale: Promise<void> | undefined;
  let release: (() => void) | undefined;
  let fail: ((err: Error) => void) | undefined;
  client.on("retry", (info) => {
    retries = info.attempt;
    generation++;
    if (!stale) {
      stale = new Promise<void>((r, rej) => {
        release = r;
        fail = rej;
      });
      stale.catch(() => {});
    }
    params.onRetry?.(info);
  });
  client.on("reconnected", () => {
    const mine = generation;
    void members.refresh().then(
      () => {
        if (mine !== generation) return; // a newer outage superseded this warm-up
        retries = 0;
        const r = release;
        stale = undefined;
        release = undefined;
        fail = undefined;
        r?.();
        params.onReconnected?.();
      },
      (err: unknown) => {
        if (mine !== generation) return;
        params.deps.log("session_refresh_failed", { errorClass: err instanceof Error ? err.name : typeof err });
        // REJECT the barrier (a loop body already parked on it must wake and halt — closing the
        // iterator alone cannot unblock it), then close the client so the account restarts.
        const f = fail;
        stale = undefined;
        release = undefined;
        fail = undefined;
        f?.(new SessionWarmupError());
        void client.close().catch(() => {});
      },
    );
  });

  return {
    client,
    hello: client.hello,
    self,
    members,
    barrier: () => stale ?? Promise.resolve(),
    retries: () => retries,
    close: () => client.close(),
  };
}
