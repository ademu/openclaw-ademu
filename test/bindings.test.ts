import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { describe, expect, it } from "vitest";
import { applyRouteBinding, findRouteBinding, pruneRouteBindings, RouteBindingConflictError } from "../src/bindings.js";

type Cfg = { bindings?: unknown[] } & Record<string, unknown>;
const cfg = (o: Cfg = {}): OpenClawConfig => o as unknown as OpenClawConfig;
const bindings = (c: OpenClawConfig): unknown[] | undefined => (c as unknown as Cfg).bindings;

const IRIS = { agentId: "iris", match: { channel: "ademu", accountId: "iris" } };
const LEDGER_ALL = { agentId: "ledger", match: { channel: "ademu", accountId: "*" } };
const LEDGER_PEER = { agentId: "ledger", match: { channel: "ademu", accountId: "iris", peer: { kind: "group", id: "g1" } } };
const TELEGRAM = { agentId: "iris", match: { channel: "telegram", accountId: "iris" } };
const ACP = { type: "acp", agentId: "x", match: { channel: "ademu", accountId: "iris" } };

describe("applyRouteBinding (mirrors the host's account-scoped applyAgentBindings)", () => {
  it("appends the wizard's shape (no `type` key) to a config without bindings, without mutating the input", () => {
    const input = cfg({ channels: { ademu: { enabled: true } } });
    const out = applyRouteBinding(input, { channel: "ademu", accountId: "iris", agentId: "iris" });
    expect(bindings(out)).toEqual([IRIS]);
    expect(bindings(input)).toBeUndefined();
    expect((out as unknown as Cfg).channels).toBe((input as unknown as Cfg).channels);
  });

  it("same account, same agent → the same config reference (idempotent)", () => {
    const input = cfg({ bindings: [IRIS] });
    expect(applyRouteBinding(input, { channel: "ademu", accountId: "iris", agentId: "iris" })).toBe(input);
    // the account id is normalized before comparison
    expect(applyRouteBinding(input, { channel: "ademu", accountId: " Iris ", agentId: "iris" })).toBe(input);
  });

  it("same account, another agent → RouteBindingConflictError, nothing written", () => {
    const input = cfg({ bindings: [{ agentId: "ledger", match: { channel: "ademu", accountId: "iris" } }] });
    let caught: unknown;
    try {
      applyRouteBinding(input, { channel: "ademu", accountId: "iris", agentId: "iris" });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RouteBindingConflictError);
    expect(caught).toMatchObject({ accountId: "iris", existingAgentId: "ledger" });
    expect(bindings(input)).toHaveLength(1);
  });

  it("wildcard, peer-scoped, other-channel and non-route rows are not conflicts, are preserved, and the new row lands after the routes", () => {
    const input = cfg({ bindings: [LEDGER_ALL, LEDGER_PEER, TELEGRAM, ACP] });
    const out = applyRouteBinding(input, { channel: "ademu", accountId: "iris", agentId: "iris" });
    expect(bindings(out)).toEqual([LEDGER_ALL, LEDGER_PEER, TELEGRAM, IRIS, ACP]);
  });

  it("does NOT upgrade a same-agent channel-wide row in place (host divergence): it appends an account-scoped row", () => {
    const wide = { agentId: "iris", match: { channel: "ademu" } };
    const out = applyRouteBinding(cfg({ bindings: [wide] }), { channel: "ademu", accountId: "iris", agentId: "iris" });
    expect(bindings(out)).toEqual([wide, IRIS]);
  });

  it("a channel-wide row (no accountId) keys as the default account: it conflicts only with accountId \"default\"", () => {
    const wide = { agentId: "ledger", match: { channel: "ademu" } };
    expect(() => applyRouteBinding(cfg({ bindings: [wide] }), { channel: "ademu", accountId: "default", agentId: "iris" })).toThrow(RouteBindingConflictError);
    expect(bindings(applyRouteBinding(cfg({ bindings: [wide] }), { channel: "ademu", accountId: "iris", agentId: "iris" }))).toEqual([wide, IRIS]);
  });
});

describe("findRouteBinding", () => {
  it("finds only the exact account-scoped row for the channel", () => {
    const c = cfg({ bindings: [LEDGER_ALL, LEDGER_PEER, TELEGRAM, ACP, IRIS] });
    expect(findRouteBinding(c, { channel: "ademu", accountId: "iris" })).toEqual(IRIS);
    expect(findRouteBinding(c, { channel: "ademu", accountId: "bob" })).toBeUndefined();
    expect(findRouteBinding(cfg(), { channel: "ademu", accountId: "iris" })).toBeUndefined();
  });
});

describe("pruneRouteBindings", () => {
  it("removes exactly the account-scoped row and keeps wildcard, peer-scoped, other-channel and non-route rows", () => {
    const out = pruneRouteBindings(cfg({ bindings: [IRIS, LEDGER_ALL, LEDGER_PEER, TELEGRAM, ACP] }), { channel: "ademu", accountId: "iris" });
    expect(bindings(out)).toEqual([LEDGER_ALL, LEDGER_PEER, TELEGRAM, ACP]);
  });

  it("returns the same reference when nothing matches", () => {
    const input = cfg({ bindings: [LEDGER_ALL] });
    expect(pruneRouteBindings(input, { channel: "ademu", accountId: "iris" })).toBe(input);
    const none = cfg({ channels: {} });
    expect(pruneRouteBindings(none, { channel: "ademu", accountId: "iris" })).toBe(none);
  });

  it("drops the `bindings` key when the list empties", () => {
    const out = pruneRouteBindings(cfg({ bindings: [IRIS], channels: {} }), { channel: "ademu", accountId: "iris" });
    expect(Object.keys(out)).toEqual(["channels"]);
  });
});
