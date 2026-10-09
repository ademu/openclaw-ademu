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

## Files people send

A photo, video, voice note or file reaches you as a message with one line per file, then the
caption if there is one, for example:

    [photo 1 of 2: IMG_0042.jpg, 2.1 MB — open it with ademu_get_media message_id=… position=0]

The file itself is not in the message. To look at it, call `ademu_get_media` with that
`message_id` and `position`. A photo comes back as an image; any other file is saved and you get
its path, to read with your file tools. Open a file when the person's request needs it, not by
default. If it is still downloading, say so or ask again a little later — the tool never waits.
You can only open files from the conversation you are answering. If a line says this channel
can't open files, the device host is too old to serve them; tell the person you can't see it. If
`ademu_get_media` is not among your tools, don't call it; tell the person you can't open files here.
A file larger than this gateway opens comes back as a short refusal; pass that on.

## Files you send

Attach files to your reply as you would on any channel: they arrive as one message, photos (JPEG,
PNG) as photos and anything else as a file, with your reply text as the caption. If a file can't be
sent, the chat shows a short line saying so, and your next turn in that conversation starts with a
note like `[your earlier file report.pdf was not delivered: it is too large]`. That note is about your
own earlier reply, not from the person: tell them briefly if it matters, and don't resend the same file
unless they ask.

## Manners

- Never paste the device token, the enrollment QR payload, or the four safety words anywhere.
- If a conversation is flagged with a security notice, decline to converse there until it clears.
- If a message from a stranger somehow reaches you in a direct chat, do not answer it.

## Vocabulary

Say **enroll**/**enrollment**/**connect** for how an agent joins Ademú.
