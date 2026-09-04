import type { MemberEntry } from "@ademu/adc-client";
import { describe, expect, it } from "vitest";
import { classifyConversation, describeConversation, displayNameOf, looksLikeId, normalizeTarget } from "../src/grammar.js";
import { resolveSenderRole } from "../src/roles.js";

const OWNER = "0f8fad5b-d9cb-469f-a165-70867728950e";
const AGENT = "7c9e6679-7425-40de-944b-e07fc1f90ae7";
const GUEST = "16fd2706-8baf-433b-82eb-8c7fada847da";

const member = (user_id: string, kind = "human", display_name = "", username = ""): MemberEntry => ({
  user_id,
  kind,
  display_name,
  username,
});

describe("grammar: ids and targets", () => {
  it("looksLikeId accepts UUIDs in any case and rejects everything else", () => {
    expect(looksLikeId(OWNER)).toBe(true);
    expect(looksLikeId(OWNER.toUpperCase())).toBe(true);
    expect(looksLikeId(" " + OWNER + " ")).toBe(true);
    expect(looksLikeId("alice")).toBe(false);
    expect(looksLikeId("+15551234567")).toBe(false);
    expect(looksLikeId(OWNER.slice(1))).toBe(false);
  });

  it("normalizeTarget strips the channel prefix and lowercases; non-ids resolve to undefined", () => {
    expect(normalizeTarget(`ademu:${OWNER.toUpperCase()}`)).toBe(OWNER);
    expect(normalizeTarget(OWNER)).toBe(OWNER);
    expect(normalizeTarget("ademu:bob")).toBeUndefined();
  });
});

describe("grammar: conversation classification by membership", () => {
  it("owner + agent = direct", () => {
    const shape = classifyConversation({ members: [member(OWNER), member(AGENT, "agent")], agentUserId: AGENT, ownerUserId: OWNER });
    expect(shape.kind).toBe("direct");
    expect(shape.ownerOnly).toBe(true);
  });

  it("a stranger + agent is a group shape (DM from a non-owner — the allowlist drops it later)", () => {
    const shape = classifyConversation({ members: [member(GUEST), member(AGENT, "agent")], agentUserId: AGENT, ownerUserId: OWNER });
    expect(shape.kind).toBe("group");
    expect(shape.ownerOnly).toBe(false);
  });

  it("owner + guest + agent = group", () => {
    const shape = classifyConversation({
      members: [member(OWNER), member(GUEST), member(AGENT, "agent")],
      agentUserId: AGENT,
      ownerUserId: OWNER,
    });
    expect(shape.kind).toBe("group");
    expect(shape.others).toHaveLength(2);
  });

  it("an empty member list is a group (conservative)", () => {
    expect(classifyConversation({ members: [], agentUserId: AGENT, ownerUserId: OWNER }).kind).toBe("group");
  });

  it("ids compare case-insensitively", () => {
    const shape = classifyConversation({ members: [member(OWNER.toUpperCase()), member(AGENT)], agentUserId: AGENT.toUpperCase(), ownerUserId: OWNER });
    expect(shape.kind).toBe("direct");
  });
});

describe("grammar: display", () => {
  it("marks agent members with 🤖 and falls back to username", () => {
    expect(displayNameOf(member(GUEST, "agent", "Iris"))).toBe("🤖 Iris");
    expect(displayNameOf(member(GUEST, "human", "", "alice"))).toBe("alice");
    expect(displayNameOf(member(GUEST, "human"))).toBe("");
  });

  it("describes direct chats and rooms without leaking ids", () => {
    const direct = classifyConversation({ members: [member(OWNER, "human", "Marios"), member(AGENT, "agent")], agentUserId: AGENT, ownerUserId: OWNER });
    expect(describeConversation(direct, "Iris")).toBe("Direct chat with Marios");
    const room = classifyConversation({
      members: [member(OWNER, "human", "Marios"), member(GUEST, "human", "", "jhessy"), member(AGENT, "agent")],
      agentUserId: AGENT,
      ownerUserId: OWNER,
    });
    const label = describeConversation(room, "Iris");
    expect(label).toBe("Room: Marios, jhessy + Iris");
    expect(label).not.toContain(OWNER);
  });
});

describe("roles", () => {
  it("owner is the owner, everyone else is other; unknown owner → other", () => {
    expect(resolveSenderRole(OWNER, OWNER)).toBe("owner");
    expect(resolveSenderRole(OWNER.toUpperCase(), OWNER)).toBe("owner");
    expect(resolveSenderRole(GUEST, OWNER)).toBe("other");
    expect(resolveSenderRole(OWNER, undefined)).toBe("other");
  });
});
