// Contract: the daemon's call lines decode with the plugin's types. `fixtures/calls/ipc_v1-calls.ndjson`
// is lines 139–157 (0-based) of AdemuMLS `adc/adc-proto/tests/fixtures/ipc_v1.ndjson` on branch
// `slice/874-agent-joins-call` (6908c8ea) — normative until PROTOCOL.md §Calls is rewritten. Its
// placeholder ids ("g1", "u1") become UUIDs here, as every id on the wire is one.
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { DeviceEvent } from "@ademu/adc-client";
import {
  answerCall,
  CALL_CAPABILITIES,
  declineCall,
  endCall,
  getCall,
  parseCallChanged,
  parseCallEntry,
  parseCallRecord,
  setCallHandling,
  supportsCalls,
} from "../src/calls/protocol.js";
import { describeContent } from "../src/monitor/content.js";

const G1 = "5f0c9a1e-8d2b-4c3a-9e1f-0a1b2c3d4e5f";
const U1 = "0f8fad5b-d9cb-469f-a165-70867728950e";
const CALL = "7b1e6a90-3c4d-4e5f-8a9b-0c1d2e3f4a5b";

const lines = readFileSync(new URL("./fixtures/calls/ipc_v1-calls.ndjson", import.meta.url), "utf8")
  .trim()
  .split("\n")
  .map((l) => JSON.parse(l.replaceAll('"g1"', `"${G1}"`).replaceAll('"u1"', `"${U1}"`)) as Record<string, unknown>);

/** A scripted client that answers each request with the fixture's reply line. */
function scripted(replies: Record<string, Record<string, unknown>>) {
  const sent: Array<Record<string, unknown>> = [];
  return {
    sent,
    request: async <R>(op: string, params?: object): Promise<R> => {
      sent.push({ op, ...params });
      const reply = replies[op]!;
      if (reply.ok === true) return reply.result as R;
      const error = reply.error as { code: string };
      throw Object.assign(new Error(error.code), { code: error.code });
    },
  };
}

const byId = (id: string) => lines.filter((l) => l.id === id);

describe("fixture ipc_v1 lines 139–157 (calls)", () => {
  it("has the lines this test expects", () => {
    expect(lines).toHaveLength(19);
  });

  it("the record decodes as a call (never text or media), uppercase message id and all", () => {
    const rec = lines[0]!;
    expect(rec.event).toBe("message_received");
    const content = describeContent(rec);
    expect(content).toEqual({ kind: "call", record: { call_id: CALL, direction: "incoming", outcome: "missed", media: "video", duration_seconds: undefined } });
    // get_message serves the same record.
    expect(parseCallRecord((lines[1]!.result as { call: unknown }).call)).toMatchObject({ call_id: CALL, outcome: "missed", media: "audio" });
  });

  it("call_changed decodes from a client that knows it AND from one that does not (raw)", () => {
    for (const line of lines.filter((l) => l.event === "call_changed")) {
      const known = parseCallChanged({ ...line, known: true } as unknown as DeviceEvent);
      const raw = parseCallChanged({ known: false, type: "event", seq: line.seq, event: "call_changed", raw: line } as unknown as DeviceEvent);
      expect(known).toEqual(raw);
      expect(known).toMatchObject({ call_id: CALL, group_id: G1, direction: "incoming", participants: [{ user_id: U1, username: "alice", kind: "human" }] });
    }
    const ringing = parseCallChanged({ ...lines[2]!, known: true } as unknown as DeviceEvent)!;
    expect(ringing).toMatchObject({ state: "ringing", media: "video", expires_at_ms: 48000 });
    expect(ringing.outcome).toBeUndefined();
    const ended = parseCallChanged({ ...lines[3]!, known: true } as unknown as DeviceEvent)!;
    expect(ended).toMatchObject({ state: "ended", outcome: "missed" });
    expect(ended.expires_at_ms).toBeUndefined();
  });

  it("set_call_handling: the request shape, the reply, and call_helper_unavailable", async () => {
    const [req, ok, unavailable] = byId("26").concat(byId("27"));
    const client = scripted({ set_call_handling: ok! });
    expect(await setCallHandling(client)).toEqual({ rate: 24000 });
    expect(client.sent[0]).toEqual({ op: req!.op, audio: req!.audio });
    await expect(setCallHandling(scripted({ set_call_handling: unavailable! }))).rejects.toMatchObject({ code: "call_helper_unavailable" });
  });

  it("answer_call / decline_call / end_call: shapes and replies", async () => {
    const [answerReq, answerOk] = byId("28");
    const a = scripted({ answer_call: answerOk! });
    expect(await answerCall(a, CALL)).toEqual({ audio_ticket: (answerOk!.result as { audio_ticket: string }).audio_ticket });
    expect(a.sent[0]).toEqual({ op: answerReq!.op, call_id: answerReq!.call_id });

    const [declineReq, declineOk] = byId("29");
    const d = scripted({ decline_call: declineOk! });
    await declineCall(d, CALL);
    expect(d.sent[0]).toEqual({ op: declineReq!.op, call_id: declineReq!.call_id });

    const [endReq, endUnknown] = byId("30");
    const e = scripted({ end_call: endUnknown! });
    await expect(endCall(e, CALL)).rejects.toMatchObject({ code: "unknown_call" });
    expect(e.sent[0]).toEqual({ op: endReq!.op, call_id: endReq!.call_id });
  });

  it("get_call: an active entry carries a fresh audio ticket", async () => {
    const [req, ok] = byId("31");
    const client = scripted({ get_call: ok! });
    const calls = await getCall(client);
    expect(client.sent[0]).toEqual({ op: req!.op });
    expect(calls).toEqual([
      {
        call_id: CALL,
        group_id: G1,
        state: "active",
        direction: "incoming",
        media: "audio",
        participants: [{ user_id: U1, username: "alice", kind: "human" }],
        audio_ticket: "adca1_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
      },
    ]);
  });

  it("the audio connection's ticket line and ok line are the ones the transport writes and reads", () => {
    const ticketLine = lines.find((l) => "audio_ticket" in l && l.v === 1)!;
    expect(`${JSON.stringify({ v: 1, audio_ticket: ticketLine.audio_ticket })}`).toBe(JSON.stringify(ticketLine));
    expect(lines.at(-1)).toEqual({ ok: true, rate: 24000 });
  });

  it("a ringing entry has no ticket; a malformed ticket is dropped, never passed on", () => {
    const entry = { call_id: CALL, group_id: G1, state: "ringing", direction: "incoming", media: "audio", participants: [] };
    expect(parseCallEntry(entry)).not.toHaveProperty("audio_ticket");
    expect(parseCallEntry({ ...entry, state: "active", audio_ticket: "nope" })).not.toHaveProperty("audio_ticket");
    expect(parseCallEntry({ ...entry, state: "bogus" })).toBeUndefined();
  });

  it("calls are gated on every call capability of the hello", () => {
    expect(supportsCalls(new Set(CALL_CAPABILITIES))).toBe(true);
    expect(supportsCalls(new Set(CALL_CAPABILITIES.filter((c) => c !== "get_call")))).toBe(false);
  });
});
