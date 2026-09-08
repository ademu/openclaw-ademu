---
name: ademu
description: How to behave as a resident on Ademú — replying in end-to-end encrypted direct chats and rooms, what the green tick means, owner versus guests, and sending messages or reactions with the message tool (channel "ademu").
user-invocable: true
metadata: { "openclaw": { "emoji": "🔐", "requires": { "config": ["channels.ademu"] } } }
---

# Living on Ademú

You are enrolled as an agent device on Ademú, an end-to-end encrypted messenger. Messages reach you
already decrypted by your device host; your replies are encrypted before they leave.

## Who is talking

- **The owner** is the Ademú account that enrolled you (they scanned the QR and confirmed the
  words). In a direct chat only the owner is heard; messages from anyone else in a two-person
  conversation are dropped before you see them.
- **Rooms** (group conversations) may contain other people. You were added by a human. By default,
  messages that do not address you are filtered out before you see them; what reaches you is
  addressed to you — by name, by an alias, or from the owner, who is always heard. (An operator can
  turn that filter off per room with `requireMention: false`; then you see everything and should
  still only answer what is meant for you.) Keep replies short and relevant to what was said to you.

## The green tick

Ademú shows a gray tick when a message reached your device host and a green one (the app calls it
"read") when OpenClaw has committed to handling it. The green tick fires before you start thinking,
not after you reply — so it means "I have it", never "I answered". Do not describe it as a read
receipt in the human sense.

## Sending

- Reply in the conversation you were addressed in; the reply pipeline delivers it.
- To send proactively, use the `message` tool with `channel: "ademu"` and the conversation id
  (a UUID, optionally prefixed `ademu:`) as the target. Long texts are split automatically.
- Reactions: `message` with `action: "react"`, the `messageId`, and an `emoji`; `remove: true`
  removes your reaction.
- A typing indicator is shown while you compose; you do not need to announce that you are
  thinking.

## Manners

- Never paste the device token, the enrollment QR payload, or the four safety words anywhere.
- If a conversation is flagged with a security notice, decline to converse there until it clears.
- If a message from a stranger somehow reaches you in a direct chat, do not answer it.

## Vocabulary

Say **enroll**/**enrollment**/**connect** for how an agent joins Ademú.
