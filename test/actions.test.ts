import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { afterEach, describe, expect, it } from "vitest";
import { ademuMessageActions } from "../src/actions.js";
import { registerLiveAccount, resetLiveAccountsForTests } from "../src/outbound.js";
import { FakeAdcClient, ROOM_DM } from "./fakes/adc.js";

function cfg(channel: Record<string, unknown>): OpenClawConfig {
  return { channels: { ademu: channel } } as unknown as OpenClawConfig;
}
const configured = cfg({ accounts: { main: { deviceId: "d1", agentUserId: "a1", ownerUserId: "o1", token: "adc1_x" } } });

afterEach(() => resetLiveAccountsForTests());

async function react(params: Record<string, unknown>, opts: { accountId?: string; toolContext?: Record<string, unknown> } = {}) {
  return ademuMessageActions.handleAction!({
    channel: "ademu",
    action: "react",
    cfg: configured,
    params,
    accountId: opts.accountId ?? "main",
    ...(opts.toolContext ? { toolContext: opts.toolContext } : {}),
  } as never);
}

describe("actions: discovery", () => {
  it("offers send + react only when a configured, enabled account exists", () => {
    expect(ademuMessageActions.describeMessageTool({ cfg: configured } as never)).toEqual({ actions: ["send", "react"] });
    expect(ademuMessageActions.describeMessageTool({ cfg: cfg({ accounts: { main: { deviceId: "d1" } } }) } as never)).toBeNull();
    expect(ademuMessageActions.describeMessageTool({ cfg: cfg({ enabled: false, accounts: { main: { deviceId: "d1", token: "t" } } }) } as never)).toBeNull();
    expect(ademuMessageActions.describeMessageTool({ cfg: configured, accountId: "other" } as never)).toBeNull();
    expect(ademuMessageActions.supportsAction!({ action: "react" })).toBe(true);
    expect(ademuMessageActions.supportsAction!({ action: "send" })).toBe(false);
  });
});

describe("actions: react", () => {
  it("adds a reaction through the live client (prefixed target accepted)", async () => {
    const client = new FakeAdcClient();
    const calls: unknown[] = [];
    client.sendReaction = async (p?: unknown) => {
      calls.push(p);
      return { status: "queued" };
    };
    registerLiveAccount("main", { client });
    const result = await react({ to: `ademu:${ROOM_DM}`, messageId: "m-7", emoji: "👍" });
    expect(calls).toEqual([{ group_id: ROOM_DM, target_message_id: "m-7", emoji: "👍" }]);
    expect(result.details).toEqual({ ok: true, added: "👍", status: "queued" });
  });

  it("remove:true sends the empty-emoji wire form", async () => {
    const client = new FakeAdcClient();
    const calls: unknown[] = [];
    client.sendReaction = async (p?: unknown) => {
      calls.push(p);
      return { status: "queued" };
    };
    registerLiveAccount("main", { client });
    const result = await react({ to: ROOM_DM, messageId: "m-7", emoji: "👍", remove: true });
    expect(calls).toEqual([{ group_id: ROOM_DM, target_message_id: "m-7", emoji: "" }]);
    expect(result.details).toEqual({ ok: true, removed: "👍", status: "queued" });
  });

  it("falls back to the current message id from the tool context", async () => {
    const client = new FakeAdcClient();
    const calls: Array<{ target_message_id: string }> = [];
    client.sendReaction = async (p?: unknown) => {
      calls.push(p as { target_message_id: string });
      return { status: "queued" };
    };
    registerLiveAccount("main", { client });
    await react({ to: ROOM_DM, emoji: "❤️" }, { toolContext: { currentMessageId: "m-ctx" } });
    expect(calls[0]?.target_message_id).toBe("m-ctx");
  });

  it("rejects a missing messageId, a missing emoji, a non-id target, and other actions", async () => {
    registerLiveAccount("main", { client: new FakeAdcClient() });
    await expect(react({ to: ROOM_DM, emoji: "👍" })).rejects.toThrow(/messageId required/);
    await expect(react({ to: ROOM_DM, messageId: "m", emoji: "" })).rejects.toThrow(/emoji required/);
    await expect(react({ to: "alice", messageId: "m", emoji: "👍" })).rejects.toThrow(/conversation ids/);
    await expect(
      ademuMessageActions.handleAction!({ channel: "ademu", action: "send", cfg: configured, params: {}, accountId: "main" } as never),
    ).rejects.toThrow(/not supported/);
  });

  it("fails clearly when the account is not running", async () => {
    await expect(react({ to: ROOM_DM, messageId: "m", emoji: "👍" })).rejects.toThrow(/not running/);
  });
});
