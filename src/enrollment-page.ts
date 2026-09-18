// The enrollment page: a browser surface served on the gateway's own HTTP server. It is the ONE
// place a TUI/webchat user sees the QR, then the daemon's four words, then presses the confirming
// Yes — with no chat commands and no model near any payload (design record §2, the three-action
// requirement).
//
//   GET  /plugins/ademu/enroll/<pageToken>          the HTML shell (zero ceremony data baked in)
//   GET  /plugins/ademu/enroll/<pageToken>/state    polled state JSON (QR data URL → words → outcome)
//   POST /plugins/ademu/enroll/<pageToken>/confirm  the host-captured yes
//   POST /plugins/ademu/enroll/<pageToken>/cancel   the host-captured no ("the words differ")
//
// The page token is a ceremony-scoped bearer capability (160 bits, in memory only): holding it
// authorizes viewing the ceremony's public data and submitting the yes. The anti-substitution
// property still rests entirely on the human comparing the words with the phone — the page adds a
// yes SURFACE, not a yes authority (`confirmFromPage` is the tool's own confirm path).
//
// Exposure: loopback clients only, unless a browser-facing base URL (`channels.ademu.enrollmentPage.
// baseUrl`) or `gateway.publicOrigin` is configured; everything else answers 404, indistinguishable
// from "no such route". Nothing here logs: the URL, the token, the payload and the words are secrets.
import { randomBytes } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveGatewayPublicOrigin } from "openclaw/plugin-sdk/config-contracts";
import { type OpenClawPluginApi, resolveGatewayPort } from "openclaw/plugin-sdk/core";
import { resolveEnrollmentPage } from "./config.js";
import { renderEnrollmentPageHtml } from "./enrollment-page-html.js";
import { strings } from "./i18n/strings.js";
import type { Qr } from "./qr.js";
import type { ActiveEnrollment, EnrollmentRegistry, HumanDecision } from "./tools/enroll.js";

export const ENROLLMENT_ROUTE_PREFIX = "/plugins/ademu";
const SEGMENT = "enroll";
/** `newPageToken()` in the tool: 20 random bytes, lowercase hex. */
export const ENROLLMENT_PAGE_TOKEN_RE = /^[a-f0-9]{40}$/;

// --- URL building --------------------------------------------------------------------------------

/**
 * The browser-facing origin: explicit channel setting → gateway publicOrigin → the gateway's own
 * bind (loopback default). The port is never hardcoded: profiles hash it.
 */
export function enrollmentPageBaseUrl(cfg: OpenClawConfig, env: NodeJS.ProcessEnv = process.env): string {
  const explicit = resolveEnrollmentPage(cfg).baseUrl;
  if (explicit) return explicit.replace(/\/+$/, "");
  const publicOrigin = resolveGatewayPublicOrigin(cfg);
  if (publicOrigin) return publicOrigin.replace(/\/+$/, "");
  const gateway = (cfg as { gateway?: { tls?: { enabled?: boolean }; bind?: string; customBindHost?: string } }).gateway;
  const scheme = gateway?.tls?.enabled ? "https" : "http";
  const host = gateway?.bind === "custom" && gateway.customBindHost?.trim() ? gateway.customBindHost.trim() : "127.0.0.1";
  return `${scheme}://${host}:${resolveGatewayPort(cfg, env)}`;
}

export function enrollmentPageUrl(cfg: OpenClawConfig, pageToken: string, env: NodeJS.ProcessEnv = process.env): string {
  return `${enrollmentPageBaseUrl(cfg, env)}${ENROLLMENT_ROUTE_PREFIX}/${SEGMENT}/${pageToken}`;
}

/** Reachable from a browser that is NOT on the gateway machine: an explicit base URL or a public origin. */
export function isEnrollmentPageRemotelyReachable(cfg: OpenClawConfig): boolean {
  return resolveEnrollmentPage(cfg).baseUrl !== undefined || resolveGatewayPublicOrigin(cfg) !== undefined;
}

