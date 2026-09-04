import { isChannelPartialDeliveryError } from "openclaw/plugin-sdk/channel-inbound";
import {
  verifyChannelMessageAdapterCapabilityProofs,
  verifyChannelMessageReceiveAckPolicyAdapterProofs,
} from "openclaw/plugin-sdk/channel-outbound";
import { afterEach, describe, expect, it } from "vitest";
import {
  AccountNotRunningError,
  TEXT_CHUNK_LIMIT,
  ademuMessageAdapter,
  ademuMessaging,
  createAdemuReceipt,
  getLiveAccount,
  registerLiveAccount,
  resetLiveAccountsForTests,
  resolveAdemuOutboundSessionRoute,
  sendAdemuText,
  unregisterLiveAccount,
} from "../src/outbound.js";
import { FakeAdcClient, OWNER, ROOM_DM, ROOM_GROUP } from "./fakes/adc.js";

const cfg = { channels: { ademu: {} } } as never;

afterEach(() => resetLiveAccountsForTests());

describe("outbound: live-account registry", () => {
  it("throws a clear error when the account is not running", () => {
    expect(() => getLiveAccount("main")).toThrow(AccountNotRunningError);
    expect(() => getLiveAccount("main")).toThrow(/not running/);
  });

  it("unregister only removes the same registration (a successor is left alone)", () => {
    const a = { client: new FakeAdcClient() };
    const b = { client: new FakeAdcClient() };
    registerLiveAccount("main", a);
    registerLiveAccount("main", b);
    unregisterLiveAccount("main", a);
    expect(getLiveAccount("main")).toBe(b);
    unregisterLiveAccount("main", b);
    expect(() => getLiveAccount("main")).toThrow(AccountNotRunningError);
  });
});

describe("outbound: text send", () => {
  it("sends one chunk for short text and builds a receipt from the daemon message id", async () => {
    const client = new FakeAdcClient();
    const chunks = await sendAdemuText({ client, groupId: ROOM_DM, text: "hello" });
    expect(client.sent).toEqual([{ group_id: ROOM_DM, body: "hello" }]);
    const receipt = createAdemuReceipt(chunks, 1234);
    expect(receipt.platformMessageIds).toEqual(["out-1"]);
    expect(receipt.primaryPlatformMessageId).toBe("out-1");
    expect(receipt.parts).toHaveLength(1);
    expect(receipt.parts[0]?.kind).toBe("text");
    expect(receipt.sentAt).toBe(1234);
  });

  it(`splits at ${TEXT_CHUNK_LIMIT} chars and reports every chunk through onDeliveryResult`, async () => {
    const client = new FakeAdcClient();
    const text = Array.from({ length: 900 }, (_, i) => `word${i}`).join(" "); // ~7000 chars
    expect(text.length).toBeGreaterThan(TEXT_CHUNK_LIMIT);
    const reported: string[] = [];
    const chunks = await sendAdemuText({
      client,
      groupId: ROOM_DM,
      text,
      onDeliveryResult: (r) => {
        reported.push(...r.receipt.platformMessageIds);
      },
    });
    expect(client.sent.length).toBeGreaterThanOrEqual(2);
    for (const s of client.sent) expect(s.body.length).toBeLessThanOrEqual(TEXT_CHUNK_LIMIT);
    expect(client.sent.map((s) => s.body).join(" ").replace(/\s+/g, " ")).toBe(text);
    expect(reported).toEqual(chunks.map((c) => c.result.message_id));
    expect(createAdemuReceipt(chunks).platformMessageIds).toEqual(reported);
  });

  it("a failure on chunk k>1 throws a partial-delivery error carrying the accepted receipts", async () => {
    const client = new FakeAdcClient();
    let calls = 0;
    client.sendText = async (params) => {
      calls++;
      if (calls === 2) throw new Error("daemon says no");
      client.sent.push(params);
      return { message_id: `out-${calls}`, status: "queued" };
    };
    const text = "a".repeat(TEXT_CHUNK_LIMIT) + " " + "b".repeat(10);
    const err = await sendAdemuText({ client, groupId: ROOM_DM, text }).catch((e: unknown) => e);
    expect(isChannelPartialDeliveryError(err)).toBe(true);
    const partial = err as { deliveryResult: { messageIds: string[]; visibleReplySent: boolean } };
    expect(partial.deliveryResult.messageIds).toEqual(["out-1"]);
    expect(partial.deliveryResult.visibleReplySent).toBe(true);
  });

  it("a failure on the first chunk rethrows the original error (nothing was delivered)", async () => {
    const client = new FakeAdcClient();
    client.sendText = async () => {
      throw new Error("boom");
    };
    await expect(sendAdemuText({ client, groupId: ROOM_DM, text: "hi" })).rejects.toThrow("boom");
  });

  it("rejects empty text", async () => {
    await expect(sendAdemuText({ client: new FakeAdcClient(), groupId: ROOM_DM, text: "   " })).rejects.toThrow(/non-empty/);
  });
});

