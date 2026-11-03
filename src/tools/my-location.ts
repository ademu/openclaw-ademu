// The `ademu_my_location` tool (owner, 2026-11-03): where the person the agent is answering is now, read from the
// live location THEY share — never anyone else's ("where is X" for another person was dropped, openclaw-ademu#37).
//
// The plugin keeps no position state: a live share's positions never reach the agent (#35), and this asks the
// daemon at call time (`get_live_locations`, adc ≥ 1.1.0, AdemuMLS #941), which holds each share's latest applied
// position. Whose share it is comes from the host's trusted `requesterSenderId`, never from the model's arguments.
// It answers only in the asker's 1-1 with this agent (the conversation's fresh members are exactly the asker and an
// agent; a failed lookup is "no"): there the position reaches nobody but its own sharer, whatever conversation the
// share lives in. In a room it refuses — membership cannot prove who sees a share (a member added mid-share shows
// nothing, AdemuMLS DECISIONS §4.29), so a room answer could reach someone the person never shared with.
// Accepted residual (owner, 2026-11-03): Ademú has no direct-chat marker — a 1-1 is a two-member conversation — and
// the reply is not re-checked at delivery, so a third member added in the seconds between this call and the agent's
// reply would see the asker's own position. Nothing here is logged with ids or coordinates.
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

/** The conversation is the asker's 1-1 with this agent: exactly two members, the asker and an agent (fresh lookup). */
async function isAskersOneToOne(client: LocationClient, conversationId: string, asker: string): Promise<boolean> {
  try {
    const { members } = await client.getMembers({ group_id: conversationId });
    return members.length === 2 && members.some((m) => normalizeId(m.user_id) === asker) && members.some((m) => normalizeId(m.user_id) !== asker && m.kind === "agent");
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
      if (!(await isAskersOneToOne(client, conversation, asker))) return text(strings.myLocation.notOneToOne, { reason: "not_one_to_one" });
      const t = now();
      const mine = shares.filter((s) => normalizeId(s.sender_user_id) === asker && s.until_ms > t);
      const lines: string[] = [];
      for (const s of mine) {
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