// --- auto-open (the zero-action display on the gateway host) -------------------------------------

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.replace(/^\[|\]$/g, "");
  return h === "localhost" || h === "::1" || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);
}

/**
 * Open only when the page URL is loopback — such a page is reachable from this machine alone, so
 * the user must be here (TUI/webchat on the same box) and opening it IS the display. Remote/exposed
 * setups never auto-open (the browser is elsewhere). Opt out: `channels.ademu.enrollmentPage.autoOpen: false`.
 */
export function shouldAutoOpenEnrollmentPage(cfg: OpenClawConfig, url: string): boolean {
  if (resolveEnrollmentPage(cfg).autoOpen === false) return false;
  try {
    return isLoopbackHostname(new URL(url).hostname);
  } catch {
    return false;
  }
}

/** Production launcher: the platform's opener, detached, output ignored. Resolves whether it spawned. */
export async function openInBrowser(url: string): Promise<boolean> {
  const { spawn } = await import("node:child_process");
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  return await new Promise<boolean>((resolve) => {
    try {
      const child = spawn(cmd, args, { stdio: "ignore", detached: true });
      child.once("error", () => resolve(false));
      child.once("spawn", () => {
        child.unref();
        resolve(true);
      });
    } catch {
      resolve(false);
    }
  });
}

// --- the route -----------------------------------------------------------------------------------

