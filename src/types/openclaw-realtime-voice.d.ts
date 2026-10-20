// OpenClaw ships `openclaw/plugin-sdk/realtime-voice` without type
// declarations (a "runtime seam" its own voice plugins use; present since at least 2026.9.1). These are
// the slices this plugin calls, transcribed from OpenClaw's `src/talk/*` (session-runtime.ts,
// realtime-session-harness.ts, provider-resolver.ts, exact-speech-protocol.ts).
// Kept narrow on purpose: anything not used here stays out.

declare module "openclaw/plugin-sdk/realtime-voice" {
  import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";

  export type RealtimeVoiceAudioFormat = { encoding: "pcm16" | "g711_ulaw"; sampleRateHz: number; channels: number };
  export const REALTIME_VOICE_AUDIO_FORMAT_PCM16_24KHZ: RealtimeVoiceAudioFormat;

  export type RealtimeVoiceToolCallEvent = { itemId: string; callId: string; name: string; args: unknown };
  export type RealtimeVoiceTool = { type: "function"; name: string; description: string; parameters: unknown };

  export type RealtimeVoiceBridgeSession = {
    bridge: { isConnected(): boolean };
    connect(): Promise<void>;
    sendAudio(audio: Buffer): void;
    sendUserMessage(text: string): void;
    handleBargeIn(options?: { audioPlaybackActive?: boolean; force?: boolean }): void;
    submitToolResult(callId: string, result: unknown, options?: { suppressResponse?: boolean; willContinue?: boolean }): void | Promise<void>;
    triggerGreeting(instructions?: string): void;
    acknowledgeMark(markName?: string): void;
    close(options?: unknown): void | Promise<void>;
  };

  export type RealtimeVoiceProviderPlugin = { id: string };
  export type ResolvedRealtimeVoiceProvider = {
    provider: RealtimeVoiceProviderPlugin;
    providerConfig: Record<string, unknown>;
    capabilities?: unknown;
  };

  export function resolveConfiguredRealtimeVoiceProvider(params: {
    configuredProviderId?: string;
    providerConfigs?: Record<string, Record<string, unknown> | undefined>;
    cfg?: OpenClawConfig;
    agentId?: string;
    defaultModel?: string;
    useProviderDefaultModel?: boolean;
    surface?: string;
    autoRespondToAudio?: boolean;
    noRegisteredProviderMessage?: string;
  }): ResolvedRealtimeVoiceProvider;

  export type RealtimeVoiceSessionHarness = {
    readonly transcript: Array<{ at: string; role: "user" | "assistant"; text: string }>;
    close(): void;
    createBridge(params: {
      provider: RealtimeVoiceProviderPlugin;
      capabilities?: unknown;
      cfg?: OpenClawConfig;
      agentId?: string;
      providerConfig: Record<string, unknown>;
      audioFormat?: RealtimeVoiceAudioFormat;
      audioSink: {
        isOpen?: () => boolean;
        sendAudio: (audio: Buffer) => void;
        clearAudio?: (reason?: string) => void;
      };
      instructions?: string;
      autoRespondToAudio?: boolean;
      interruptResponseOnInputAudio?: boolean;
      markStrategy?: "transport" | "ack-immediately" | "ignore";
      tools?: RealtimeVoiceTool[];
      onTranscript?: (role: "user" | "assistant", text: string, isFinal: boolean) => void;
      onToolCall?: (event: RealtimeVoiceToolCallEvent, session: RealtimeVoiceBridgeSession) => void | Promise<void>;
      onError?: (error: Error) => void;
      onClose?: (reason: unknown) => void;
    }): RealtimeVoiceBridgeSession;
    emit(input: unknown): unknown;
  };

  export function createRealtimeVoiceSessionHarness(params: {
    talk: { sessionId: string; mode: "realtime"; transport: "gateway-relay"; brain: "agent-consult"; provider?: string };
    talkPayloads: {
      turnStarted: () => unknown;
      turnEnded: (reason: string) => unknown;
      inputAudioDelta: (audio: Buffer) => unknown;
      outputAudioStarted: () => unknown;
      outputAudioDelta: (audio: Buffer) => unknown;
      outputAudioDone: (reason: string) => unknown;
    };
  }): RealtimeVoiceSessionHarness;

  export function buildRealtimeVoiceSpeakExactMessage(params: { text: string; surfaceLabel: string }): string;
}
