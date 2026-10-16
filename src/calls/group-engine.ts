// The voice loop of a group call in "named" mode (#874, AdemuMLS `adc/plans/2026-10-16-agent-group-calls.md`,
// economical mode chosen after the S2S spike): an OpenAI realtime speech-to-speech session built the
// way OpenClaw's own Discord voice builds one (`openclaw/plugin-sdk/realtime-voice`), with automatic
// replies OFF. The model hears the whole call; it speaks only when `ask` gives it a turn (a person
// named the agent: `GroupCallBrain`). Consults reach the agent through the meeting runtime's own
// bindings, exactly as the 1-1 realtime engine's do. OpenClaw's meeting engine cannot do this: its
// "bidi" strategy always replies to audio.
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import type { PluginRuntime } from "openclaw/plugin-sdk/core";
import { createMeetingRealtimeEngineBindings, type MeetingRealtimeAudioTransport } from "openclaw/plugin-sdk/meeting-runtime";
import {
  buildRealtimeVoiceSpeakExactMessage,
  createRealtimeVoiceSessionHarness,
  REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
  resolveConfiguredRealtimeVoiceProvider,
} from "openclaw/plugin-sdk/realtime-voice";
import type { ResolvedCallsConfig } from "../config.js";
import { strings } from "../i18n/strings.js";
import { CALL_SURFACE_ID, type CallEngineHandle, type CallEngineParams } from "./engine.js";

/** The VAD's lead-in on the realtime session (the spike: 600 ms keeps a name's first syllable). */
export const GROUP_PREFIX_PADDING_MS = 600;

export type GroupEngineHandle = CallEngineHandle & {
  /** A person addressed the agent: `text` is the labelled call since it last spoke; it replies now. */
  ask: (text: string) => void;
};

export type GroupEngineParams = CallEngineParams & {
  agentName: string;
  /** The agent's own reply, as the model's output transcript (the call log keeps it). */
  onAgentSaid: (text: string) => void;
};

export type GroupEngineStarter = (params: GroupEngineParams) => Promise<GroupEngineHandle>;

type RuntimeLogger = Parameters<typeof createMeetingRealtimeEngineBindings>[0]["logger"];

const noPayload = () => ({});

export function createGroupEngineStarter(params: {
  calls: ResolvedCallsConfig;
  cfg: OpenClawConfig;
  runtime: PluginRuntime;
  logger: RuntimeLogger;
}): GroupEngineStarter {
  const { calls, cfg, runtime, logger } = params;
  return async ({ transport, callId, agentId, sessionKey, toolPolicy, onConsultSettled, agentName, onAgentSaid }) => {
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
    const harness = createRealtimeVoiceSessionHarness({
      talk: { sessionId: `${CALL_SURFACE_ID}:${callId}`, mode: "realtime", transport: "gateway-relay", brain: "agent-consult", provider: "openai" },
      talkPayloads: {
        turnStarted: noPayload,
        turnEnded: noPayload,
        inputAudioDelta: noPayload,
        outputAudioStarted: noPayload,
        outputAudioDelta: noPayload,
        outputAudioDone: noPayload,
      },
    });
    const openai = calls.providers.openai ?? {};
    const resolved = resolveConfiguredRealtimeVoiceProvider({
      configuredProviderId: "openai",
      providerConfigs: {
        openai: {
          ...openai,
          model: calls.group.model,
          prefixPaddingMs: typeof openai.prefixPaddingMs === "number" ? openai.prefixPaddingMs : GROUP_PREFIX_PADDING_MS,
        },
      },
      cfg,
      agentId,
      defaultModel: calls.group.model,
      surface: "gateway-relay",
      autoRespondToAudio: false,
    });
    let stopped = false;
    const view: MeetingRealtimeAudioTransport = transport;
    const bridge = harness.createBridge({
      provider: resolved.provider,
      capabilities: resolved.capabilities,
      cfg,
      agentId,
      providerConfig: resolved.providerConfig,
      audioFormat: REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ,
      instructions: calls.group.instructions ?? strings.calls.groupInstructions(agentName),
      autoRespondToAudio: false,
      interruptResponseOnInputAudio: false,
      markStrategy: "ack-immediately",
      tools: bindings.tools as never,
      audioSink: {
        isOpen: () => !stopped,
        sendAudio: (audio) => {
          view.writeOutput(audio).catch(() => {});
        },
        clearAudio: () => {
          view.clearOutput().catch(() => {});
        },
      },
      onTranscript: (role, text, isFinal) => {
        if (role === "assistant" && isFinal) onAgentSaid(text);
      },
      onToolCall: async (event, session) => {
        try {
          await bindings.handleToolCall({
            strategy: "bidi",
            session: session as never,
            event,
            meetingSessionId: callId,
            requesterSessionKey: sessionKey,
            transcript: harness.transcript.map(({ role, text }) => ({ role, text })),
            onTalkEvent: (e) => {
              harness.emit(e);
            },
          });
        } finally {
          onConsultSettled?.();
        }
      },
      onError: (err) => logger.warn?.(`ademu group call: realtime error ${err.name}`),
      onClose: () => {
        // The provider closed by itself: the engine is gone, and the call with it (the controller's
        // view callback ends the call when the transport stops without our asking).
        if (!stopped) void view.stop();
      },
    });
    view.startInput((audio) => bridge.sendAudio(audio));
    view.startBargeInMonitor?.(() => {
      // The transport's barge-in gate already decided this is the person the agent is answering.
      bridge.handleBargeIn({ audioPlaybackActive: true, force: true });
      view.clearOutput().catch(() => {});
      return true;
    });
    await bridge.connect();
    const stop = async () => {
      if (stopped) return;
      stopped = true;
      await Promise.resolve(bridge.close()).catch(() => {});
      harness.close();
      await view.stop();
    };
    view.onFatal(() => void stop());
    return {
      ask: (text) => {
        if (!stopped) bridge.sendUserMessage(text);
      },
      speak: (text) => {
        if (!stopped) bridge.sendUserMessage(buildRealtimeVoiceSpeakExactMessage({ text, surfaceLabel: strings.calls.groupSurface }));
      },
      stop,
    };
  };
}
