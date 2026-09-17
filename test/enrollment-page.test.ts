// The browser enrollment page: the route is captured from a fake plugin api and served on a real
// loopback http.Server, then driven with fetch against enrollments the REAL tool created (shared
// test world) — so `/state` reads the tool's own entries and `/confirm` runs the tool's confirm path.
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { afterEach, describe, expect, it } from "vitest";
import {
  ENROLLMENT_ROUTE_PREFIX,
  enrollmentPageBaseUrl,
  enrollmentPageUrl,
  type EnrollmentPageDeps,
  FixedWindowLimiter,
  registerEnrollmentPage,
  shouldAutoOpenEnrollmentPage,
} from "../src/enrollment-page.js";
import { confirmFromPage } from "../src/tools/enroll.js";
import { NEW_DEVICE, QR, WORDS } from "./fakes/control.js";
import { tick, world } from "./fakes/enroll-world.js";

type Route = { path: string; match?: string; auth: string; replaceExisting?: boolean; handler: (req: http.IncomingMessage, res: http.ServerResponse) => unknown };
type World = ReturnType<typeof world>;

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function serve(w: World, cfg: OpenClawConfig = {} as OpenClawConfig, over: Partial<EnrollmentPageDeps> = {}) {
  let route: Route | undefined;
  const api = { registerHttpRoute: (r: Route) => void (route = r) };
  registerEnrollmentPage(api as never, {
    registry: w.registry,
    qr: w.deps.qr,
    confirm: (active) => confirmFromPage(active, w.deps, w.registry),
    cfg: () => cfg,
    ...over,
  });
  const server = http.createServer((req, res) => void route!.handler(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}${ENROLLMENT_ROUTE_PREFIX}/enroll`;
  return { route: route!, base, page: (token: string, sub = "") => `${base}/${token}${sub}` };
}

/** Starts an enrollment through the real tool and returns its page token (from the result's URL). */
async function started(w: World) {
  const start = await w.call({ action: "start", agentName: "Iris" });
  const pageUrl = start.details.pageUrl as string;
  return { start, pageUrl, token: pageUrl.slice(pageUrl.lastIndexOf("/") + 1), leaseToken: start.details.leaseToken as string };
}

const confirmPost = (url: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
  fetch(url, { method: "POST", headers, body: "{}" });

const UNKNOWN = "0".repeat(40);

describe("enrollment page: the tool's start result", () => {
  it("carries a loopback page URL with a 40-hex token and auto-opens it exactly once", async () => {
    const w = world();
    const { start, pageUrl } = await started(w);
    expect(pageUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/plugins\/ademu\/enroll\/[a-f0-9]{40}$/);
    expect(start.details).toMatchObject({ pageOpened: true });
    expect(w.opens).toEqual([pageUrl]);
    expect(start.content[0]!.text).toContain(pageUrl);
    expect(start.content[0]!.text).toContain("OPENED");
    // the markdown QR for clients that render images is still there
    expect(start.content[0]!.text).toContain("![ademu-enroll](data:image/png;base64,QUJD)");
  });

  it("autoOpen: false → not opened, the text tells the model the user can open the page", async () => {
    const w = world({ channels: { ademu: { enrollmentPage: { autoOpen: false } } } } as unknown as OpenClawConfig);
    const { start } = await started(w);
    expect(w.opens).toEqual([]);
    expect(start.details).toMatchObject({ pageOpened: false });
    expect(start.content[0]!.text).toContain("can open the enrollment page");
  });

  it("a remote base URL is used for the page URL and is never auto-opened", async () => {
    const w = world({ channels: { ademu: { enrollmentPage: { baseUrl: "https://gw.example.com/" } } } } as unknown as OpenClawConfig);
    const { pageUrl } = await started(w);
    expect(pageUrl).toMatch(/^https:\/\/gw\.example\.com\/plugins\/ademu\/enroll\/[a-f0-9]{40}$/);
    expect(w.opens).toEqual([]);
  });

  it("a failing browser launcher is not fatal", async () => {
    const w = world();
    w.deps.openUrl = async () => {
      throw new Error("no opener");
    };
    const { start } = await started(w);
    expect(start.details).toMatchObject({ ok: true, pageOpened: false });
  });
});

describe("enrollment page: URL derivation", () => {
  it("explicit base URL → gateway publicOrigin → the gateway's own bind (port never hardcoded)", () => {
    const explicit = { channels: { ademu: { enrollmentPage: { baseUrl: "https://a.example/" } } }, gateway: { publicOrigin: "https://b.example" } } as unknown as OpenClawConfig;
    expect(enrollmentPageBaseUrl(explicit)).toBe("https://a.example");
    expect(enrollmentPageBaseUrl({ gateway: { publicOrigin: "https://b.example/" } } as unknown as OpenClawConfig)).toBe("https://b.example");
    expect(enrollmentPageBaseUrl({ gateway: { port: 4321 } } as unknown as OpenClawConfig, {})).toBe("http://127.0.0.1:4321");
    expect(enrollmentPageBaseUrl({ gateway: { port: 4321, tls: { enabled: true }, bind: "custom", customBindHost: "10.0.0.5" } } as unknown as OpenClawConfig, {})).toBe(
      "https://10.0.0.5:4321",
    );
    expect(enrollmentPageUrl({ gateway: { port: 1 } } as unknown as OpenClawConfig, "t", {})).toBe("http://127.0.0.1:1/plugins/ademu/enroll/t");
  });

  it("auto-open only for loopback URLs, and never when disabled", () => {
    const cfg = {} as OpenClawConfig;
    expect(shouldAutoOpenEnrollmentPage(cfg, "http://127.0.0.1:1/x")).toBe(true);
    expect(shouldAutoOpenEnrollmentPage(cfg, "http://localhost:1/x")).toBe(true);
    expect(shouldAutoOpenEnrollmentPage(cfg, "http://[::1]:1/x")).toBe(true);
    expect(shouldAutoOpenEnrollmentPage(cfg, "https://gw.example.com/x")).toBe(false);
    expect(shouldAutoOpenEnrollmentPage(cfg, "not a url")).toBe(false);
    expect(shouldAutoOpenEnrollmentPage({ channels: { ademu: { enrollmentPage: { autoOpen: false } } } } as unknown as OpenClawConfig, "http://127.0.0.1:1/x")).toBe(false);
  });
});

describe("enrollment page: the route", () => {
  it("registers a prefix route with plugin auth that replaces itself", async () => {
    const w = world();
    const { route } = await serve(w);
    expect(route).toMatchObject({ path: "/plugins/ademu", match: "prefix", auth: "plugin", replaceExisting: true });
  });

  it("the shell carries a nonce CSP, hardening headers, house vocabulary, and ZERO ceremony data", async () => {
    const w = world();
    const { token } = await started(w);
    const { page } = await serve(w);
    const res = await fetch(page(token));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/html");
    const csp = res.headers.get("content-security-policy")!;
    const nonce = /script-src 'nonce-([^']+)'/.exec(csp)![1]!;
    expect(csp).toContain("default-src 'none'");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("x-content-type-options")).toBe("nosniff");
    const html = await res.text();
    expect(html).toContain(`<script nonce="${nonce}">`);
    expect(html).toContain(`<style nonce="${nonce}">`);
    expect(html).toContain("Enroll on Ademú");
    expect(html).not.toMatch(/\bpair/i);
    expect(html).not.toContain(QR);
    expect(html).not.toContain(token);
    for (const word of WORDS) expect(html).not.toContain(word);

    const head = await fetch(page(token), { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("unknown or malformed tokens → 404 (an 'expired' shell for the page, JSON for the endpoints)", async () => {
    const w = world();
    const { page } = await serve(w);
    const html = await fetch(page(UNKNOWN));
    expect(html.status).toBe(404);
    expect(await html.text()).toContain("no longer live");
    const state = await fetch(page(UNKNOWN, "/state"));
    expect(state.status).toBe(404);
    expect(await state.json()).toEqual({ error: "not-live" });
    expect((await fetch(page("abc"))).status).toBe(404);
    expect((await fetch(page(UNKNOWN, "/nope"))).status).toBe(404);
    expect((await fetch(`${page(UNKNOWN).replace(/\/enroll\/.*$/, "")}/other`)).status).toBe(404);
  });

  it("method guards: confirm is POST-only, page/state are GET/HEAD-only", async () => {
    const w = world();
    const { token } = await started(w);
    const { page } = await serve(w);
    const r1 = await fetch(page(token, "/confirm"));
    expect(r1.status).toBe(405);
    expect(r1.headers.get("allow")).toBe("POST");
    const r2 = await fetch(page(token, "/state"), { method: "POST" });
    expect(r2.status).toBe(405);
    expect(r2.headers.get("allow")).toBe("GET, HEAD");
  });

  it("non-loopback clients get 404 unless a browser-facing base URL or publicOrigin is configured", async () => {
    const w = world();
    const { token } = await started(w);
    const remote = { clientAddr: () => "203.0.113.9" };
    const closed = await serve(w, {} as OpenClawConfig, remote);
    expect((await fetch(closed.page(token))).status).toBe(404);
    expect((await fetch(closed.page(token, "/state"))).status).toBe(404);
    const viaBase = await serve(w, { channels: { ademu: { enrollmentPage: { baseUrl: "https://gw.example.com" } } } } as unknown as OpenClawConfig, remote);
    expect((await fetch(viaBase.page(token))).status).toBe(200);
    const viaOrigin = await serve(w, { gateway: { publicOrigin: "https://gw.example.com" } } as unknown as OpenClawConfig, remote);
    expect((await fetch(viaOrigin.page(token, "/state"))).status).toBe(200);
    // IPv4-mapped loopback counts as loopback
    const mapped = await serve(w, {} as OpenClawConfig, { clientAddr: () => "::ffff:127.0.0.1" });
    expect((await fetch(mapped.page(token))).status).toBe(200);
  });

  it("rate limits answer 429 (poll, confirm, and unknown-token guessing)", async () => {
    const w = world();
    const { token } = await started(w);
    const limited = new FixedWindowLimiter(60_000, 0);
    const open = new FixedWindowLimiter(60_000, 1000);
    const a = await serve(w, {} as OpenClawConfig, { limiters: { poll: limited, confirm: open, unknownToken: open } });
    expect((await fetch(a.page(token, "/state"))).status).toBe(429);
    const b = await serve(w, {} as OpenClawConfig, { limiters: { poll: open, confirm: limited, unknownToken: open } });
    expect((await confirmPost(b.page(token, "/confirm"))).status).toBe(429);
    const c = await serve(w, {} as OpenClawConfig, { limiters: { poll: open, confirm: open, unknownToken: limited } });
    expect((await fetch(c.page(UNKNOWN, "/state"))).status).toBe(429);
  });

  it("FixedWindowLimiter: counts per key per window, evicts the oldest key beyond its cap", () => {
    let t = 0;
    const l = new FixedWindowLimiter(1000, 2, 2, () => t);
    expect([l.isRateLimited("a"), l.isRateLimited("a"), l.isRateLimited("a")]).toEqual([false, false, true]);
    expect(l.isRateLimited("b")).toBe(false);
    expect(l.isRateLimited("c")).toBe(false); // evicts "a"
    expect(l.isRateLimited("a")).toBe(false); // fresh window for "a"
    t = 1000;
    expect(l.isRateLimited("c")).toBe(false); // window rolled
  });
});

describe("enrollment page: the ceremony (scan → words → Yes → enrolled)", () => {
  it("state follows the tool's entry, confirm before the scan is refused, the Yes runs the tool's confirm path exactly once", async () => {
    const w = world();
    const { token, leaseToken } = await started(w);
    const { page } = await serve(w);

    // awaiting the scan: the QR travels as a data URL plus the exact payload for the "can't scan" fallback
    const s1 = await fetch(page(token, "/state"));
    expect(s1.status).toBe(200);
    expect(await s1.json()).toEqual({ phase: "awaiting-scan", qrDataUrl: "data:image/png;base64,QUJD", qrPayload: QR });
    const early = await confirmPost(page(token, "/confirm"));
    expect(early.status).toBe(409);
    expect(await early.json()).toMatchObject({ ok: false, code: "not-ready" });
    expect(w.control.calls.some((c) => c.op === "confirm_words")).toBe(false);

    // the phone scanned: the DAEMON's words
    w.control.emit({ state: "paired", words: WORDS });
    expect(await (await fetch(page(token, "/state"))).json()).toEqual({ phase: "awaiting-yes", words: WORDS });

    // wrong content type is refused before anything happens
    expect((await confirmPost(page(token, "/confirm"), { "content-type": "text/plain" })).status).toBe(415);

    // the Yes: confirm_words with the daemon's words, then the outcome once the daemon reports enrolled
    const confirmP = confirmPost(page(token, "/confirm"));
    await tick(10);
    expect(w.control.calls.filter((c) => c.op === "confirm_words").map((c) => c.params)).toEqual([{ device_id: NEW_DEVICE, words: WORDS }]);
    expect(await (await fetch(page(token, "/state"))).json()).toEqual({ phase: "confirming" });
    // a second click while the first is in flight joins nothing and confirms nothing twice
    expect(await (await confirmPost(page(token, "/confirm"))).json()).toMatchObject({ ok: true, alreadyConfirmed: true });
    w.control.finish("enrolled");
    const done = await confirmP;
    expect(done.status).toBe(200);
    expect(await done.json()).toEqual({ ok: true, state: "done" });
    expect(w.writes).toHaveLength(1);
    expect(w.control.calls.filter((c) => c.op === "confirm_words")).toHaveLength(1);

    // the outcome stays readable after the lease is gone; a late Yes is idempotent
    expect(await (await fetch(page(token, "/state"))).json()).toEqual({ phase: "enrolled" });
    expect(await (await confirmPost(page(token, "/confirm"))).json()).toEqual({ ok: true, alreadyConfirmed: true, phase: "enrolled" });
    expect(w.registry.size).toBe(0);

    // and the chat door learns the outcome instead of "nothing in progress"
    const status = await w.call({ action: "status", leaseToken });
    expect(status.details).toMatchObject({ ok: true, state: "done" });
    expect(status.content[0]!.text).toContain("already finished");
    const wait = await w.call({ action: "wait", leaseToken });
    expect(wait.details).toMatchObject({ ok: true, state: "done" });
  });

  it("a mismatch reported by the daemon fails the page's confirm and ends the enrollment", async () => {
    const w = world();
    const { token } = await started(w);
    const { page } = await serve(w);
    w.control.emit({ state: "paired", words: WORDS });
    w.control.confirmWordsImpl = async () => {
      const { ControlError } = await import("@ademu/adc-control");
      throw new ControlError("words_mismatch", "mismatch");
    };
    const r = await confirmPost(page(token, "/confirm"));
    expect(await r.json()).toMatchObject({ ok: false, state: "words_mismatch" });
    expect(w.writes).toHaveLength(0);
    const st = (await (await fetch(page(token, "/state"))).json()) as { phase: string; message: string };
    expect(st.phase).toBe("failed");
    expect(st.message).toContain("did not match");
  });

  it("a cancel from chat shows the page an 'expired' outcome and refuses a late Yes", async () => {
    const w = world();
    const { token, leaseToken } = await started(w);
    const { page } = await serve(w);
    w.control.emit({ state: "paired", words: WORDS });
    await w.call({ action: "cancel", leaseToken });
    expect(await (await fetch(page(token, "/state"))).json()).toMatchObject({ phase: "expired" });
    const late = await confirmPost(page(token, "/confirm"));
    expect(await late.json()).toMatchObject({ ok: false, code: "not-live" });
    expect(w.control.calls.some((c) => c.op === "confirm_words")).toBe(false);
  });

  it("a confirm from chat is visible to the page as confirming → enrolled", async () => {
    const w = world();
    const { token, leaseToken } = await started(w);
    const { page } = await serve(w);
    w.control.emit({ state: "paired", words: WORDS });
    const chat = w.call({ action: "confirm", leaseToken });
    await tick(10);
    expect(await (await fetch(page(token, "/state"))).json()).toEqual({ phase: "confirming" });
    expect(await (await confirmPost(page(token, "/confirm"))).json()).toMatchObject({ ok: true, alreadyConfirmed: true });
    w.control.finish("enrolled");
    await chat;
    expect(await (await fetch(page(token, "/state"))).json()).toEqual({ phase: "enrolled" });
  });

  it("a token that already exists on the device is reported as an outcome the page cannot resolve", async () => {
    const w = world();
    const { token } = await started(w);
    const { page } = await serve(w);
    w.control.emit({ state: "paired", words: WORDS });
    const { ControlError } = await import("@ademu/adc-control");
    w.control.tokenMintImpl = async () => {
      throw new ControlError("label_exists", "exists");
    };
    const confirmP = confirmPost(page(token, "/confirm"));
    await tick(10);
    w.control.finish("enrolled");
    expect(await (await confirmP).json()).toMatchObject({ ok: false, state: "label_exists" });
    const st = (await (await fetch(page(token, "/state"))).json()) as { phase: string; message: string };
    expect(st.phase).toBe("failed");
    expect(st.message).toContain("already exists");
  });
});
