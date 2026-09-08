// Message actions (plan T9 / V8): the shared `message` tool's `react` action → `send_reaction` on
// the account's live session. `send` stays with the outbound adapter (core routes it there). An
// empty emoji is Ademú's wire form for removal (`SendReactionParams.emoji: ""`).
import type { ChannelMessageActionAdapter, ChannelMessageActionName } from "openclaw/plugin-sdk/channel-contract";
import { jsonResult, readReactionParams, readStringParam, resolveReactionMessageId } from "openclaw/plugin-sdk/channel-actions";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { CHANNEL_ID, inspectAdemuAccount, listAdemuAccountIds } from "./config.js";
import { getLiveAccount, resolveConversationTarget, resolveOutboundAccountId } from "./outbound.js";

const ACTIONS: readonly ChannelMessageActionName[] = ["send", "react"];

function hasConfiguredAccount(cfg: OpenClawConfig, accountId?: string | null): boolean {
  const ids = accountId ? [accountId] : listAdemuAccountIds(cfg);
  return ids.some((id) => {
    const account = inspectAdemuAccount(cfg, id);
    return account.enabled && account.configured;
  });
}

export const ademuMessageActions: ChannelMessageActionAdapter = {
  describeMessageTool: ({ cfg, accountId }) => {
    if (!hasConfiguredAccount(cfg, accountId)) return null;
    return { actions: ACTIONS };
  },

  supportsAction: ({ action }) => action === "react",

  handleAction: async ({ action, params, accountId, toolContext }) => {
    if (action !== "react") throw new Error(`Action ${action} is not supported for ${CHANNEL_ID}.`);
    const groupId = resolveConversationTarget(readStringParam(params, "to", { required: true, label: "to (conversation id)" }));
    const messageIdRaw = resolveReactionMessageId({ args: params, ...(toolContext ? { toolContext } : {}) });
    if (messageIdRaw == null) throw new Error("messageId required");
    const reaction = readReactionParams(params, { removeErrorMessage: "Removing a reaction requires the emoji to remove." });
    if (!reaction.remove && reaction.isEmpty) throw new Error("emoji required");
    const { client } = getLiveAccount(resolveOutboundAccountId(accountId));
    const result = await client.sendReaction({
      group_id: groupId,
      target_message_id: String(messageIdRaw),
      emoji: reaction.remove ? "" : reaction.emoji,
    });
    return jsonResult(reaction.remove ? { ok: true, removed: reaction.emoji, status: result.status } : { ok: true, added: reaction.emoji, status: result.status });
  },
};
