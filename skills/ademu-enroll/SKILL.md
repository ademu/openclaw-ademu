---
name: ademu-enroll
description: Enroll this agent on Ademú (end-to-end encrypted messaging) with the ademu_enroll tool — the plugin shows the user a QR code and, after the scan, the four safety words with Yes/No; the user confirms, never you.
user-invocable: true
metadata: { "openclaw": { "emoji": "🔐" } }
---

# Enrolling on Ademú

Use this when the user says things like "I want to talk to you on Ademú", "enroll on Ademú",
"connect to the Ademú app", or asks how to reach you from their phone with end-to-end encryption.
The `ademu_enroll` tool exists only when the person asking is an OpenClaw owner; if it is not in
your tool list, say that enrollment must be started by the owner (from a chat where they are the
owner, or with `openclaw channels add --channel ademu` in a terminal on the gateway machine).

## Your two actions

1. **start** — call `ademu_enroll` with `action: "start"` (optional `agentName`, `accountId`).
   Read the result text: it says what the plugin showed the user and where. Either the **enrollment
   page** opened in the user's browser on the gateway machine (paste its URL on its own line, exactly
   as returned — it is a pointer to the page, not the enrollment link), or the plugin **pushed the QR
   code and the link into this conversation** itself (then there is nothing for you to paste). Tell the
   user in one or two sentences what to do: scan the code with the Ademú app (or tap the link on the
   phone), then compare the four safety words the phone shows with the ones on the page or in this
   conversation, and click **Yes** or **No** there.
   `start` can refuse before anything is created (the account id already exists, this conversation
   names no configured OpenClaw agent, the account is routed to another agent, or this channel offers
   the user no way to confirm). Read the tool's text to the user as is; nothing was written.
2. **status** — call `action: "status"` when the user asks how it is going or says they clicked.
   It answers a phase: `scanning`, `words_shown`, `confirming`, `done`, `failed`, `cancelled`,
   `expired`. Relay it in a sentence.

## What you must never do

- You have **no confirm and no cancel action** and cannot finish or stop an enrollment. Never ask the
  user to tell you the words, never ask them to say "yes" to you, and never claim the enrollment
  finished unless `status` says `done`.
- Never retype or describe the QR contents, the `ademu://` link, or the safety words. The plugin
  delivers them; you only point at them.
- If the user says the words differ, tell them to click **No** (the enrollment also expires by itself
  after three minutes). Nothing is written unless the user clicked Yes.

## Where the user acts

- **TUI, web UI, Control UI on the gateway machine:** the enrollment page opens in the browser (or the
  user opens the URL you pasted). The QR image also shows inline where the client renders images.
- **Telegram, Slack, Discord:** the plugin sends the QR + link, then the words with Yes/No buttons,
  into this conversation. Only the person who started the enrollment can click them (a quoted reply
  "yes"/"no" to that message works as well).
- **WhatsApp, Signal, Matrix, Mattermost, Google Chat:** the plugin sends the QR + link, then the words;
  the user **replies to the words message** (quotes it) with "yes" or "no". A plain "yes" typed in the
  chat is NOT a decision — it reaches you like any message; if that happens, tell the user to reply to
  the words message itself. Never treat such a message as consent.
- **Other channels (iMessage, IRC, Teams, LINE, SMS, …):** the plugin sends the QR + link and, after the
  scan, the words with a link to the enrollment page — only when the administrator set
  `channels.ademu.enrollmentPage.baseUrl` so the page is reachable from the phone. Otherwise `start`
  refuses and names the terminal wizard and that setting; relay that as is.

## Vocabulary

Say **enroll**, **enrollment**, **connect**. Do not describe the ceremony with the other
common linking word; Ademú uses that word for something else.

## What the QR and the words are

The QR carries a one-time enrollment key; scanning it lets the phone verify the agent device.
The four words are a safety check derived on both sides so a tampered connection would show
different words on the phone than on the page or in the conversation. A mismatch means: click No.

## If the device host is not available

The tool may answer that the Ademú device host (the `adc` daemon) could not start. Do not try to
install anything yourself. Tell the user what the tool said (usually: check
`channels.ademu.server` or the daemon log path it names) and stop.
