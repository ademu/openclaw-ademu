# Changelog

All notable changes to `@ademu/openclaw-ademu` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver from 0.1.0.
Each release pins the exact `@ademu/adc-bin` (Ademú device daemon) version it was tested with.

## [Unreleased]

Tested with `@ademu/adc-bin` **0.3.0**.

### Changed

- Typing is a pulse (AdemuMLS#621): the daemon relays each keepalive tick as at most one typing frame and
  no longer resends on its own, so the indicator clears ~3 s after the reply instead of staying lit
  forever (the daemon's resend loop was armed by every reply and never disarmed). `typingKeepaliveMs`
  is clamped to 2500 ms at runtime (the schema still accepts 500–10000).
- No typing during heartbeat runs: `heartbeat.sendTyping` is gone. A heartbeat that produces a message
  still delivers it; one that ends in `NO_REPLY` shows nothing.

### Fixed

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
