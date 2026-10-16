// `ademu_end_call` (openclaw-ademu#30): offered only inside a live call's consult session, and it can
// end only that session's call, whichever running account holds it.
import { afterEach, describe, expect, it } from "vitest";
import { callIdOfSession, createEndCallTool, END_CALL_TOOL_NAME } from "../src/tools/calls.js";
import { registerLiveAccount, resetLiveAccountsForTests, type LiveAccount } from "../src/outbound.js";

const CALL = "7b1e6a90-3c4d-4e5f-8a9b-0c1d2e3f4a5b";
const consult = `agent:main:subagent:ademu-call:${CALL.toUpperCase()}`;

function account(current: string | undefined): LiveAccount & { asked: string[] } {
  const asked: string[] = [];
  return {
    asked,
    client: {} as never,
    calls: {
      endAfterReply: (id) => {
        asked.push(id);
        return id === current;
      },
    },
  };
}

afterEach(() => resetLiveAccountsForTests());

describe("ademu_end_call", () => {
  it("names the call only for a call's consult session", () => {
    expect(callIdOfSession(consult)).toBe(CALL);
    expect(callIdOfSession(`agent:main:ademu:${CALL}`)).toBeUndefined();
    expect(callIdOfSession(`agent:main:subagent:google-meet:${CALL}`)).toBeUndefined();
    expect(callIdOfSession(`agent:main:subagent:ademu-call:not-an-id`)).toBeUndefined();
    expect(callIdOfSession(undefined)).toBeUndefined();
  });

  it("is not offered in a chat turn, only inside a call", () => {
    expect(createEndCallTool({ sessionKey: "agent:main:ademu:x", messageChannel: "ademu" }, { log: () => {} })).toBeNull();
    expect(createEndCallTool({ sessionKey: consult, messageChannel: "ademu" }, { log: () => {} })?.name).toBe(END_CALL_TOOL_NAME);
  });

  it("ends the session's call on the account that holds it, and says so", async () => {
    const other = account(undefined);
    const holder = account(CALL);
    registerLiveAccount("other", other);
    registerLiveAccount("iris", holder);
    const logs: Array<Record<string, unknown> | undefined> = [];
    const tool = createEndCallTool({ sessionKey: consult }, { log: (_e, f) => logs.push(f) })!;
    const res = await tool.execute();
    expect(holder.asked).toEqual([CALL]);
    expect(res.details).toEqual({ ending: true });
    expect(res.content[0]!.text).toMatch(/after your reply/);
    expect(logs).toEqual([{ ending: true }]);
  });

  it("a call that is already over: the agent is told, nothing ends", async () => {
    registerLiveAccount("iris", account(undefined));
    const res = await createEndCallTool({ sessionKey: consult }, { log: () => {} })!.execute();
    expect(res.details).toEqual({ ending: false });
  });
});
