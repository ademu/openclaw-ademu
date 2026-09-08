import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { describe, expect, it } from "vitest";
import {
  agentNames,
  computeWasMentioned,
  createAdemuIngressResolver,
  decideMention,
  openclawMentionRegexes,
  resolveMessageAccess,
  resolveRequireMention,
  textAddresses,
} from "../src/security.js";

const OWNER = "0f8fad5b-d9cb-469f-a165-70867728950e";
const GUEST = "16fd2706-8baf-433b-82eb-8c7fada847da";
const ROOM = "9b2b6d1e-3c1a-4f8e-9a1b-2c3d4e5f6a7b";

const cfg = {
  channels: { ademu: { accounts: { iris: { deviceId: "d", token: "t", ownerUserId: OWNER } } } },
  agents: { entries: { main: { identity: { name: "Iris" } } } },
} as unknown as OpenClawConfig;

const resolver = createAdemuIngressResolver({ accountId: "iris", cfg });

describe("DM allowlist = [owner] (decision 5)", () => {
  it("the owner is allowed in a direct conversation", async () => {
    const access = await resolveMessageAccess({
      resolver,
      senderUserId: OWNER.toUpperCase(),
      ownerUserId: OWNER,
      conversation: { kind: "direct", id: ROOM },
      commandRequested: false,
    });
    expect(access.senderAccess.allowed).toBe(true);
  });

  it("a stranger is denied in a direct conversation", async () => {
    const access = await resolveMessageAccess({
      resolver,
      senderUserId: GUEST,
      ownerUserId: OWNER,
      conversation: { kind: "direct", id: ROOM },
      commandRequested: false,
    });
    expect(access.senderAccess.allowed).toBe(false);
  });

  it("with no owner known yet, nobody is allowed in DMs (fail closed)", async () => {
    const access = await resolveMessageAccess({
      resolver,
      senderUserId: OWNER,
      ownerUserId: undefined,
      conversation: { kind: "direct", id: ROOM },
      commandRequested: false,
    });
    expect(access.senderAccess.allowed).toBe(false);
  });
});

describe("rooms are open behind membership; commands belong to the owner", () => {
  it("a guest may speak in a room (membership is the gate)", async () => {
    const access = await resolveMessageAccess({
      resolver,
      senderUserId: GUEST,
      ownerUserId: OWNER,
      conversation: { kind: "group", id: ROOM },
      commandRequested: false,
    });
    expect(access.senderAccess.allowed).toBe(true);
  });

  it("the owner is command-authorized, a guest is not", async () => {
    const owner = await resolveMessageAccess({
      resolver,
      senderUserId: OWNER,
      ownerUserId: OWNER,
      conversation: { kind: "group", id: ROOM },
      commandRequested: true,
    });
    expect(owner.commandAccess.requested).toBe(true);
    expect(owner.commandAccess.authorized).toBe(true);
    const guest = await resolveMessageAccess({
      resolver,
      senderUserId: GUEST,
      ownerUserId: OWNER,
      conversation: { kind: "group", id: ROOM },
      commandRequested: true,
    });
    expect(guest.commandAccess.authorized).toBe(false);
  });

  it("a context-bound resolve is accepted and carries the same decision", async () => {
    const access = await resolveMessageAccess({
      resolver,
      senderUserId: OWNER,
      ownerUserId: OWNER,
      conversation: { kind: "direct", id: ROOM },
      commandRequested: false,
      contextBinding: { agentId: "main", sessionKey: "agent:main:main", messageId: "m1", inboundEventKind: "user_request" },
    });
    expect(access.senderAccess.allowed).toBe(true);
  });
});

describe("mentions: owner always heard, guests when addressed", () => {
  const names = agentNames({ displayName: "Iris", username: "iris_agent", agentName: "Iris", aliases: ["Ίρις", "helper"] });

  it("collects unique names from display name, username, agent name and aliases", () => {
    expect(names).toEqual(["Iris", "iris_agent", "Ίρις", "helper"]);
  });

  it("matches whole words case-insensitively, incl. Unicode, and not partial words", () => {
    expect(textAddresses("hey iris, thoughts?", names)).toBe(true);
    expect(textAddresses("@IRIS_AGENT please", names)).toBe(true);
    expect(textAddresses("Ίρις τι λες;", names)).toBe(true);
    expect(textAddresses("Irisa is here", names)).toBe(false);
    expect(textAddresses("helpers unite", names)).toBe(false);
    expect(textAddresses("no name here", names)).toBe(false);
  });

  it("the owner is always mentioned; a guest only when addressing", () => {
    expect(computeWasMentioned({ text: "anything", senderRole: "owner", names })).toBe(true);
    expect(computeWasMentioned({ text: "anything", senderRole: "other", names })).toBe(false);
    expect(computeWasMentioned({ text: "Iris?", senderRole: "other", names })).toBe(true);
  });

  it("OpenClaw's own identity patterns count too", () => {
    const regexes = openclawMentionRegexes(cfg, "main");
    expect(computeWasMentioned({ text: "@Iris hello", senderRole: "other", names: [], mentionRegexes: regexes })).toBe(true);
  });

  it("requireMention defaults to true per room and honours channels.ademu.groups", () => {
    expect(resolveRequireMention({ cfg, groupId: ROOM, accountId: "iris" })).toBe(true);
    const relaxed = {
      ...cfg,
      channels: { ademu: { ...(cfg as { channels: { ademu: object } }).channels.ademu, groups: { [ROOM]: { requireMention: false } } } },
    } as unknown as OpenClawConfig;
    expect(resolveRequireMention({ cfg: relaxed, groupId: ROOM.toUpperCase(), accountId: "iris" })).toBe(false);
  });

  it("the mention decision skips unaddressed guests in rooms, never the owner, and lets an authorized command through", () => {
    const guest = decideMention({ isGroup: true, requireMention: true, wasMentioned: false, hasControlCommand: false, commandAuthorized: false });
    expect(guest.shouldSkip).toBe(true);
    const owner = decideMention({ isGroup: true, requireMention: true, wasMentioned: true, hasControlCommand: false, commandAuthorized: true });
    expect(owner.shouldSkip).toBe(false);
    expect(owner.effectiveWasMentioned).toBe(true);
    const cmd = decideMention({ isGroup: true, requireMention: true, wasMentioned: false, hasControlCommand: true, commandAuthorized: true });
    expect(cmd.shouldSkip).toBe(false);
    const dm = decideMention({ isGroup: false, requireMention: true, wasMentioned: false, hasControlCommand: false, commandAuthorized: false });
    expect(dm.shouldSkip).toBe(false);
  });
});
