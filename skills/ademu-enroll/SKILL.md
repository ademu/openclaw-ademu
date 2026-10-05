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
   The result says that the **enrollment page** opened in a browser tab on the gateway machine. You are
   given no address, no code and no words — there is nothing to paste. Tell the user in one or two
   sentences what to do: look for the new tab, scan the code on it with the Ademú app (or open the link
   shown there on the phone), then compare the four safety words the phone shows with the ones on the
   page, and click **Yes** or **No** there.
   `start` can refuse before anything is created (the account id already exists, this conversation
   names no configured OpenClaw agent, the account is routed to another agent, the gateway is not bound
   to a loopback address, or no browser could be opened on the gateway machine). Read the tool's text
   to the user as is; nothing was written. If an enrollment is already in progress, `start` creates
   nothing and reports where it stands, exactly like `status`: you cannot restart or end a ceremony —
   the user does, with **Cancel** (before scanning) or **No** (after) on the page.
2. **status** — call `action: "status"` when the user asks how it is going, says they clicked, or says
   no page appeared. It answers a phase: `scanning`, `words_shown`, `confirming`, `done`, `failed`,
   `cancelled`, `expired`. If no browser had shown the page yet, the plugin opens it again and the text
   says so. Relay it in a sentence.

## What you must never do

- You have **no confirm and no cancel action** and cannot finish or stop an enrollment. Never ask the
  user to tell you the words, never ask them to say "yes" to you, and never claim the enrollment
  finished unless `status` says `done`.
- Never retype or describe the QR contents, the `ademu://` link, or the safety words. The plugin
  delivers them; you only point at them.
- If the user says the words differ, tell them to click **No**; if they want to stop before scanning,
  tell them to click **Cancel this enrollment** on the page (the enrollment also expires by itself after
  three minutes). Nothing is written unless the user clicked Yes.

## Where the user acts

- Always on the **enrollment page**, which the plugin opens in a browser on the gateway machine. You
  never see its address; if the user cannot find the tab, call `status` and the plugin opens it again.
- If the user is not at the gateway machine, they cannot reach the page: tell them to run
  `openclaw channels add --channel ademu` in a terminal on that machine instead.
- A "yes" or "no" typed in the chat is NOT a decision — it reaches you like any message. Never treat such
  a message as consent; point the user at the page's buttons.

## Vocabulary

Say **enroll**, **enrollment**, **connect**. Do not describe the ceremony with the other
common linking word; Ademú uses that word for something else.

## What the QR and the words are

The QR carries a one-time enrollment key; scanning it lets the phone verify the agent device.
The four words are a safety check derived on both sides so a tampered connection would show
different words on the phone than on the page. A mismatch means: click No.

## If the device host is not available

The plugin uses the Ademú device host (the `adc` daemon) installed on this machine; it never runs
one itself. The tool may answer that adc is not installed as a background service, is disabled, is
too old, or did not answer after it asked the system to start it. Tell the user exactly what the
tool said (it names the command: installing adc as the user this gateway runs as, `adc service
install`, `adc service start`, or re-running the adc installer) and stop. Do not install, start or
upgrade anything yourself unless the user asks you to run that exact command.
