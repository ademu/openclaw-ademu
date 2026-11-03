// The live-location tools (openclaw-ademu #33, owner decisions 2026-11-03):
//   ademu_live_locations  — where the people sharing a live location are now, as seen from this conversation;
//   ademu_place           — named places of this conversation ("home"), for distances and watches;
//   ademu_location_watch  — a one-shot watch (one agent turn when it fires) or a report every N minutes (sent by
//                           the plugin itself, no model turn), and listing and cancelling them.
// Every call is scoped to the conversation the current Ademú turn answers, and a share is used only when that
// conversation passes the visibility rule (every member of it can see the share already), read fresh. Nothing
// here is logged with coordinates or names.
import { readStringParam } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import { CHANNEL_ID } from "../config.js";
import { normalizeId, normalizeTarget } from "../grammar.js";
import { strings } from "../i18n/strings.js";
import { cleanPhrases, MIN_REPORT_EVERY_MS, PHRASE_KEYS, type LiveLocationsHandle, type WatchSpec } from "../monitor/location-watch.js";
import type { Share } from "../monitor/locations.js";
import { getLiveAccount, resolveOutboundAccountId } from "../outbound.js";

export const LIVE_LOCATIONS_TOOL = "ademu_live_locations";
export const PLACE_TOOL = "ademu_place";
export const WATCH_TOOL = "ademu_location_watch";

const DEFAULT_RADIUS_M = 300;
const MAX_RADIUS_M = 100_000;
const DEFAULT_STILL_MIN = 10;
const MAX_MINUTES = 24 * 60;
const MAX_PLACE_NAME = 40;

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown };
const text = (msg: string, details: Record<string, unknown> = {}): ToolResult => ({ content: [{ type: "text", text: msg }], details });

export class LocationToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocationToolError";
  }
}

function turnConversation(ctx: OpenClawPluginToolContext): string | undefined {
  if (ctx.messageChannel !== CHANNEL_ID) return undefined;
  const to = ctx.deliveryContext?.channel === CHANNEL_ID ? ctx.deliveryContext.to : undefined;
  return normalizeTarget(to ?? "") ?? normalizeTarget(ctx.nativeChannelId ?? "");
}

function handleFor(ctx: OpenClawPluginToolContext): LiveLocationsHandle {
  try {
    const account = getLiveAccount(resolveOutboundAccountId(ctx.agentAccountId ?? ctx.deliveryContext?.accountId));
    if (account.liveLocations) return account.liveLocations;
  } catch {
    // not running: the same answer as an account without live locations
  }
  throw new LocationToolError(strings.liveLocation.notRunning);
}

function scope(ctx: OpenClawPluginToolContext): { conversation: string; h: LiveLocationsHandle } {
  const conversation = turnConversation(ctx);
  if (!conversation) throw new LocationToolError(strings.liveLocation.noTurn);
  return { conversation, h: handleFor(ctx) };
}

const num = (v: unknown): number | undefined => {
  const n = typeof v === "string" && v.trim() !== "" ? Number(v) : v;
  return typeof n === "number" && Number.isFinite(n) ? n : undefined;
};

function point(args: Record<string, unknown>): { lat: number; lon: number } | undefined {
  const lat = num(args.lat);
  const lon = num(args.lon);
  return lat !== undefined && lon !== undefined && Math.abs(lat) <= 90 && Math.abs(lon) <= 180 ? { lat, lon } : undefined;
}

/** A share visible from this conversation, or a refusal that reveals nothing about it. */
async function visibleShare(h: LiveLocationsHandle, conversation: string, shareId: string | undefined): Promise<Share> {
  const share = shareId ? h.locations.get(shareId) : undefined;
  if (!share || !(await h.canSee(conversation, share))) throw new LocationToolError(strings.liveLocation.unknownShare);
  return share;
}

function placeName(args: Record<string, unknown>): string | undefined {
  const name = readStringParam(args, "name")?.replace(/[\p{Cc}\p{Cf}]/gu, " ").replace(/\s+/g, " ").trim();
  return name && [...name].length <= MAX_PLACE_NAME ? name : undefined;
}

export function createLiveLocationsTool(ctx: OpenClawPluginToolContext) {
  if (ctx.messageChannel !== CHANNEL_ID) return null;
  return {
    label: "Ademú live locations",
    name: LIVE_LOCATIONS_TOOL,
    description:
      "Where the people who share a live location are now, as seen from this conversation: each line has the share_id, the person, the distance to this conversation's places, how old the position is, how long the share lasts, and a map link to put in your answer. Only shares that everyone in this conversation can already see are listed.",
    parameters: Type.Object({}),
    execute: async (): Promise<ToolResult> => {
      const { conversation, h } = scope(ctx);
      const lines: string[] = [];
      for (const share of h.locations.shares()) {
        if (await h.canSee(conversation, share)) lines.push(`share_id=${share.id}\n${h.watches.describe(conversation, share)}`);
      }
      return text(lines.length ? lines.join("\n\n") : strings.liveLocation.none, { count: lines.length });
    },
  };
}

