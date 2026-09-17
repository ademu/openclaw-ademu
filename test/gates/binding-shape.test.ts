// Binding-shape gate: `src/bindings.ts` mirrors the host's private `applyAgentBindings` (not on any
// public plugin-sdk subpath). A host upgrade that changes the binding shape or its match-key semantics
// must fail HERE, loudly, instead of drifting silently. Pins, against the INSTALLED `openclaw`:
//   1. the declared fields of `AgentBindingMatch` and `AgentRouteBinding`;
//   2. the match key `applyAgentBindings` builds (channel, accountId||"default", peer, guild, team, roles);
//   3. that every binding whose `type` is not "acp" is a route binding.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../..", import.meta.url).pathname;
const DIST = join(ROOT, "node_modules/openclaw/dist");

/** Top-level field names of a `type X = { ... }` declaration (nested object literals skipped). */
function declaredFields(src: string, typeName: string): string[] {
  const start = src.indexOf(`type ${typeName} = {`);
  expect(start, `host declares \`type ${typeName}\``).toBeGreaterThanOrEqual(0);
  let depth = 0;
  let i = src.indexOf("{", start);
  const body: string[] = [];
  for (; i < src.length; i++) {
    const ch = src[i]!;
    if (ch === "{") depth++;
    else if (ch === "}") {
      depth--;
      if (depth === 0) break;
    }
    if (depth === 1) body.push(ch);
  }
  return [...body.join("").matchAll(/^\s*([A-Za-z_][A-Za-z0-9_]*)\??:/gm)].map((m) => m[1]!);
}

function readDist(filter: (name: string) => boolean): Array<{ name: string; src: string }> {
  return readdirSync(DIST)
    .filter(filter)
    .map((name) => ({ name, src: readFileSync(join(DIST, name), "utf8") }));
}

describe("host binding shape pinned by src/bindings.ts", () => {
  const dts = readDist((n) => n.endsWith(".d.ts")).find((f) => f.src.includes("type AgentBindingMatch = {"));

  it("AgentBindingMatch has exactly the six fields the plugin's match key mirrors", () => {
    expect(dts, "a host .d.ts declares AgentBindingMatch").toBeDefined();
    expect(declaredFields(dts!.src, "AgentBindingMatch").sort()).toEqual(["accountId", "channel", "guildId", "peer", "roles", "teamId"]);
  });

  it("AgentRouteBinding has exactly the fields the plugin writes or preserves", () => {
    expect(declaredFields(dts!.src, "AgentRouteBinding").sort()).toEqual(["agentId", "comment", "match", "session", "type"]);
  });

  const chunk = readDist((n) => /^agents\.bindings-.*\.js$/.test(n)).find((f) => f.src.includes("function applyAgentBindings("));

  it("applyAgentBindings still keys a binding on (channel, accountId || \"default\", peer, guildId, teamId, roles)", () => {
    expect(chunk, "a host chunk defines applyAgentBindings").toBeDefined();
    const src = chunk!.src;
    const keyFn = /function bindingMatchKey\(match\) \{[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    const identityFn = /function bindingMatchIdentityKey\(match\) \{[\s\S]*?\n\}/.exec(src)?.[0] ?? "";
    expect(keyFn, "bindingMatchKey present").not.toBe("");
    expect(keyFn).toContain('"default"');
    expect(keyFn).toContain("match.accountId");
    for (const field of ["match.channel", "match.peer?.kind", "match.peer?.id", "match.guildId", "match.teamId", "match.roles"]) {
      expect(identityFn, `identity key uses ${field}`).toContain(field);
    }
    // No seventh axis: every `match.<field>` the identity key reads is one of the six.
    const axes = new Set([...identityFn.matchAll(/match\.([A-Za-z]+)/g)].map((m) => m[1]!));
    expect([...axes].sort()).toEqual(["channel", "guildId", "peer", "roles", "teamId"]);
    // Same-agent → skipped, other agent → conflict (never overwrite).
    expect(src).toMatch(/if \(existingAgentId === agentId\) skipped\.push\(binding\);/);
    expect(src).toMatch(/else conflicts\.push\(/);
  });

  it("every binding whose type is not \"acp\" is a route binding (missing type = route)", () => {
    const routePredicate = readDist((n) => /^bindings-.*\.js$/.test(n)).find((f) => f.src.includes("function isRouteBinding("));
    expect(routePredicate, "a host chunk defines isRouteBinding").toBeDefined();
    expect(routePredicate!.src).toMatch(/return binding\.type === "acp" \? "acp" : "route";/);
  });
});
