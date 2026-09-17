// The enrollment page's HTML shell — a pure template with ZERO ceremony data baked in. Everything
// the user sees (QR, link, words, outcome) arrives through the polled `/state` endpoint; the inline
// script derives its fetch URLs from `location.pathname`, so gateway base paths and reverse-proxy
// prefixes are transparent. The only dynamic values are the CSP nonce and the "expired" flag (the
// 404 shell for a token that is no longer live). No external assets (CSP `default-src 'none'`):
// one style block, one script block, the QR as a `data:` image. Copy lives in `strings.enroll.page*`.
import { strings } from "./i18n/strings.js";

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function renderEnrollmentPageHtml(opts: { cspNonce: string; expired?: boolean }): string {
  const nonce = opts.cspNonce;
  const p = strings.enroll;
  const initial = opts.expired ? "expired" : "loading";
  const active = (id: string) => (id === initial ? " active" : "");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex, nofollow">
<title>${esc(p.pageTitle)}</title>
<style nonce="${nonce}">
  :root { color-scheme: light dark; }
  body { margin: 0; padding: 2rem 1rem; font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif; background: Canvas; color: CanvasText; display: flex; justify-content: center; }
  .card { max-width: 28rem; width: 100%; }
  h1 { font-size: 1.3rem; }
  .screen { display: none; }
  .screen.active { display: block; }
  .qr { width: 16rem; height: 16rem; image-rendering: pixelated; display: block; margin: 1rem auto; background: #fff; padding: 0.75rem; border-radius: 0.5rem; }
  .words { font-size: 1.4rem; font-weight: 700; letter-spacing: 0.05em; text-align: center; margin: 1.5rem 0; word-spacing: 1em; }
  pre.link { white-space: pre-wrap; word-break: break-all; user-select: all; -webkit-user-select: all; background: color-mix(in srgb, CanvasText 8%, Canvas); padding: 0.75rem; border-radius: 0.5rem; font-size: 0.8rem; }
  button { font: inherit; padding: 0.6rem 1.2rem; border-radius: 0.5rem; border: 1px solid color-mix(in srgb, CanvasText 30%, Canvas); background: color-mix(in srgb, CanvasText 6%, Canvas); color: inherit; cursor: pointer; }
  button.primary { background: #2563eb; border-color: #2563eb; color: #fff; font-weight: 600; width: 100%; padding: 0.9rem; font-size: 1rem; }
  button:disabled { opacity: 0.5; cursor: default; }
  .muted { opacity: 0.75; font-size: 0.9rem; }
  .warn { color: #b45309; font-size: 0.9rem; }
  .banner { border: 1px solid #b45309; border-radius: 0.5rem; padding: 0.75rem; margin-top: 1rem; font-size: 0.9rem; display: none; }
  .banner.active { display: block; }
  details { margin-top: 1rem; }
</style>
</head>
<body>
<div class="card">
  <noscript><p>${esc(p.pageNoScript)}</p></noscript>

  <div id="loading" class="screen${active("loading")}"><p class="muted">${esc(p.pageLoading)}</p></div>

  <div id="awaiting-scan" class="screen">
    <h1>${esc(p.pageScanHeading)}</h1>
    <img id="qr" class="qr" alt="${esc(p.pageQrAlt)}">
    <p>${esc(p.scanHint)}</p>
    <details>
      <summary>${esc(p.pageCannotScan)}</summary>
      <p class="muted">${esc(p.pageCannotScanHint)}</p>
      <pre id="link" class="link"></pre>
      <button id="copy" type="button">${esc(p.pageCopy)}</button>
    </details>
  </div>

  <div id="awaiting-yes" class="screen">
    <h1>${esc(p.pageWordsHeading)}</h1>
    <p>${esc(p.pageWordsHint)}</p>
    <p id="words" class="words"></p>
    <button id="confirm" class="primary" type="button">${esc(p.pageYes)}</button>
    <p class="warn">${esc(p.pageMismatchWarn)}</p>
  </div>

  <div id="confirming" class="screen"><h1>${esc(p.pageConfirmingHeading)}</h1><p class="muted">${esc(p.pageConfirmingHint)}</p></div>

  <div id="enrolled" class="screen"><h1>${esc(p.pageEnrolledHeading)}</h1><p>${esc(p.pageEnrolled)}</p></div>

  <div id="failed" class="screen"><h1>${esc(p.pageFailedHeading)}</h1><p id="failed-message"></p></div>

  <div id="expired" class="screen${active("expired")}"><h1>${esc(p.pageExpiredHeading)}</h1><p id="expired-message">${esc(p.pageExpired)}</p></div>

  <div id="error" class="banner"><span id="error-text"></span></div>
</div>

<script nonce="${nonce}">
(function () {
  'use strict';
  if (${opts.expired ? "true" : "false"}) { return; }
  var base = location.pathname.replace(/\\/+$/, '');
  var screens = ['loading', 'awaiting-scan', 'awaiting-yes', 'confirming', 'enrolled', 'failed', 'expired'];
  var pollMs = 2000, backoffMs = 2000, stopped = false, confirming = false;
  var copy = {
    yes: ${JSON.stringify(p.pageYes)}, confirming: ${JSON.stringify(p.pageConfirming)}, confirmedWait: ${JSON.stringify(p.pageConfirmedWait)},
    copied: ${JSON.stringify(p.pageCopied)}, unreachable: ${JSON.stringify(p.pageUnreachable)}, confirmFailed: ${JSON.stringify(p.pageConfirmFailed)}
  };

  function el(id) { return document.getElementById(id); }
  function show(id) { for (var i = 0; i < screens.length; i++) { el(screens[i]).classList.toggle('active', screens[i] === id); } }
  function banner(msg) { el('error-text').textContent = msg || ''; el('error').classList.toggle('active', Boolean(msg)); }
  function stop(screen) { stopped = true; if (screen) { show(screen); } }

  function apply(state) {
    banner('');
    backoffMs = 2000;
    if (state.phase === 'awaiting-scan') {
      if (state.qrDataUrl) { el('qr').src = state.qrDataUrl; }
      if (state.qrPayload) { el('link').textContent = state.qrPayload; }
      show('awaiting-scan');
    } else if (state.phase === 'awaiting-yes') {
      el('words').textContent = (state.words || []).join('  ');
      if (!confirming) { show('awaiting-yes'); }
    } else if (state.phase === 'confirming') {
      show('confirming');
    } else if (state.phase === 'enrolled') {
      stop('enrolled');
    } else if (state.phase === 'failed') {
      el('failed-message').textContent = state.message || '';
      stop('failed');
    } else if (state.phase === 'expired') {
      if (state.message) { el('expired-message').textContent = state.message; }
      stop('expired');
    }
  }

  function poll() {
    if (stopped) { return; }
    fetch(base + '/state', { cache: 'no-store' }).then(function (res) {
      if (res.status === 404) { stop('expired'); return null; }
      if (res.status === 429) { backoffMs = 30000; return null; }
      return res.json();
    }).then(function (state) {
      if (state) { apply(state); }
    }).catch(function () {
      banner(copy.unreachable);
      backoffMs = Math.min(backoffMs * 2, 15000);
    }).then(function () {
      if (!stopped) { setTimeout(poll, Math.max(pollMs, backoffMs)); }
    });
  }

  el('copy').addEventListener('click', function () {
    var text = el('link').textContent;
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text);
    } else {
      var range = document.createRange();
      range.selectNodeContents(el('link'));
      var sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
      document.execCommand('copy');
    }
    el('copy').textContent = copy.copied;
  });

  el('confirm').addEventListener('click', function () {
    if (confirming) { return; }
    confirming = true;
    var btn = el('confirm');
    btn.disabled = true;
    btn.textContent = copy.confirming;
    // Polling continues in parallel: whichever of this POST or the next poll reports the outcome
    // first flips the terminal screen.
    fetch(base + '/confirm', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
      .then(function (res) { return res.json(); })
      .then(function (out) {
        if (out && out.ok) {
          btn.textContent = copy.confirmedWait;
          if (out.state === 'done' || out.phase === 'enrolled') { stop('enrolled'); } else { show('confirming'); }
        } else {
          confirming = false;
          btn.disabled = false;
          btn.textContent = copy.yes;
          banner((out && out.message) || copy.confirmFailed);
        }
      })
      .catch(function () {
        confirming = false;
        btn.disabled = false;
        btn.textContent = copy.yes;
        banner(copy.unreachable);
      });
  });

  poll();
})();
</script>
</body>
</html>
`;
}