export function createPlaceTool(ctx: OpenClawPluginToolContext) {
  if (ctx.messageChannel !== CHANNEL_ID) return null;
  return {
    label: "Ademú place",
    name: PLACE_TOOL,
    description:
      'Named places of this conversation ("home", "office"), used for distances and watches. save: name + lat/lon (from a location pin the person sent — its line gives the coordinates) or + share_id (where that person is now). list. remove: name. No addresses: a place is coordinates only.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal("save"), Type.Literal("list"), Type.Literal("remove")]),
      name: Type.Optional(Type.String({ description: "The place's name, as the person calls it." })),
      lat: Type.Optional(Type.Number()),
      lon: Type.Optional(Type.Number()),
      share_id: Type.Optional(Type.String({ description: "Save where this share's person is now (from ademu_live_locations)." })),
    }),
    execute: async (_id: string, rawArgs: unknown): Promise<ToolResult> => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const { conversation, h } = scope(ctx);
      const action = readStringParam(args, "action");
      if (action === "list") {
        const places = h.places.list(conversation);
        return text(places.length ? places.map((p) => `${p.name}: ${p.lat}, ${p.lon}`).join("\n") : "No places saved in this conversation.", { count: places.length });
      }
      const name = placeName(args);
      if (!name) throw new LocationToolError(strings.liveLocation.badArgs);
      if (action === "remove") return text(h.places.remove(conversation, name) ? `Removed "${name}".` : strings.liveLocation.unknownPlace(name));
      if (action !== "save") throw new LocationToolError(strings.liveLocation.badArgs);
      const shareId = readStringParam(args, "share_id")?.trim();
      const at = shareId ? await visibleShare(h, conversation, shareId) : point(args);
      if (!at) throw new LocationToolError(strings.liveLocation.badArgs);
      h.places.set(conversation, { name, lat: at.lat, lon: at.lon });
      return text(`Saved "${name}".`);
    },
  };
}

