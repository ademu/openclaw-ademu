# Changelog

All notable changes to `@ademu/openclaw-ademu` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver from 0.1.0.
Each release pins the exact `@ademu/adc-bin` (Ademú device daemon) version it was tested with.

## [Unreleased]

### Changed

- **The model never confirms or cancels an enrollment.** `ademu_enroll` now has exactly two actions,
  `start` and `status`. Removed: `wait` (the safety words never enter the model's context), `confirm`,
  `replace_token`, `cancel`, and the lease token the model had to carry (follow-up calls are bound by
  conversation, sender and agent). The human's yes / no come from the enrollment page; a duplicate
  token label on the freshly created device is replaced silently (it can only be this ceremony's own
  earlier attempt).
- **The ceremony is page-only.** Whatever chat the request came from, `start` opens the enrollment page
  on the gateway machine; the user is assumed to be there (or to run the terminal wizard). The chat-push
  lane that had been added on this branch — QR image + link pushed into Telegram / Slack / Discord with
  Yes / No buttons, quoted-reply `yes` / `no` on WhatsApp, Signal, Matrix, Mattermost and Google Chat, the
  `before_dispatch` hook and the `registerInteractiveHandler` registrations — was moved to a separate
  branch (`feature/outbound-mirror`) and is not part of this release.

### Added

- The **enrollment page**: a browser page served on the gateway itself (`/plugins/ademu/enroll/<token>`)
  that shows the QR, then the four safety words with **Yes — the words match** and **No — they differ**.
  On the gateway machine the tool opens it in the browser automatically when its URL is loopback, so a
  TUI user (no image rendering there) still only asks, scans, and clicks. Settings:
  `channels.ademu.enrollmentPage.autoOpen` (default true) and `channels.ademu.enrollmentPage.baseUrl`
  (browser-facing origin for remote gateways; also enables non-loopback access, otherwise the route
  answers 404 off-host).

### Fixed

- Enrolling from chat (`ademu_enroll`) now writes the routing binding for the enrolling agent
  (`bindings: [{ agentId, match: { channel: "ademu", accountId } }]`) in the same config write as the
  account, like the wizard's routing step. Without it, a multi-agent install refused the new account's
  messages (`agents.ownership: "explicit"` → `AGENT_SELECTION_REQUIRED`, gray ticks forever) or sent
  them to the default agent. The tool refuses at `start`, before any device is created, when the
  conversation names no configured agent or the account id is already routed to another agent; there
  is no fallback to a default agent. `openclaw channels remove` deletes the account's binding with it.
- Load at gateway startup (`activation.onStartup: true`) so the `ademu_enroll` chat tool exists before
  the first account is enrolled (E2E finding #1). Read-receipt copy says green, not blue.

## [0.1.0] — unreleased

Tested with `@ademu/adc-bin` **0.2.4** and OpenClaw **2026.9.1** (minimum host `>=2026.8.1`).

### Added

- Slice OPENCLAW-ADEMU-1: the Ademú channel for OpenClaw. Enroll an agent on Ademú from the
  `openclaw channels add --channel ademu` wizard or from chat with the owner-gated
  `ademu_enroll` tool; the agent then lives in Ademú conversations as a resident — messages arrive
  with cryptographic sender identity, green (read) ticks mean OpenClaw has taken ownership of the message
  before the model runs, typing shows while it composes, replies go back end-to-end encrypted.
