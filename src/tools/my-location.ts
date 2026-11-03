// The `ademu_my_location` tool (owner, 2026-11-03): where the person the agent is answering is now, read from the
// live location THEY share — never anyone else's ("where is X" for another person was dropped, openclaw-ademu#37).
//
// The plugin keeps no position state: a live share's positions never reach the agent (#35), and this asks the
// daemon at call time (`get_live_locations`, adc ≥ 1.1.0, AdemuMLS #941), which holds each share's latest applied
// position. Whose share it is comes from the host's trusted `requesterSenderId`, never from the model's arguments.
// It answers only in a conversation whose every member can already see that share (memberships read fresh, a
// failed lookup is "no"): asked in the chat the share was sent to, it answers; in a room with someone who cannot
// see it, it does not. Nothing here is logged with ids or coordinates.
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import { CHANNEL_ID } from "../config.js";
import { normalizeId, normalizeTarget } from "../grammar.js";
import { strings } from "../i18n/strings.js";
import { getLiveAccount, resolveOutboundAccountId, type LocationClient } from "../outbound.js";

export const MY_LOCATION_TOOL = "ademu_my_location";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown };
const text = (msg: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text: msg }], details });

export class MyLocationToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MyLocationToolError";
  }
}

function turnConversation(ctx: OpenClawPluginToolContext): string | undefined {
  if (ctx.messageChannel !== CHANNEL_ID) return undefined;
  const to = ctx.deliveryContext?.channel === CHANNEL_ID ? ctx.deliveryContext.to : undefined;
  return normalizeTarget(to ?? "") ?? normalizeTarget(ctx.nativeChannelId ?? "");
}

function locationClientFor(ctx: OpenClawPluginToolContext): LocationClient {
  try {
    const account = getLiveAccount(resolveOutboundAccountId(ctx.agentAccountId ?? ctx.deliveryContext?.accountId));
    if (account.locations) return account.locations;
  } catch {
    // not running: the same answer as an account without the handle
  }
  throw new MyLocationToolError(strings.myLocation.notRunning);
}

/** Every member of `conversationId` is a member of `groupId` (fresh lookups; a failure is "no"). */
async function everyoneCanSee(client: LocationClient, conversationId: string, groupId: string): Promise<boolean> {
  if (normalizeId(groupId) === conversationId) return true;
  try {
    const [here, there] = await Promise.all([client.getMembers({ group_id: conversationId }), client.getMembers({ group_id: groupId })]);
    if (here.members.length === 0) return false;
    const inGroup = new Set(there.members.map((m) => normalizeId(m.user_id)));
    return here.members.every((m) => inGroup.has(normalizeId(m.user_id)));
  } catch {
    return false;
  }
}

function span(ms: number): string {
  const min = Math.max(0, Math.round(ms / 60_000));
  if (min < 1) return "under a minute";
  if (min < 60) return `${min} min`;
  return `${Math.floor(min / 60)} h ${min % 60} min`;
}

export function createMyLocationTool(ctx: OpenClawPluginToolContext, now: () => number = () => Date.now()) {
  if (ctx.messageChannel !== CHANNEL_ID) return null;
  return {
    label: strings.myLocation.label,
    name: MY_LOCATION_TOOL,
    description: strings.myLocation.description,
    parameters: Type.Object({}),
    execute: async (): Promise<ToolResult> => {
      const conversation = turnConversation(ctx);
      const asker = ctx.requesterSenderId ? normalizeId(ctx.requesterSenderId) : undefined;
      if (!conversation || !asker) throw new MyLocationToolError(strings.myLocation.noTurn);
      const client = locationClientFor(ctx);
      if (!client.services.has("get_live_locations")) return text(strings.myLocation.tooOld, { reason: "too_old" });
      let shares;
      try {
        shares = (await client.getLiveLocations()).shares;
      } catch {
        throw new MyLocationToolError(strings.myLocation.failed);
      }
      const t = now();
      const mine = shares.filter((s) => normalizeId(s.sender_user_id) === asker && s.until_ms > t);
      const lines: string[] = [];
      for (const s of mine) {
        if (!(await everyoneCanSee(client, conversation, s.group_id))) continue;
        lines.push(
          strings.myLocation.share({
            coords: `${s.lat}, ${s.lon}`,
            accuracy: Number.isFinite(s.accuracy_m) && s.accuracy_m > 0 ? `${Math.round(s.accuracy_m)} m` : "",
            age: t - s.fix_at_ms < 60_000 ? "just now" : `${span(t - s.fix_at_ms)} ago`,
            left: span(s.until_ms - t),
            map: `https://maps.apple.com/?ll=${s.lat.toFixed(6)},${s.lon.toFixed(6)}`,
          }),
        );
      }
      return text(lines.length ? lines.join("\n\n") : strings.myLocation.none, { count: lines.length });
    },
  };
}

export function registerMyLocationTool(api: OpenClawPluginApi): void {
  api.registerTool((ctx) => createMyLocationTool(ctx) as never, { name: MY_LOCATION_TOOL });
}