export function createWatchTool(ctx: OpenClawPluginToolContext) {
  if (ctx.messageChannel !== CHANNEL_ID) return null;
  return {
    label: "Ademú location watch",
    name: WATCH_TOOL,
    description:
      'Watch a live location the person asked about (share_id from ademu_live_locations). set with kind: "near" (place name, or lat/lon, + radius_m — fires when the person comes that close), "eta" (place or lat/lon + minutes — fires when they are about that many minutes away at their recent pace, or arrive), "still" (minutes — fires when no new position arrives for that long: stopped, or no signal), "ended" (fires when the share ends) — each fires ONCE, as a new turn in which you tell the person who asked; or "report" (minutes ≥ 1, optional until_minutes, and phrases) — the plugin itself posts where they are every N minutes, pauses when they stop, and ends with the share. The plugin assembles each report from fixed phrases: ALWAYS pass phrases translated into the language the person writes in (keep the {placeholders} and emoji); without them it is English. If the person switches language while a report runs, call update with its id and the phrases in the new language. list, cancel (id). Set only what the person asked for.',
    parameters: Type.Object({
      action: Type.Union([Type.Literal("set"), Type.Literal("update"), Type.Literal("list"), Type.Literal("cancel")]),
      share_id: Type.Optional(Type.String()),
      kind: Type.Optional(Type.Union([Type.Literal("near"), Type.Literal("eta"), Type.Literal("still"), Type.Literal("ended"), Type.Literal("report")])),
      place: Type.Optional(Type.String({ description: "near / eta: a place saved with ademu_place." })),
      lat: Type.Optional(Type.Number()),
      lon: Type.Optional(Type.Number()),
      radius_m: Type.Optional(Type.Number({ description: `near: metres (default ${DEFAULT_RADIUS_M}).` })),
      minutes: Type.Optional(Type.Number({ description: `still: minutes without a new position (default ${DEFAULT_STILL_MIN}); eta: how many minutes away; report: every how many minutes (≥ 1).` })),
      until_minutes: Type.Optional(Type.Number({ description: "report: stop after this many minutes." })),
      id: Type.Optional(Type.String({ description: "update / cancel: the id from set or list." })),
      phrases: Type.Optional(
        Type.Object(
          Object.fromEntries(
            PHRASE_KEYS.map((k) => [k, Type.Optional(Type.String({ description: `English: ${JSON.stringify(strings.liveLocation.reportPhrases[k])}` }))]),
          ),
          { description: "report: the report's fixed phrases in the person's language (each ≤ 200 characters)." },
        ),
      ),
    }),
    execute: async (_id: string, rawArgs: unknown): Promise<ToolResult> => {
      const args = (rawArgs ?? {}) as Record<string, unknown>;
      const { conversation, h } = scope(ctx);
      const action = readStringParam(args, "action");
      if (action === "list") {
        const items = h.watches.list(conversation);
        return text(items.length ? items.map((i) => `${i.id}: ${i.kind} on share_id=${i.shareId}`).join("\n") : "No watches or reports in this conversation.", { count: items.length });
      }
      if (action === "update") {
        const id = readStringParam(args, "id")?.trim() ?? "";
        return text(h.watches.updatePhrases(conversation, id, cleanPhrases(args.phrases)) ? `Report ${id} now uses these phrases.` : `No report ${id} in this conversation.`);
      }
      if (action === "cancel") {
        const id = readStringParam(args, "id")?.trim() ?? "";
        return text(h.watches.cancel(conversation, id) ? `Cancelled ${id}.` : `No watch or report ${id} in this conversation.`);
      }
      if (action !== "set") throw new LocationToolError(strings.liveLocation.badArgs);
      const setter = ctx.requesterSenderId ? normalizeId(ctx.requesterSenderId) : undefined;
      if (!setter) throw new LocationToolError(strings.liveLocation.noTurn);
      const share = await visibleShare(h, conversation, readStringParam(args, "share_id")?.trim());
      const owner = { conversationId: conversation, setterUserId: setter, shareId: share.id };
      const kind = readStringParam(args, "kind");
      const minutes = num(args.minutes);
      if (kind === "report") {
        if (minutes === undefined || minutes * 60_000 < MIN_REPORT_EVERY_MS || minutes > MAX_MINUTES) throw new LocationToolError(strings.liveLocation.badArgs);
        const until = num(args.until_minutes);
        if (until !== undefined && (until <= 0 || until > MAX_MINUTES)) throw new LocationToolError(strings.liveLocation.badArgs);
        const { id } = h.watches.addReport(owner, minutes * 60_000, until === undefined ? undefined : Date.now() + until * 60_000, cleanPhrases(args.phrases));
        return text(`Report ${id} set: every ${minutes} min, ending with the share${until ? ` or in ${until} min` : ""}. Tell the person.`);
      }
      let spec: WatchSpec;
      if (kind === "ended") spec = { kind: "ended" };
      else if (kind === "still") {
        const m = minutes ?? DEFAULT_STILL_MIN;
        if (m < 1 || m > MAX_MINUTES) throw new LocationToolError(strings.liveLocation.badArgs);
        spec = { kind: "still", minutes: m };
      } else if (kind === "near" || kind === "eta") {
        const radiusM = num(args.radius_m) ?? DEFAULT_RADIUS_M;
        if (kind === "near" && (radiusM <= 0 || radiusM > MAX_RADIUS_M)) throw new LocationToolError(strings.liveLocation.badArgs);
        if (kind === "eta" && (minutes === undefined || minutes < 1 || minutes > MAX_MINUTES)) throw new LocationToolError(strings.liveLocation.badArgs);
        const placeArg = readStringParam(args, "place")?.trim();
        let target: { lat: number; lon: number } | undefined;
        let label: string;
        if (placeArg) {
          const found = h.places.list(conversation).find((p) => p.name.toLocaleLowerCase("und") === placeArg.toLocaleLowerCase("und"));
          if (!found) throw new LocationToolError(strings.liveLocation.unknownPlace(placeArg));
          target = found;
          label = found.name;
        } else {
          target = point(args);
          label = "the point you were given";
        }
        if (!target) throw new LocationToolError(strings.liveLocation.badArgs);
        spec =
          kind === "near"
            ? { kind: "near", point: { lat: target.lat, lon: target.lon }, label, radiusM }
            : { kind: "eta", point: { lat: target.lat, lon: target.lon }, label, minutes: minutes! };
      } else throw new LocationToolError(strings.liveLocation.badArgs);
      const r = h.watches.addWatch(owner, spec);
      if ("already" in r) return text("That is already true now — nothing was set. Tell the person.");
      return text(`Watch ${r.id} set (${spec.kind}); it fires once. Tell the person.`);
    },
  };
}

export function registerLocationTools(api: OpenClawPluginApi): void {
  api.registerTool((ctx) => createLiveLocationsTool(ctx) as never, { name: LIVE_LOCATIONS_TOOL });
  api.registerTool((ctx) => createPlaceTool(ctx) as never, { name: PLACE_TOOL });
  api.registerTool((ctx) => createWatchTool(ctx) as never, { name: WATCH_TOOL });
}