/** Fixed-window request counter per key; bounded key set (oldest window evicted first). */
export class FixedWindowLimiter {
  readonly #hits = new Map<string, { windowStart: number; count: number }>();
  constructor(
    private readonly windowMs: number,
    private readonly maxRequests: number,
    private readonly maxKeys = 256,
    private readonly now: () => number = Date.now,
  ) {}
  isRateLimited(key: string): boolean {
    const t = this.now();
    let slot = this.#hits.get(key);
    if (!slot || t - slot.windowStart >= this.windowMs) {
      slot = { windowStart: t, count: 0 };
      this.#hits.delete(key);
      if (this.#hits.size >= this.maxKeys) this.#hits.delete(this.#hits.keys().next().value as string);
      this.#hits.set(key, slot);
    }
    slot.count += 1;
    return slot.count > this.maxRequests;
  }
}

export type PageConfirmResult = HumanDecision;

export type EnrollmentPageDeps = {
  registry: EnrollmentRegistry;
  qr: Qr;
  /** The tool's yes / no paths (`confirmByHuman` / `cancelByHuman`), injected so this module stays decoupled. */
  confirm: (active: ActiveEnrollment) => Promise<HumanDecision>;
  cancel: (active: ActiveEnrollment) => Promise<HumanDecision>;
  /** The live host config (exposure gate, base URL). */
  cfg: () => OpenClawConfig;
  /** Test seams. Proxy headers are deliberately never consulted. */
  clientAddr?: (req: IncomingMessage) => string | undefined;
  limiters?: { poll: FixedWindowLimiter; confirm: FixedWindowLimiter; unknownToken: FixedWindowLimiter };
};

type Endpoint = "page" | "state" | "confirm" | "cancel";

function isLoopbackAddress(addr: string | undefined): boolean {
  if (!addr) return false;
  return isLoopbackHostname(addr.startsWith("::ffff:") ? addr.slice("::ffff:".length) : addr);
}

const BASE_HEADERS = {
  "Cache-Control": "no-store",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow",
  "X-Content-Type-Options": "nosniff",
} as const;

function send(res: ServerResponse, status: number, type: string, body: string | undefined, extra: Record<string, string> = {}): void {
  res.writeHead(status, { "Content-Type": type, ...BASE_HEADERS, ...extra });
  res.end(body);
}
function sendJson(res: ServerResponse, status: number, value: unknown): void {
  send(res, status, "application/json; charset=utf-8", JSON.stringify(value));
}

/** Match from the END of the path so gateway base paths and proxy prefixes are harmless. */
function parsePath(pathname: string): { token: string; endpoint: Endpoint } | undefined {
  const s = pathname.split("/").filter(Boolean);
  const [last, secondLast, thirdLast] = [s[s.length - 1], s[s.length - 2], s[s.length - 3]];
  if (secondLast === SEGMENT && last !== undefined) return { token: last, endpoint: "page" };
  if (thirdLast === SEGMENT && secondLast !== undefined && (last === "state" || last === "confirm" || last === "cancel")) return { token: secondLast, endpoint: last };
  return undefined;
}

/** Bounded cache: a page polls the same payload every two seconds. */
const qrCache = new Map<string, string>();
async function qrDataUrlFor(qr: Qr, payload: string): Promise<string> {
  const hit = qrCache.get(payload);
  if (hit) return hit;
  const rendered = await qr.pngDataUrl(payload);
  if (qrCache.size >= 8) qrCache.clear();
  qrCache.set(payload, rendered);
  return rendered;
}

/** The wire phases the shell renders; derived from the tool's own enrollment state. */
export type PageState =
  | { phase: "awaiting-scan"; qrDataUrl: string; qrPayload: string }
  | { phase: "awaiting-yes"; words: readonly string[] }
  | { phase: "confirming" }
  | { phase: "enrolled" }
  | { phase: "cancelled" }
  | { phase: "failed"; message: string }
  | { phase: "expired"; message: string };

export async function pageStateFor(active: ActiveEnrollment, qr: Qr): Promise<PageState> {
  switch (active.state) {
    case "done":
      return { phase: "enrolled" };
    case "failed":
      if (active.failure === "words_mismatch") return { phase: "failed", message: strings.enroll.wordsMismatch };
      return { phase: "failed", message: strings.enroll.pageFailedReason(active.terminalState ?? active.failure ?? "ended") };
    case "cancelled":
      return { phase: "cancelled" };
    default:
      break;
  }
  // Not terminal: a disposed lease means cancelled/superseded/expired underneath the page.
  if (active.lease.disposed) return { phase: "expired", message: strings.enroll.pageCancelled };
  if (active.state === "scanning") return { phase: "awaiting-scan", qrDataUrl: await qrDataUrlFor(qr, active.qrPayload), qrPayload: active.qrPayload };
  if (active.state === "words") return { phase: "awaiting-yes", words: active.words ?? [] };
  return { phase: "confirming" };
}

export function registerEnrollmentPage(api: OpenClawPluginApi, deps: EnrollmentPageDeps): void {
  const clientAddr = deps.clientAddr ?? ((req: IncomingMessage) => req.socket?.remoteAddress ?? undefined);
  const limiters = deps.limiters ?? {
    poll: new FixedWindowLimiter(60_000, 120),
    confirm: new FixedWindowLimiter(60_000, 10),
    unknownToken: new FixedWindowLimiter(60_000, 40),
  };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    const parsed = parsePath(new URL(req.url ?? "/", "http://internal.invalid").pathname);
    if (!parsed) {
      send(res, 404, "text/plain; charset=utf-8", "Not found");
      return true;
    }
    const { token, endpoint } = parsed;

    const method = (req.method ?? "GET").toUpperCase();
    const isPost = endpoint === "confirm" || endpoint === "cancel";
    if (isPost ? method !== "POST" : method !== "GET" && method !== "HEAD") {
      send(res, 405, "text/plain; charset=utf-8", "Method not allowed", { Allow: isPost ? "POST" : "GET, HEAD" });
      return true;
    }

    // Exposure gate: loopback only unless remote exposure was deliberately configured.
    const cfg = deps.cfg();
    const addr = clientAddr(req);
    const remoteAllowed = resolveEnrollmentPage(cfg).baseUrl !== undefined || resolveGatewayPublicOrigin(cfg) !== undefined;
    if (!isLoopbackAddress(addr) && !remoteAllowed) {
      send(res, 404, "text/plain; charset=utf-8", "Not found");
      return true;
    }
    const key = addr ?? "unknown";
    if ((isPost ? limiters.confirm : limiters.poll).isRateLimited(key)) {
      sendJson(res, 429, { error: "rate-limited" });
      return true;
    }

    const active = ENROLLMENT_PAGE_TOKEN_RE.test(token) ? deps.registry.findByPageToken(token) : undefined;
    if (!active) {
      if (limiters.unknownToken.isRateLimited(key)) {
        sendJson(res, 429, { error: "rate-limited" });
        return true;
      }
      if (endpoint === "page") send(res, 404, "text/html; charset=utf-8", renderEnrollmentPageHtml({ cspNonce: "", expired: true }));
      else sendJson(res, 404, { error: "not-live" });
      return true;
    }

    if (endpoint === "page") {
      const cspNonce = randomBytes(16).toString("base64");
      send(res, 200, "text/html; charset=utf-8", method === "HEAD" ? undefined : renderEnrollmentPageHtml({ cspNonce }), {
        "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${cspNonce}'; style-src 'nonce-${cspNonce}'; img-src data:; connect-src 'self'`,
      });
      return true;
    }
    if (endpoint === "state") {
      sendJson(res, 200, await pageStateFor(active, deps.qr));
      return true;
    }

    // confirm / cancel — JSON only; the body carries nothing (the token in the path is the whole request).
    const contentType = String(req.headers["content-type"] ?? "").toLowerCase();
    if (!contentType.startsWith("application/json")) {
      sendJson(res, 415, { ok: false, code: "unsupported-media-type" });
      return true;
    }
    if (!(await drainBody(req, 4096))) {
      sendJson(res, 413, { ok: false, code: "payload-too-large" });
      return true;
    }
    if (endpoint === "cancel") {
      if (active.state === "cancelled") {
        sendJson(res, 200, { ok: true, alreadyCancelled: true, phase: "cancelled" });
        return true;
      }
      if (active.state === "done" || active.state === "failed" || active.lease.disposed) {
        sendJson(res, 200, { ok: false, code: "not-live", message: strings.enroll.pageCancelled });
        return true;
      }
      const result = await deps.cancel(active);
      sendJson(res, result.ok ? 200 : 409, { ok: result.ok, state: result.state, message: result.ok ? undefined : result.message });
      return true;
    }
    if (active.state === "done") {
      sendJson(res, 200, { ok: true, alreadyConfirmed: true, phase: "enrolled" });
      return true;
    }
    if (active.lease.disposed || active.state === "failed" || active.state === "cancelled") {
      sendJson(res, 200, { ok: false, code: "not-live", message: strings.enroll.pageCancelled });
      return true;
    }
    if (active.state === "scanning" || !active.words) {
      sendJson(res, 409, { ok: false, code: "not-ready", message: strings.enroll.pageNotReady });
      return true;
    }
    if (active.state !== "words") {
      // confirmed/enrolled/committing: a yes is already in flight (from this page or a channel button).
      sendJson(res, 200, { ok: true, alreadyConfirmed: true, phase: "confirming" });
      return true;
    }
    const result = await deps.confirm(active);
    sendJson(res, 200, { ok: result.ok, state: result.state, message: result.ok ? undefined : result.message });
    return true;
  }

  api.registerHttpRoute({
    path: ENROLLMENT_ROUTE_PREFIX,
    match: "prefix",
    auth: "plugin",
    replaceExisting: true,
    handler: (req, res) => handle(req, res),
  });
}

/** Reads and discards the body; false when it exceeds `maxBytes`. */
function drainBody(req: IncomingMessage, maxBytes: number): Promise<boolean> {
  return new Promise((resolve) => {
    let seen = 0;
    let ok = true;
    req.on("data", (chunk: Buffer) => {
      seen += chunk.length;
      if (seen > maxBytes) ok = false;
    });
    req.on("end", () => resolve(ok));
    req.on("error", () => resolve(false));
    req.resume();
  });
}
