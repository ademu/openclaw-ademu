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
  isLoopbackEnrollmentPageUrl,
  pageOriginListening,
  registerEnrollmentPage,
  spawnOpener,
} from "../src/enrollment-page.js";
import { cancelByHuman, confirmByHuman } from "../src/tools/enroll.js";
import { NEW_DEVICE, QR, WORDS } from "./fakes/control.js";
import { tick, world } from "./fakes/enroll-world.js";

type Route = { path: string; match?: string; auth: string; replaceExisting?: boolean; handler: (req: http.IncomingMessage, res: http.ServerResponse) => unknown };
type World = ReturnType<typeof world>;

const servers: http.Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function serve(w: World, over: Partial<EnrollmentPageDeps> = {}) {
  let route: Route | undefined;
  const api = { registerHttpRoute: (r: Route) => void (route = r) };
  registerEnrollmentPage(api as never, {
    registry: w.registry,
    qr: w.deps.qr,
    confirm: (active) => confirmByHuman(active, w.deps, w.registry),
    cancel: (active) => cancelByHuman(active, w.registry),
    ...over,
  });
  const server = http.createServer((req, res) => void route!.handler(req, res));
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  const { port } = server.address() as AddressInfo;
  const base = `http://127.0.0.1:${port}${ENROLLMENT_ROUTE_PREFIX}/enroll`;
  return { route: route!, base, page: (token: string, sub = "") => `${base}/${token}${sub}` };
}

/**
 * Starts an enrollment through the real tool and returns its page token. The ONLY place the URL surfaces
 * is the browser launcher (`w.opens`): the tool result carries neither the URL nor the token.
 */
async function started(w: World) {
  const before = w.opens.length;
  const start = await w.call({ action: "start", agentName: "Iris" });
  const pageUrl = w.opens[before]!;
  return { start, pageUrl, token: pageUrl.slice(pageUrl.lastIndexOf("/") + 1) };
}

const confirmPost = (url: string, headers: Record<string, string> = { "content-type": "application/json" }) =>
  fetch(url, { method: "POST", headers, body: "{}" });

const UNKNOWN = "0".repeat(40);

/** A request with headers fetch will not let us set (Host). */
function raw(url: string, headers: Record<string, string>, method = "GET"): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(url, { method, headers }, (res) => {
      res.resume();
      res.on("end", () => resolve({ status: res.statusCode ?? 0 }));
    });
    req.on("error", reject);
    req.end(method === "POST" ? "{}" : undefined);
  });
}

