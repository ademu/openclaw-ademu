// Routing bindings (`cfg.bindings`) written by the chat door (plan T13 follow-up, 2026-09-17): a
// chat-enrolled Ademú account is routed to the enrolling agent exactly like the wizard's routing step
// does. OpenClaw's own `applyAgentBindings` lives in a private dist chunk (not on any public
// `openclaw/plugin-sdk/*` subpath), so this module mirrors its account-scoped semantics with pure
// functions over the whole config:
//   - a route binding is every binding whose `type` is not "acp" (a missing type means route);
//   - the match key is (channel, accountId || "default", peer, guildId, teamId, roles);
//   - same key + same agent → nothing to do; same key + another agent → conflict, never overwrite;
//   - non-route bindings are preserved after the routes, in host order.
// Deliberate divergence: the host "upgrades" a same-agent channel-wide binding (no accountId) in place;
// this module appends an account-scoped row instead — a chat tool never mutates a binding it did not
// write. `test/gates/binding-shape.test.ts` pins the host shape this mirrors.
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";

export type RouteBindingMatch = {
  channel: string;
  /** Omitted/empty = the channel default account; "*" = every account; else that account id. */
  accountId?: string;
  peer?: { kind: string; id: string };
  guildId?: string;
  teamId?: string;
  roles?: string[];
};

export type RouteBinding = {
  /** Missing type is a route binding (host back-compat). */
  type?: "route";
  agentId: string;
  comment?: string;
  match: RouteBindingMatch;
  session?: unknown;
};

/** Any configured binding: routes plus the host's other kinds (`type: "acp"`), kept opaque. */
type AnyBinding = { type?: string; agentId?: string; match?: Partial<RouteBindingMatch> } & Record<string, unknown>;

type BindingsConfig = OpenClawConfig & { bindings?: unknown };

/** Thrown when `{ channel, accountId }` is already routed to a different agent. */
export class RouteBindingConflictError extends Error {
  constructor(
    readonly accountId: string,
    readonly existingAgentId: string,
  ) {
    super(`ademu:${accountId} is already routed to agent "${existingAgentId}"`);
    this.name = "RouteBindingConflictError";
  }
}

function listBindings(cfg: OpenClawConfig): AnyBinding[] {
  const raw = (cfg as BindingsConfig).bindings;
  return Array.isArray(raw) ? (raw as AnyBinding[]) : [];
}

/** Host parity (`normalizeBindingType`): everything that is not `acp` is a route binding. */
function isRouteBinding(b: AnyBinding): b is RouteBinding & AnyBinding {
  return b.type !== "acp" && typeof b.agentId === "string" && typeof b.match?.channel === "string";
}

/** Exactly the account-scoped shape this plugin writes: no peer/guild/team/roles axes. */
function isAccountScoped(match: Partial<RouteBindingMatch>, channel: string): boolean {
  return match.channel === channel && !match.peer && !match.guildId && !match.teamId && (match.roles ?? []).length === 0;
}

function accountKey(accountId: string | undefined): string {
  const trimmed = accountId?.trim();
  return trimmed ? normalizeAccountId(trimmed) : "default";
}

/** The route binding (if any) whose match is exactly `{ channel, accountId }`. */
export function findRouteBinding(cfg: OpenClawConfig, p: { channel: string; accountId: string }): RouteBinding | undefined {
  const wanted = accountKey(p.accountId);
  return listBindings(cfg).find((b) => isRouteBinding(b) && isAccountScoped(b.match, p.channel) && accountKey(b.match.accountId) === wanted) as
    | RouteBinding
    | undefined;
}

/**
 * Appends `{ agentId, match: { channel, accountId } }` (the wizard's shape: no `type` key). An existing
 * row for the same account and the same agent leaves the config untouched (same reference); one for
 * another agent throws `RouteBindingConflictError` and writes nothing.
 */
export function applyRouteBinding(cfg: OpenClawConfig, p: { channel: string; accountId: string; agentId: string }): OpenClawConfig {
  const accountId = normalizeAccountId(p.accountId);
  const existing = findRouteBinding(cfg, { channel: p.channel, accountId });
  if (existing) {
    if (existing.agentId === p.agentId) return cfg;
    throw new RouteBindingConflictError(accountId, existing.agentId);
  }
  const all = listBindings(cfg);
  const routes = all.filter((b) => b.type !== "acp");
  const others = all.filter((b) => b.type === "acp");
  const added: RouteBinding = { agentId: p.agentId, match: { channel: p.channel, accountId } };
  return { ...cfg, bindings: [...routes, added, ...others] } as OpenClawConfig;
}

/**
 * Removes the route bindings whose match is exactly `{ channel, accountId }`. Returns the same
 * reference when nothing matches; drops the `bindings` key when the list empties.
 */
export function pruneRouteBindings(cfg: OpenClawConfig, p: { channel: string; accountId: string }): OpenClawConfig {
  const all = listBindings(cfg);
  const wanted = accountKey(p.accountId);
  const kept = all.filter((b) => !(isRouteBinding(b) && isAccountScoped(b.match, p.channel) && accountKey(b.match.accountId) === wanted));
  if (kept.length === all.length) return cfg;
  if (kept.length === 0) {
    const { bindings: _removed, ...rest } = cfg as BindingsConfig;
    return rest as OpenClawConfig;
  }
  return { ...cfg, bindings: kept } as OpenClawConfig;
}
