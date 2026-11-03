// ademu_my_location (owner, 2026-11-03): the asker's OWN live location, read from the daemon per call, only in the
// asker's 1-1 with the agent.
import { afterEach, describe, expect, it } from "vitest";
import { registerLiveAccount, resetLiveAccountsForTests } from "../src/outbound.js";
import { createMyLocationTool } from "../src/tools/my-location.js";

const DM = "55555555-5555-4555-8555-555555555555";
const FAMILY = "11111111-1111-4111-8111-111111111111";
const WORK = "66666666-6666-4666-8666-666666666666";
const TASOS = "33333333-3333-4333-8333-333333333333";
const MARIA = "22222222-2222-4222-8222-222222222222";
const AGENT = "44444444-4444-4444-8444-444444444444";
const NOW = 2_000_000_000_000;

afterEach(() => resetLiveAccountsForTests());

const share = (over: Record<string, unknown> = {}) => ({
  message_id: "l1",
  group_id: DM,
  sender_user_id: TASOS,
  until_ms: NOW + 70 * 60_000,
  share_seq: 4,
  lat: 37.975521,
  lon: 23.734827,
  accuracy_m: 6.5,
  fix_at_ms: NOW - 2 * 60_000,
  ...over,
});

function setup(opts: { shares?: unknown[]; services?: string[]; members?: Record<string, string[]>; fail?: boolean } = {}) {
  const members = opts.members ?? { [DM]: [TASOS, AGENT], [FAMILY]: [TASOS, MARIA, AGENT], [WORK]: [TASOS, AGENT, "giannis"], ["99999999-9999-4999-8999-999999999999"]: [MARIA, AGENT] };
  registerLiveAccount("iris", {
    client: {} as never,
    locations: {
      services: new Set(opts.services ?? ["get_live_locations", "get_members"]),
      getLiveLocations: async () => {
        if (opts.fail) throw new Error("query_failed");
        return { shares: (opts.shares ?? [share()]) as never, as_of: 9 };
      },
      getMembers: async ({ group_id }: { group_id: string }) => {
        if (!(group_id in members)) throw new Error("not_found");
        return { members: members[group_id]!.map((user_id) => ({ user_id, kind: user_id === AGENT ? "agent" : "human" })) } as never;
      },
    } as never,
  });
  const ctx = (conversation: string, sender: string | undefined = TASOS) =>
    ({ messageChannel: "ademu", agentAccountId: "iris", deliveryContext: { channel: "ademu", to: `ademu:${conversation}`, accountId: "iris" }, requesterSenderId: sender }) as never;
  const run = async (c: unknown) => (await createMyLocationTool(c as never, () => NOW)!.execute()).content[0]!.text;
  return { ctx, run };
}

describe("ademu_my_location", () => {
  it("the asker's own share, asked in the chat it was shared in: position, age, time left, map link", async () => {
    const x = setup();
    expect(await x.run(x.ctx(DM))).toBe(
      "Their live location: 37.975521, 23.734827 (±7 m), measured 2 min ago, sharing for 1 h 10 min more.\nhttps://maps.apple.com/?ll=37.975521,23.734827",
    );
  });

  it("never someone else's share", async () => {
    const x = setup({ shares: [share({ sender_user_id: MARIA, group_id: FAMILY })] });
    expect(await x.run(x.ctx(DM, TASOS))).toMatch(/^They are not sharing a live location/);
  });

  it("in the 1-1 it reads the asker's share of any conversation; in a group it refuses, even the group the share is in", async () => {
    const x = setup({ shares: [share({ group_id: FAMILY })] });
    expect(await x.run(x.ctx(DM))).toMatch(/^Their live location: /);
    expect(await x.run(x.ctx(FAMILY))).toMatch(/only read in their 1-1 chat with you/);
    expect(await x.run(x.ctx(WORK))).toMatch(/only read in their 1-1 chat with you/);
  });

  it("someone else's 1-1 with the agent is not the asker's", async () => {
    const x = setup();
    expect(await x.run(x.ctx("99999999-9999-4999-8999-999999999999", TASOS))).toMatch(/only read in their 1-1 chat with you/);
  });

  it("a failed membership lookup, an expired share, an older daemon, a failed query and a turn without a sender all refuse", async () => {
    const lookup = setup();
    expect(await lookup.run(lookup.ctx("88888888-8888-4888-8888-888888888888"))).toMatch(/only read in their 1-1 chat with you/);
    const expired = setup({ shares: [share({ until_ms: NOW - 1 })] });
    expect(await expired.run(expired.ctx(DM))).toMatch(/^They are not sharing/);
    const old = setup({ services: ["get_members"] });
    expect(await old.run(old.ctx(DM))).toMatch(/too old for live locations/);
    const failed = setup({ fail: true });
    await expect(failed.run(failed.ctx(DM))).rejects.toThrow(/failed/);
    const x = setup();
    await expect(x.run(x.ctx(DM, ""))).rejects.toThrow(/only works while answering/);
    expect(createMyLocationTool({ messageChannel: "telegram" } as never)).toBeNull();
  });
});