describe("enrollment page: the tool's start result", () => {
  it("opens a loopback page URL with a 40-hex token exactly once, and the result names neither the URL, the token, the QR nor the words", async () => {
    const w = world();
    const { start, pageUrl, token } = await started(w);
    expect(pageUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/plugins\/ademu\/enroll\/[a-f0-9]{40}$/);
    expect(w.opens).toEqual([pageUrl]);
    expect(start.details).toMatchObject({ ok: true, state: "scanning", pageOpened: true });
    expect(start.details).not.toHaveProperty("pageUrl");
    const txt = start.content[0]!.text;
    expect(txt).toContain("OPENED");
    expect(txt).not.toMatch(/https?:\/\//);
    expect(txt).not.toContain(token);
    expect(txt).not.toContain("data:image");
    expect(txt).not.toContain(QR);
  });

  it("a gateway bound to a non-loopback host has no page to show: start refuses BEFORE any device or lease exists", async () => {
    const w = world({ gateway: { port: 4321, bind: "custom", customBindHost: "10.0.0.5" } } as unknown as OpenClawConfig);
    const r = await w.call({ action: "start", agentName: "Iris" });
    expect(r.details).toMatchObject({ ok: false, state: "page_unreachable" });
    expect(r.content[0]!.text).toContain("openclaw channels add --channel ademu");
    expect(r.content[0]!.text).not.toMatch(/https?:\/\//);
    expect(w.control.calls).toEqual([]);
    expect(w.acquires).toEqual([]);
    expect(w.opens).toEqual([]);
  });

  it("a gateway that does not listen on the loopback origin (bind tailnet → the Tailscale IP) has no page either: refused BEFORE any device or lease (Codex branch pass 2, #712 PR-a)", async () => {
    const w = world({ gateway: { port: 4321, bind: "tailnet" } } as unknown as OpenClawConfig);
    const probed: string[] = [];
    w.deps.pageListening = async (base) => {
      probed.push(base);
      return false;
    };
    const r = await w.call({ action: "start", agentName: "Iris" });
    expect(probed).toEqual(["http://127.0.0.1:4321"]);
    expect(r.details).toMatchObject({ ok: false, state: "page_unreachable" });
    expect(r.content[0]!.text).toContain("openclaw channels add --channel ademu");
    expect(w.control.calls).toEqual([]);
    expect(w.acquires).toEqual([]);
    expect(w.opens).toEqual([]);
    // the conversation is not left reserved: a later start (listener back) proceeds
    w.deps.pageListening = async () => true;
    expect((await w.call({ action: "start", agentName: "Iris" })).details).toMatchObject({ ok: true });
  });

  it("the launcher reports the opener's outcome, not just its spawn: exit 0 or still running at the grace → opened; a non-zero exit or no such command → not opened (Codex branch pass 3, #712 PR-a)", async () => {
    expect(await spawnOpener("sh", ["-c", "exit 0"], 2_000)).toBe(true);
    expect(await spawnOpener("sh", ["-c", "exit 3"], 2_000)).toBe(false); // xdg-open with no desktop session
    expect(await spawnOpener("sh", ["-c", "sleep 5"], 100)).toBe(true); // an opener that execs the browser
    expect(await spawnOpener("/nonexistent/opener", [], 2_000)).toBe(false);
  });

  it("pageOriginListening asks the system: a listener on the origin → true, a closed port → false", async () => {
    const server = http.createServer();
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
    const { port } = server.address() as AddressInfo;
    expect(await pageOriginListening(`http://127.0.0.1:${port}`)).toBe(true);
    await new Promise<void>((r) => server.close(() => r()));
    expect(await pageOriginListening(`http://127.0.0.1:${port}`)).toBe(false);
  });

  it("a browser launcher that throws or returns false FAILS the start: lease disposed once, pairing cancelled, nothing written, no URL offered", async () => {
    for (const launcher of [async () => false, async () => Promise.reject(new Error("no opener"))]) {
      const w = world();
      w.deps.openUrl = launcher as typeof w.deps.openUrl;
      const r = await w.call({ action: "start", agentName: "Iris" });
      expect(r.details).toMatchObject({ ok: false, state: "page_open_failed" });
      expect(r.content[0]!.text).toContain("openclaw channels add --channel ademu");
      expect(r.content[0]!.text).not.toMatch(/https?:\/\//);
      expect(w.registry.size).toBe(0);
      expect(w.released()).toBe(1);
      expect(w.control.closed).toBe(1);
      expect(w.control.calls.some((c) => c.op === "cancel_pairing")).toBe(true);
      expect(w.writes).toEqual([]);
    }
  });

  it("status re-opens a page no browser ever fetched — after a grace, through the launcher, never through the model — and stops once the shell was served", async () => {
    const w = world();
    let now = 0;
    w.deps.lease.now = () => now;
    const { pageUrl, token } = await started(w);
    // Inside the grace: the browser may still be starting.
    let s = await w.call({ action: "status" });
    expect(w.opens).toHaveLength(1);
    expect(s.details).not.toHaveProperty("pageReopened");
    // Past the grace, still no fetch of the shell: opened again, with the same URL, and the result says so without naming it.
    now = 6_000;
    s = await w.call({ action: "status" });
    expect(w.opens).toEqual([pageUrl, pageUrl]);
    expect(s.details).toMatchObject({ ok: true, state: "scanning", pageReopened: true });
    expect(s.content[0]!.text).toContain("opened it again");
    expect(s.content[0]!.text).not.toMatch(/https?:\/\//);
    expect(s.content[0]!.text).not.toContain(token);
    // A browser fetched the shell → no more re-opens, however long it takes.
    const { page } = await serve(w);
    expect((await fetch(page(token))).status).toBe(200);
    now = 60_000;
    s = await w.call({ action: "status" });
    expect(w.opens).toHaveLength(2);
    expect(s.details).not.toHaveProperty("pageReopened");
    // Nor once the phone has scanned (a served page is implied; the phase guard is belt and braces).
    w.control.emit({ state: "paired", words: WORDS });
    now = 120_000;
    s = await w.call({ action: "status" });
    expect(w.opens).toHaveLength(2);
    expect(s.details.state).toBe("words_shown");
  });

  it("a HEAD of the shell does not count as served (the browser renders GET)", async () => {
    const w = world();
    let now = 0;
    w.deps.lease.now = () => now;
    const { token } = await started(w);
    const { page } = await serve(w);
    expect((await fetch(page(token), { method: "HEAD" })).status).toBe(200);
    now = 6_000;
    await w.call({ action: "status" });
    expect(w.opens).toHaveLength(2);
  });
});

describe("enrollment page: URL derivation", () => {
  it("the gateway's own bind decides the origin (port never hardcoded); nothing else does", () => {
    expect(enrollmentPageBaseUrl({ gateway: { port: 4321 } } as unknown as OpenClawConfig, {})).toBe("http://127.0.0.1:4321");
    expect(enrollmentPageBaseUrl({ gateway: { port: 4321, tls: { enabled: true }, bind: "custom", customBindHost: "10.0.0.5" } } as unknown as OpenClawConfig, {})).toBe(
      "https://10.0.0.5:4321",
    );
    // Former remote-exposure settings are ignored (and rejected by the config schema).
    expect(enrollmentPageBaseUrl({ gateway: { port: 4321, publicOrigin: "https://b.example" } } as unknown as OpenClawConfig, {})).toBe("http://127.0.0.1:4321");
    expect(enrollmentPageUrl({ gateway: { port: 1 } } as unknown as OpenClawConfig, "t", {})).toBe("http://127.0.0.1:1/plugins/ademu/enroll/t");
  });

  it("only loopback URLs can be shown", () => {
    expect(isLoopbackEnrollmentPageUrl("http://127.0.0.1:1/x")).toBe(true);
    expect(isLoopbackEnrollmentPageUrl("http://localhost:1/x")).toBe(true);
    expect(isLoopbackEnrollmentPageUrl("http://[::1]:1/x")).toBe(true);
    expect(isLoopbackEnrollmentPageUrl("https://10.0.0.5:1/x")).toBe(false);
    expect(isLoopbackEnrollmentPageUrl("https://gw.example.com/x")).toBe(false);
    expect(isLoopbackEnrollmentPageUrl("not a url")).toBe(false);
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
    expect(html).toContain("No — they differ");
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
    const r3 = await fetch(page(token, "/cancel"));
    expect(r3.status).toBe(405);
    expect(r3.headers.get("allow")).toBe("POST");
  });

  it("non-loopback clients always get 404 — every endpoint, no setting widens it", async () => {
    const w = world();
    const { token } = await started(w);
    const remote = { clientAddr: () => "203.0.113.9" };
    const closed = await serve(w, remote);
    expect((await fetch(closed.page(token))).status).toBe(404);
    expect((await fetch(closed.page(token, "/state"))).status).toBe(404);
    expect((await confirmPost(closed.page(token, "/confirm"))).status).toBe(404);
    expect((await confirmPost(closed.page(token, "/cancel"))).status).toBe(404);
    // IPv4-mapped loopback counts as loopback
    const mapped = await serve(w, { clientAddr: () => "::ffff:127.0.0.1" });
    expect((await fetch(mapped.page(token))).status).toBe(200);
  });

  it("a loopback peer that is a local reverse proxy (forwarding headers) or a non-loopback Host gets 404, before any rate limit (Codex branch pass, #712 PR-a)", async () => {
    const w = world();
    const { token } = await started(w);
    // One poll per window: a refused request must not spend it.
    const one = new FixedWindowLimiter(60_000, 1);
    const open = new FixedWindowLimiter(60_000, 1000);
    const s = await serve(w, { limiters: { poll: one, confirm: open, unknownToken: open } });
    const port = new URL(s.base).port;
    for (const headers of [
      { "x-forwarded-port": "443" },
      { "x-forwarded-server": "proxy" },
      { "tailscale-user-login": "someone@example.com" },
      { "cf-connecting-ip": "203.0.113.9" },
      { "true-client-ip": "203.0.113.9" },
      { "x-forwarded-for": "203.0.113.9" },
      { forwarded: "for=203.0.113.9;proto=https" },
      { "x-real-ip": "203.0.113.9" },
      { "x-forwarded-host": "gateway.example.com" },
      { host: "gateway.example.com" },
      { host: `rebind.example:${port}` },
    ]) {
      expect((await raw(s.page(token, "/state"), headers)).status, JSON.stringify(headers)).toBe(404);
      expect((await raw(s.page(token, "/confirm"), { ...headers, "content-type": "application/json" }, "POST")).status).toBe(404);
    }
    expect(w.control.calls.filter((c) => c.op === "confirm_words")).toEqual([]);
    // the one poll is still there for the human's own browser (a loopback Host, no forwarding)
    expect((await raw(s.page(token, "/state"), { host: `localhost:${port}` })).status).toBe(200);
    const s2 = await serve(w);
    expect((await raw(s2.page(token, "/state"), { host: `[::1]:${new URL(s2.base).port}` })).status).toBe(200);
  });

  it("token-less traffic cannot spend the human's budget: unknown tokens draw only on the guessing budget, a live token has its own (Codex branch pass 2, #712 PR-a)", async () => {
    // A header-stripping local proxy looks local; the bearer token is then the only boundary, and it
    // must not be possible to starve the token holder without it.
    const w = world();
    const { token } = await started(w);
    const s = await serve(w, { limiters: { poll: new FixedWindowLimiter(60_000, 2), confirm: new FixedWindowLimiter(60_000, 2), unknownToken: new FixedWindowLimiter(60_000, 1000) } });
    for (let i = 0; i < 5; i++) {
      expect((await fetch(s.page(UNKNOWN, "/state"))).status).toBe(404);
      expect((await confirmPost(s.page(UNKNOWN, "/confirm"))).status).toBe(404);
    }
    expect((await fetch(s.page(token, "/state"))).status).toBe(200);
  });

  it("rate limits answer 429 (poll, confirm, and unknown-token guessing)", async () => {
    const w = world();
    const { token } = await started(w);
    const limited = new FixedWindowLimiter(60_000, 0);
    const open = new FixedWindowLimiter(60_000, 1000);
    const a = await serve(w, { limiters: { poll: limited, confirm: open, unknownToken: open } });
    expect((await fetch(a.page(token, "/state"))).status).toBe(429);
    const b = await serve(w, { limiters: { poll: open, confirm: limited, unknownToken: open } });
    expect((await confirmPost(b.page(token, "/confirm"))).status).toBe(429);
    const c = await serve(w, { limiters: { poll: open, confirm: open, unknownToken: limited } });
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
    const { token } = await started(w);
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
    const status = await w.call({ action: "status" });
    expect(status.details).toMatchObject({ ok: true, state: "done" });
    expect(status.content[0]!.text).toContain("Enrolled");
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

  it("the No button: refused before the scan, cancels once after the words, idempotent, and the chat sees cancelled", async () => {
    const w = world();
    const { token } = await started(w);
    const { page } = await serve(w);
    const early = await confirmPost(page(token, "/cancel"));
    expect(early.status).toBe(200); // a "no" before any words is still the user's decision to stop
    expect(await early.json()).toMatchObject({ ok: true, state: "cancelled" });
    expect(w.control.calls.some((c) => c.op === "cancel_pairing")).toBe(true);
    expect(await (await fetch(page(token, "/state"))).json()).toEqual({ phase: "cancelled" });
    expect(await (await confirmPost(page(token, "/cancel"))).json()).toMatchObject({ ok: true, alreadyCancelled: true });
    const lateYes = await confirmPost(page(token, "/confirm"));
    expect(await lateYes.json()).toMatchObject({ ok: false, code: "not-live" });
    expect(w.control.calls.some((c) => c.op === "confirm_words")).toBe(false);
    expect(w.writes).toHaveLength(0);
    expect((await w.call({ action: "status" })).details).toMatchObject({ ok: true, state: "cancelled" });
  });

  it("a No while the yes is committing is refused (409) and the enrollment completes", async () => {
    const w = world();
    let releaseWrite!: () => void;
    const gate = new Promise<void>((r) => {
      releaseWrite = r;
    });
    const origWrite = w.deps.writeConfig;
    w.deps.writeConfig = async (mutate) => {
      await gate;
      await origWrite(mutate);
    };
    const { token } = await started(w);
    const { page } = await serve(w);
    w.control.emit({ state: "paired", words: WORDS });
    const yesP = confirmPost(page(token, "/confirm"));
    await tick(5);
    w.control.finish("enrolled");
    await tick(10);
    const noRes = await confirmPost(page(token, "/cancel"));
    expect(noRes.status).toBe(409);
    expect(await noRes.json()).toMatchObject({ ok: false, state: "committing" });
    releaseWrite();
    expect(await (await yesP).json()).toEqual({ ok: true, state: "done" });
    expect(w.writes).toHaveLength(1);
  });

  it("a yes from a channel button is visible to the page as confirming → enrolled", async () => {
    const w = world();
    const { token } = await started(w);
    const { page } = await serve(w);
    w.control.emit({ state: "paired", words: WORDS });
    const button = confirmByHuman(w.registry.get(NEW_DEVICE)!, w.deps, w.registry);
    await tick(10);
    expect(await (await fetch(page(token, "/state"))).json()).toEqual({ phase: "confirming" });
    expect(await (await confirmPost(page(token, "/confirm"))).json()).toMatchObject({ ok: true, alreadyConfirmed: true });
    w.control.finish("enrolled");
    await button;
    expect(await (await fetch(page(token, "/state"))).json()).toEqual({ phase: "enrolled" });
  });

  it("a taken token label is `mint_lost` (never replaced over the enrollment socket): nothing written, the page reports the failure", async () => {
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
    expect(await (await confirmP).json()).toMatchObject({ ok: false, state: "mint_lost" });
    expect(w.control.calls.filter((c) => c.op === "token_mint")).toHaveLength(1);
    expect(w.writes).toHaveLength(0);
    // Codex #4: the page's failed screen carries the human's instruction, not a generic line
    const state = (await (await fetch(page(token, "/state"))).json()) as { phase: string; message?: string };
    expect(state.phase).toBe("failed");
    expect(state.message).toContain(`token mint ${NEW_DEVICE} --label openclaw-iris-2`);
  });
});

describe("enrollment page: cancel before the scan", () => {
  it("the scan screen carries a Cancel button on the same /cancel endpoint; a scanning ceremony is cancelled, nothing written", async () => {
    const w = world();
    const { token } = await started(w);
    const { page } = await serve(w);
    const html = await (await fetch(page(token))).text();
    expect(html).toContain('id="cancel-scan"');
    expect(html).toContain("Cancel this enrollment");
    const r = await confirmPost(page(token, "/cancel"));
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ ok: true, state: "cancelled" });
    expect(w.registry.size).toBe(0);
    expect(w.released()).toBe(1);
    expect(w.control.calls.some((c) => c.op === "cancel_pairing")).toBe(true);
    expect(w.writes).toEqual([]);
    const state = await (await fetch(page(token, "/state"))).json();
    expect(state).toMatchObject({ phase: "cancelled" });
    // The chat learns the human's decision; a fresh start is possible now.
    expect((await w.call({ action: "status" })).details.state).toBe("cancelled");
    expect((await w.call({ action: "start", agentName: "Iris" })).details).toMatchObject({ ok: true, state: "scanning" });
  });
});
