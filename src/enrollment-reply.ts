// Reply-to-confirm: on channels without plugin buttons, the human's yes / no is a QUOTED REPLY to the
// plugin's own words message. OpenClaw's typed `before_dispatch` hook runs on every inbound agent-bound
// message before the model; the first handler returning `{ handled: true }` wins, its `text` is
// delivered through the normal final-reply path, and the model never runs.
//
// Only a decision is claimed: the message text must be exactly yes/no (a closed set), it must quote the
// words message (by platform id, or by a body carrying all four words where a channel's inbound and
// outbound ids differ), the session must be the ceremony's, and the sender must be the person who
// started it. Anything else — including a bare "yes" typed without quoting — flows to the model
// untouched, so nothing said in the conversation changes meaning during the ceremony.
//
// `api.on(...)` is the typed hook path. `api.registerHook(...)` is the legacy internal-hook path and
// never fires for typed hook names (the host only warns) — do not switch back to it.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/core";
import { strings } from "./i18n/strings.js";
import type { ActiveEnrollment, EnrollmentRegistry, HumanDecision } from "./tools/enroll.js";
import { phaseOf } from "./tools/enroll.js";

/** Structural copies of the host's hook types (no allowed plugin-sdk subpath exports them). */
export type BeforeDispatchEvent = {
  messageId?: string;
  content: string;
  body?: string;
  channel?: string;
  sessionKey?: string;
  senderId?: string;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
  replyToSender?: string;
  replyToIsQuote?: boolean;
  isGroup?: boolean;
  timestamp?: number;
};
export type BeforeDispatchContext = {
  messageId?: string;
  channelId?: string;
  accountId?: string;
  conversationId?: string;
  sessionKey?: string;
  senderId?: string;
  replyToId?: string;
  replyToIdFull?: string;
  replyToBody?: string;
};
export type BeforeDispatchResult = { handled: boolean; text?: string };

/** Runs before other before_dispatch handlers: a quoted decision must never reach a lower-priority claimer. */
export const REPLY_HOOK_PRIORITY = 100;

export type Decision = "yes" | "no";

/** Exactly one decision word (trimmed, case-insensitive, trailing `.`/`!` tolerated), else undefined. */
export function parseDecision(content: string): Decision | undefined {
  const word = content.trim().toLowerCase().replace(/[.!]+$/, "").trim();
  if (strings.enroll.decisionYes.includes(word)) return "yes";
  if (strings.enroll.decisionNo.includes(word)) return "no";
  return undefined;
}

/**
 * The enrollment a quoted reply addresses: by the words message's platform id first; else a live
 * enrollment of the same session whose four words all appear in the quoted body.
 */
export function findEnrollmentForReply(registry: EnrollmentRegistry, event: BeforeDispatchEvent, ctx: BeforeDispatchContext): ActiveEnrollment | undefined {
  const quotedId = event.replyToIdFull ?? event.replyToId ?? ctx.replyToIdFull ?? ctx.replyToId;
  if (quotedId) {
    const byId = registry.findByWordsMessageId(quotedId);
    if (byId) return byId;
  }
  const body = (event.replyToBody ?? ctx.replyToBody ?? "").toLowerCase();
  const sessionKey = event.sessionKey ?? ctx.sessionKey;
  if (!body || !sessionKey) return undefined;
  const live = registry.liveWordsForSession(sessionKey);
  // Only an enrollment that actually pushed a words message into a channel can be quoted; the page lane
  // pushes nothing, so a quoted body carrying its words cannot be pointing at a message of ours.
  if (!live?.words || !live.route) return undefined;
  return live.words.every((w) => body.includes(w.toLowerCase())) ? live : undefined;
}

export type EnrollmentReplyDeps = {
  registry: EnrollmentRegistry;
  confirm: (active: ActiveEnrollment) => Promise<HumanDecision>;
  cancel: (active: ActiveEnrollment) => Promise<HumanDecision>;
};

export async function handleEnrollmentReply(event: BeforeDispatchEvent, ctx: BeforeDispatchContext, deps: EnrollmentReplyDeps): Promise<BeforeDispatchResult> {
  const decision = parseDecision(event.content ?? "");
  if (!decision) return { handled: false };
  const entry = findEnrollmentForReply(deps.registry, event, ctx);
  if (!entry) return { handled: false }; // not about us: the model sees it as always
  // They replied to OUR words message, so we answer it — but only the starter may decide.
  const sessionKey = event.sessionKey ?? ctx.sessionKey;
  const senderId = event.senderId ?? ctx.senderId;
  if (sessionKey !== entry.sessionKey || !senderId || senderId !== entry.requesterSenderId) {
    return { handled: true, text: strings.enroll.buttonNotYours };
  }
  const phase = phaseOf(entry);
  if (phase !== "words_shown") return { handled: true, text: strings.enroll.toolStatus(phase, entry.agentName) };
  const result = decision === "yes" ? await deps.confirm(entry) : await deps.cancel(entry);
  return { handled: true, text: result.message };
}

/**
 * Register the typed hook in every registration pass. Only the gateway's "full" registry ever sees
 * inbound traffic; the per-tool-execution "tool-discovery" registry is separate and short-lived, so a
 * hook there is inert — and registering it everywhere keeps `openclaw plugins inspect --runtime`
 * (which loads plugins in that lighter mode) reporting the hook, so operators can see it exists.
 */
export function registerEnrollmentReplyHook(api: OpenClawPluginApi, deps: EnrollmentReplyDeps): void {
  api.on("before_dispatch", ((event: BeforeDispatchEvent, ctx: BeforeDispatchContext) => handleEnrollmentReply(event, ctx, deps)) as never, {
    priority: REPLY_HOOK_PRIORITY,
  } as never);
}
