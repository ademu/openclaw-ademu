// The `ademu_end_call` tool (openclaw-ademu#30 §4.2 step 6): the agent hangs up the call it is in.
//
// A call's agent turns are OpenClaw meeting consults, run in the call's own session
// `agent:<id>:subagent:ademu-call:<call id>` (`calls/engine.ts`). The tool is offered there and
// nowhere else, and it can end only the call that session belongs to: a chat turn, or another call,
// never sees it. The call ends after the reply of the consult that asked has been spoken
// (`CallController.endAfterReply`), so the agent's goodbye is heard.
//
// OpenClaw's consult tool policy decides whether the agent gets the tool at all: `owner` (the default
// for the owner's 1-1 calls) keeps the agent's own tools, this one included; `safe-read-only` and `none`
// allow only OpenClaw's own read tools, so in those calls only the caller can hang up.
import type { OpenClawPluginApi, OpenClawPluginToolContext } from "openclaw/plugin-sdk/core";
import { Type } from "typebox";
import { CALL_SURFACE_ID } from "../calls/engine.js";
import { looksLikeId, normalizeId } from "../grammar.js";
import { strings } from "../i18n/strings.js";
import { liveAccounts } from "../outbound.js";

export const END_CALL_TOOL_NAME = "ademu_end_call";

type ToolResult = { content: Array<{ type: "text"; text: string }>; details: unknown };

const CONSULT_SESSION_RE = new RegExp(`^agent:[^:]+:subagent:${CALL_SURFACE_ID}:([^:]+)$`, "i");

/** The call a consult session belongs to; undefined for any other session. */
export function callIdOfSession(sessionKey: string | undefined): string | undefined {
  const id = CONSULT_SESSION_RE.exec(sessionKey?.trim() ?? "")?.[1];
  return id && looksLikeId(id) ? normalizeId(id) : undefined;
}

export type EndCallToolDeps = {
  /** Structural fields only: never ids. */
  log: (event: string, fields?: Record<string, string | number | boolean>) => void;
};

export function createEndCallTool(ctx: OpenClawPluginToolContext, deps: EndCallToolDeps) {
  const callId = callIdOfSession(ctx.sessionKey);
  if (!callId) return null;
  return {
    label: strings.calls.endTool.label,
    name: END_CALL_TOOL_NAME,
    description: strings.calls.endTool.description,
    parameters: Type.Object({}),
    execute: async (): Promise<ToolResult> => {
      // The call id is global: whichever running account holds it as its current call ends it.
      for (const account of liveAccounts()) {
        if (account.calls?.endAfterReply(callId)) {
          deps.log("call_end_tool", { ending: true });
          return { content: [{ type: "text", text: strings.calls.endTool.ending }], details: { ending: true } };
        }
      }
      deps.log("call_end_tool", { ending: false });
      return { content: [{ type: "text", text: strings.calls.endTool.noCall }], details: { ending: false } };
    },
  };
}

export function registerEndCallTool(api: OpenClawPluginApi, deps: EndCallToolDeps): void {
  api.registerTool((ctx) => createEndCallTool(ctx, deps) as never, { name: END_CALL_TOOL_NAME });
}
