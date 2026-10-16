// The voice loop of a call: one of OpenClaw's meeting engines (`openclaw/plugin-sdk/meeting-runtime`)
// over the call's audio transport, built the way OpenClaw's own meeting surfaces build it
// (`createMeetingRealtimeEngineBindings` + `MeetingRealtimeEngineConfig`).
//
//   - "agent"    `startMeetingAgentRealtimeEngine`: speech-to-text → the agent (consultAgent, i.e. the
//                same agent, memory and tools as its text turns, forked from the conversation's
//                session) → text-to-speech (`runtime.tts`, the host's `tts` config). Half-duplex: it
//                mutes input while a clip plays (+3 s) and never clears output, so barge-in is the
//                controller's (it clears and restarts the engine, which unmutes).
//   - "realtime" `startMeetingRealtimeEngine` with the "bidi" strategy: a speech-to-speech provider
//                that consults the agent through the `openclaw_agent_consult` tool; it handles
//                barge-in itself through the transport's monitor hook.
//
// Providers (speech-to-text, voice) come from OpenClaw's provider registries for the host config;
// `calls.providers` carries their per-provider settings exactly as a meeting plugin's `realtime.providers`.
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import {
  createMeetingRealtimeEngineBindings,
  startMeetingAgentRealtimeEngine,
  startMeetingRealtimeEngine,
  type MeetingRealtimeAudioTransport,
  type MeetingRealtimeEngineConfig,
} from "openclaw/plugin-sdk/meeting-runtime";
import type { ResolvedCallsConfig } from "../config.js";
import { strings } from "../i18n/strings.js";

/** The surface id: the consult's message provider and lane, and the meeting session id prefix. */
export const CALL_SURFACE_ID = "ademu-call";

export type CallEngineHandle = {
  /** Speaks `text` (agent engine: verbatim through TTS; realtime engine: as instructions to the voice model). */
  speak: (text: string) => void;
  stop: () => Promise<void>;
};

export type CallEngineParams = {
  transport: MeetingRealtimeAudioTransport;
  callId: string;
  /** The routed agent of the conversation the call is in. */
  agentId: string;
  /** The conversation's session: the consult forks it, so the call starts with the chat's context. */
  sessionKey: string;
  /** The agent's tools in this call's consults (the owner's calls and others' differ, `config.ts`). */
  toolPolicy: ResolvedCallsConfig["toolPolicy"];
  /** Each agent consult settled (its answer is about to be spoken): the hang-up waits for this. */
  onConsultSettled?: (() => void) | undefined;
};

export type CallEngineStarter = (params: CallEngineParams) => Promise<CallEngineHandle>;

type RuntimeLogger = Parameters<typeof startMeetingAgentRealtimeEngine>[0]["logger"];

export function engineConfig(calls: ResolvedCallsConfig, agentId: string): MeetingRealtimeEngineConfig {
  const instructions = calls.instructions ?? (calls.engine === "realtime" ? strings.calls.realtimeInstructions : undefined);
  return {
    chrome: { audioFormat: "pcm16-24khz" },
    realtime: {
      strategy: calls.engine === "realtime" ? "bidi" : "agent",
      agentId,
      ...(calls.provider !== undefined ? { provider: calls.provider } : {}),
      ...(calls.transcriptionProvider !== undefined ? { transcriptionProvider: calls.transcriptionProvider } : {}),
      ...(calls.voiceProvider !== undefined ? { voiceProvider: calls.voiceProvider } : {}),
      ...(calls.model !== undefined ? { model: calls.model } : {}),
      ...(instructions !== undefined ? { instructions } : {}),
      providers: calls.providers,
    },
  };
}

export function createCallEngineStarter(params: {
  calls: ResolvedCallsConfig;
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
}): CallEngineStarter {
  const { calls, cfg, runtime, logger } = params;
  return async ({ transport, callId, agentId, sessionKey, toolPolicy, onConsultSettled }) => {
    const bindings = createMeetingRealtimeEngineBindings({
      platform: {
        id: CALL_SURFACE_ID,
        displayName: strings.channelLabel,
        logScope: CALL_SURFACE_ID,
        agentConsult: strings.calls.consult,
        session: { idPrefix: CALL_SURFACE_ID, participantIdentity: () => CALL_SURFACE_ID },
      },
      config: { realtime: { agentId, toolPolicy } },
      fullConfig: cfg,
      runtime,
      logger,
    });
    const common = {
      config: engineConfig(calls, agentId),
      fullConfig: cfg,
      runtime,
      platform: bindings.platform,
      // The consult session is `agent:<id>:subagent:ademu-call:<call id>`: one per call, kept across
      // engine restarts (barge-in) and seat reattaches.
      meetingSessionId: callId,
      requesterSessionKey: sessionKey,
      transport,
      logger,
      consultAgent: async (consult: Parameters<typeof bindings.consultAgent>[0]) => {
        try {
          return await bindings.consultAgent(consult);
        } finally {
          onConsultSettled?.();
        }
      },
    };
    const handle =
      calls.engine === "realtime"
        ? await startMeetingRealtimeEngine({
            ...common,
            tools: bindings.tools,
            // The realtime engine consults through its tool, not through consultAgent.
            handleToolCall: async (call) => {
              try {
                await bindings.handleToolCall(call);
              } finally {
                onConsultSettled?.();
              }
            },
          })
        : await startMeetingAgentRealtimeEngine(common);
    return { speak: (text) => handle.speak(text), stop: () => handle.stop() };
  };
}
