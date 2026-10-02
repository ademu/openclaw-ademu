// A scripted fake control client for the ceremony tests: the test drives pairing snapshots
// (`emit`) and the terminal state (`finish`); every request is recorded.
import type { FourWords, PairingSnapshot } from "@ademu/adc-control";
import type { ControlLike } from "../../src/ceremony.js";

export const NEW_DEVICE = "aaaaaaaa-1111-4222-8333-444444444444";
export const NEW_AGENT = "bbbbbbbb-1111-4222-8333-444444444444";
export const QR = "ademu://agent-pair?v=1&id=x&key=y&name=Iris";
export const WORDS: FourWords = ["alpha", "bravo", "charlie", "delta"];

export class FakeControl implements ControlLike {
  calls: Array<{ op: string; params?: unknown }> = [];
  tokenCount = 0;
  tokenMintImpl?: (params: { device_id: string; label: string; replace?: true }) => Promise<{ token_id: string; label: string; token: string; created_at_ms: number }>;
  createDeviceImpl?: (params: { agent_name: string }) => Promise<{ device_id: string; agent_user_id: string; state: string; qr_payload: string }>;
  confirmWordsImpl?: (params: { device_id: string; words: FourWords }) => Promise<{ confirmed: boolean; state: string }>;
  info = {
    version: "0.5.0 (abc)",
    key_provider: "k",
    kek_rung: 1,
    data_dir: "/d",
    socket_path: "/d/adc.sock",
    config_source: "env",
    started_at_ms: 1,
    session_socket_path: "/d/adc-session.sock",
    enroll_socket_path: "/d/adc-enroll.sock",
  };
  closed = 0;
  #onUpdate?: (s: PairingSnapshot) => void;
  #finish?: (s: PairingSnapshot) => void;
  #fail?: (e: unknown) => void;
  polling = false;

  async createDevice(params: { agent_name: string }) {
    this.calls.push({ op: "create_device", params });
    if (this.createDeviceImpl) return this.createDeviceImpl(params);
    return { device_id: NEW_DEVICE, agent_user_id: NEW_AGENT, state: "created", qr_payload: QR };
  }
  async confirmWords(params: { device_id: string; words: FourWords }) {
    this.calls.push({ op: "confirm_words", params });
    if (this.confirmWordsImpl) return this.confirmWordsImpl(params);
    return { confirmed: true, state: "paired" };
  }
  async getPairingDisplay() {
    throw new Error("not used");
  }
  async cancelPairing(params: { device_id: string }) {
    this.calls.push({ op: "cancel_pairing", params });
    return { cancelled: true, state: "retired" };
  }
  async tokenMint(params: { device_id: string; label: string; replace?: true }) {
    this.calls.push({ op: "token_mint", params });
    if (this.tokenMintImpl) return this.tokenMintImpl(params);
    this.tokenCount++;
    return { token_id: `tid-${this.tokenCount}`, label: params.label, token: `adc1_secret_${this.tokenCount}`, created_at_ms: 1 };
  }
  async daemonInfo() {
    this.calls.push({ op: "daemon_info" });
    return this.info;
  }
  pollPairing(deviceId: string, onUpdate: (s: PairingSnapshot) => void, options?: { signal?: AbortSignal }): Promise<PairingSnapshot> {
    this.calls.push({ op: "poll", params: { deviceId } });
    this.polling = true;
    this.#onUpdate = onUpdate;
    return new Promise<PairingSnapshot>((resolve, reject) => {
      this.#finish = (s) => {
        this.polling = false;
        onUpdate(s);
        resolve(s);
      };
      this.#fail = (e) => {
        this.polling = false;
        reject(e);
      };
      options?.signal?.addEventListener("abort", () => this.#fail?.(new Error("poll aborted")), { once: true });
    });
  }
  async close() {
    this.closed++;
  }

  /** Test drivers */
  emit(s: Partial<PairingSnapshot> = {}) {
    this.#onUpdate?.({ state: "created", qrPayload: QR, ...s });
  }
  finish(state: string) {
    this.#finish?.({ state, qrPayload: QR, words: WORDS });
  }
  failPoll(err: unknown) {
    this.#fail?.(err);
  }
}
