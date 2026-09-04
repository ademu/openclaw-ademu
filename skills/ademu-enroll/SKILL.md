---
name: ademu-enroll
description: Enroll this agent on Ademú (end-to-end encrypted messaging) or connect an already-enrolled one, using the ademu_enroll tool — QR scan, four safety words, then the agent answers from the user's phone.
user-invocable: true
metadata: { "openclaw": { "emoji": "🔐" } }
---

# Enrolling on Ademú

Use this when the user says things like "I want to talk to you on Ademú", "enroll on Ademú",
"connect to the Ademú app", or asks how to reach you from their phone with end-to-end encryption.
The `ademu_enroll` tool exists only when the person asking is an OpenClaw owner; if it is not in
your tool list, say that enrollment must be started by the owner (from the web UI or with
`openclaw channels add --channel ademu` in a terminal).

## The four steps

1. **start** — call `ademu_enroll` with `action: "start"` (optional `agentName`, `accountId`).
   Show the returned QR image and the `ademu://` link to the user. Tell them: open Ademú on the
   phone → profile → Agents → Add → scan. Keep the returned `leaseToken`; every later call needs it.
2. **wait** — call `action: "wait"` (with the `leaseToken`). When the phone has scanned, the tool
   returns four safety words. Read them to the user exactly as returned and ask: "Do these match
   what your phone shows?" Never invent, reorder, or "correct" words.
3. **confirm** — only after the user clearly says the words match, call `action: "confirm"`.
   The tool confirms with the daemon's own words (you cannot supply them), waits for the phone
   to finish, issues the device token, and writes the account into the OpenClaw config. If the
   user says the words do NOT match, call `action: "cancel"` and explain that nothing was enrolled.
4. **done** — tell the user the agent is on Ademú now and they can message it from the phone.
   The channel starts automatically; if not, `openclaw gateway restart` picks it up.

If `confirm` reports that a token for this account already exists, ask the user whether to replace
it (the old one stops working). Only if they agree call `action: "replace_token"`.

## Vocabulary

Say **enroll**, **enrollment**, **connect**. Do not describe the ceremony with the other
common linking word; Ademú uses that word for something else.

## What the QR and the words are

The QR carries a one-time enrollment key; scanning it lets the phone verify the agent device.
The four words are a safety check derived on both sides so a tampered connection would show
different words on the phone than in the tool result. A mismatch means: stop.

## If the device host is not available

The tool may answer that the Ademú device host (the `adc` daemon) could not start. Do not try to
install anything yourself. Tell the user what the tool said (usually: check
`channels.ademu.server` or the daemon log path it names) and stop.
