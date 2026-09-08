// QR rendering (plan T14 / V2): prefer host-injected renderers when the runtime carries them (checked
// at runtime, typed via `unknown`), else the public `media-runtime` helpers — the ONE recorded
// import-gate exception (no focused QR subpath exists). The payload is runtime data (`ademu://…`);
// it is rendered, never logged.
import { renderQrPngDataUrl, renderQrTerminal } from "openclaw/plugin-sdk/media-runtime";

type TerminalRenderer = (input: string, opts?: { small?: boolean }) => Promise<string>;
type PngRenderer = (input: string) => Promise<string>;
type QrRenderers = { renderQrTerminal?: TerminalRenderer; renderQrPngDataUrl?: PngRenderer };

function fromRuntime(runtime: unknown): QrRenderers {
  const media = (runtime as { media?: unknown } | undefined)?.media as Record<string, unknown> | undefined;
  const out: QrRenderers = {};
  if (typeof media?.renderQrTerminal === "function") out.renderQrTerminal = media.renderQrTerminal as TerminalRenderer;
  if (typeof media?.renderQrPngDataUrl === "function") out.renderQrPngDataUrl = media.renderQrPngDataUrl as PngRenderer;
  return out;
}

export function createQr(runtime?: unknown) {
  const host = fromRuntime(runtime);
  return {
    /** Monospace block for `prompter.plain` (never `note`, which reflows at 80 columns — K11). */
    terminal: (payload: string) => (host.renderQrTerminal ?? renderQrTerminal)(payload, { small: true }),
    /** `data:image/png;base64,…` for markdown image embeds (the chat tool). */
    pngDataUrl: (payload: string) => (host.renderQrPngDataUrl ?? renderQrPngDataUrl)(payload),
  };
}

export type Qr = ReturnType<typeof createQr>;