describe("outbound: message adapter", () => {
  it("send.text routes through the registered live client and accepts a prefixed target", async () => {
    const client = new FakeAdcClient();
    registerLiveAccount("main", { client });
    const result = await ademuMessageAdapter.send.text!({ cfg, to: `ademu:${ROOM_DM.toUpperCase()}`, text: "hi", accountId: "main" });
    expect(client.sent).toEqual([{ group_id: ROOM_DM, body: "hi" }]);
    expect(result.messageId).toBe("out-1");
    expect(result.target).toEqual({ kind: "conversation", id: ROOM_DM });
  });

  it("send.text without accountId uses the only running account; with none → AccountNotRunningError", async () => {
    await expect(ademuMessageAdapter.send.text!({ cfg, to: ROOM_DM, text: "hi" })).rejects.toThrow(AccountNotRunningError);
    const client = new FakeAdcClient();
    registerLiveAccount("solo", { client });
    await ademuMessageAdapter.send.text!({ cfg, to: ROOM_DM, text: "hi" });
    expect(client.sent).toHaveLength(1);
  });

  it("rejects a target that is not a conversation id", async () => {
    registerLiveAccount("main", { client: new FakeAdcClient() });
    await expect(ademuMessageAdapter.send.text!({ cfg, to: "alice", text: "hi", accountId: "main" })).rejects.toThrow(/conversation ids/);
  });

  it("proves the declared durable-final text capability", async () => {
    const client = new FakeAdcClient();
    registerLiveAccount("main", { client });
    const results = await verifyChannelMessageAdapterCapabilityProofs({
      adapterName: "ademu",
      adapter: ademuMessageAdapter,
      proofs: {
        text: async () => {
          const r = await ademuMessageAdapter.send.text!({ cfg, to: ROOM_DM, text: "proof", accountId: "main" });
          expect(r.receipt.platformMessageIds).toEqual(["out-1"]);
        },
      },
    });
    expect(results.find((r) => r.capability === "text")?.status).toBe("verified");
    expect(results.filter((r) => r.capability !== "text").every((r) => r.status === "not_declared")).toBe(true);
  });

  it("declares exactly the after_agent_dispatch ack policy (rider R4)", async () => {
    const results = await verifyChannelMessageReceiveAckPolicyAdapterProofs({
      adapterName: "ademu",
      adapter: ademuMessageAdapter,
      proofs: {
        after_agent_dispatch: () => {
          expect(ademuMessageAdapter.receive.defaultAckPolicy).toBe("after_agent_dispatch");
          expect(ademuMessageAdapter.receive.supportedAckPolicies).toEqual(["after_agent_dispatch"]);
        },
      },
    });
    expect(results.find((r) => r.policy === "after_agent_dispatch")?.status).toBe("verified");
    for (const other of ["after_receive_record", "after_durable_send", "manual"]) {
      expect(results.find((r) => r.policy === other)?.status).toBe("not_declared");
    }
  });
});

describe("outbound: messaging block", () => {
  it("target grammar: prefix, lowercase comparison, UUID-only ids", () => {
    expect(ademuMessaging.targetPrefixes).toEqual(["ademu"]);
    expect(ademuMessaging.targetIdComparison).toBe("lowercase");
    expect(ademuMessaging.normalizeTarget!(`ademu:${ROOM_DM.toUpperCase()}`)).toBe(ROOM_DM);
    expect(ademuMessaging.normalizeTarget!("bob")).toBeUndefined();
    expect(ademuMessaging.targetResolver!.looksLikeId!(`ademu:${ROOM_DM}`)).toBe(true);
    expect(ademuMessaging.targetResolver!.looksLikeId!("+15551234567")).toBe(false);
    expect(ademuMessaging.targetResolver!.hint).toBe("<conversation-id>");
  });

  it("infers direct/group from the running account's members cache, defaulting to group", () => {
    expect(ademuMessaging.inferTargetChatType!({ to: ROOM_DM })).toBe("group");
    registerLiveAccount("main", {
      client: new FakeAdcClient(),
      conversationKind: (id) => (id === ROOM_DM ? "direct" : id === ROOM_GROUP ? "group" : undefined),
    });
    expect(ademuMessaging.inferTargetChatType!({ to: `ademu:${ROOM_DM}` })).toBe("direct");
    expect(ademuMessaging.inferTargetChatType!({ to: ROOM_GROUP })).toBe("group");
    expect(ademuMessaging.inferTargetChatType!({ to: OWNER })).toBe("group");
    expect(ademuMessaging.inferTargetChatType!({ to: "nope" })).toBeUndefined();
  });

  it("resolves an outbound session route for a conversation id and null for anything else", () => {
    registerLiveAccount("main", { client: new FakeAdcClient(), conversationKind: (id) => (id === ROOM_DM ? "direct" : undefined) });
    const route = resolveAdemuOutboundSessionRoute({ cfg, agentId: "main", accountId: "main", target: `ademu:${ROOM_DM}` });
    expect(route).not.toBeNull();
    expect(route!.peer).toEqual({ kind: "direct", id: ROOM_DM });
    expect(route!.to).toBe(`ademu:${ROOM_DM}`);
    expect(typeof route!.sessionKey).toBe("string");
    expect(route!.sessionKey.length).toBeGreaterThan(0);
    expect(resolveAdemuOutboundSessionRoute({ cfg, agentId: "main", accountId: "main", target: "alice" })).toBeNull();
  });
});
