# @ademu/openclaw-ademu

The **Ademú** channel for [OpenClaw](https://openclaw.ai): enroll an OpenClaw agent as a device on
Ademú (end-to-end encrypted messaging) and talk to it from your phone. The plugin bundles the Ademú
device host (the `adc` daemon) so there is nothing else to install.

- Two ways to enroll: the `openclaw channels add --channel ademu` wizard, or telling your agent
  "I want to talk to you on Ademú" (an owner-only chat tool walks you through it).
- The agent then lives in Ademú conversations: owner-only direct chats, rooms where it answers when
  addressed, a typing indicator while it composes, replies encrypted before they leave the machine.
- Ticks on your phone: **gray** = the device host received the message; **green** (Ademú labels it
  "read") = *OpenClaw committed to handling it*, before the model runs. It is not an "answered" signal.

Minimum host: **OpenClaw ≥ 2026.8.1** (tested with 2026.9.1). Node `>=22.22.3 <23`, `>=24.15.0 <25`
or `>=25.9.0` (OpenClaw's own range). macOS and
Linux (Windows is not supported yet — the channel reports `blocked` there).

## Install

Until the package is published to npm, install from a packed tarball:

```sh
git clone https://github.com/ademu/openclaw-ademu && cd openclaw-ademu
npm ci && npm run build
archive="$(npm pack --silent)"
openclaw plugins install "npm-pack:./$archive" --accept-capabilities
openclaw gateway restart
```

Later: `openclaw plugins install @ademu/openclaw-ademu` (or `ademu/openclaw-ademu` on ClawHub).

The bundled device host is `@ademu/adc-bin` (exact version pinned per release; see
[CHANGELOG](./CHANGELOG.md)). If your platform has no prebuilt binary, the plugin tells you so and
does not try to install anything itself; you can point it at a running `adc` daemon instead (below).

## Enroll an agent

**The requirement both doors must meet (non-negotiable):** to enroll an OpenClaw agent on Ademú the
user does exactly three things — ask the agent to connect to Ademú (or run the wizard command), scan
the QR shown by the agent device with the Ademú app, and confirm that the four safety words match.
Nothing else: no commands to type, no links to copy, no files to open, no extra steps. Where a
surface cannot show the QR itself (OpenClaw's TUI renders no images), the plugin puts the QR and the
words in front of the user on its own — the **enrollment page** in a browser, or messages with Yes / No
buttons pushed into the chat (see door two, and its table of where this works).

### Door one — the wizard (terminal)

```sh
openclaw channels add --channel ademu
```

1. The wizard starts the Ademú device host (in `~/.openclaw/ademu/adc` by default) and shows a QR.
2. On your phone: Ademú → your profile → **Agents → Add** → scan.
3. Your phone and the terminal both show **four safety words**. Confirm they match. (If they do
   not, say no — nothing is enrolled.)
4. The wizard asks whether to make your Ademú account an OpenClaw *owner*, so owner-only commands
   work from your phone. Say no if the phone belongs to someone other than you.
5. Done: the account is written to `channels.ademu.accounts.<id>` and the channel starts.

### Door two — from chat

Tell your agent (from any chat where you are the owner):

> I want to talk to you on Ademú.

The agent calls the `ademu_enroll` tool, which has exactly two actions, **start** and **status**. The
agent can neither confirm nor cancel an enrollment: the plugin puts the QR, the link, the four safety
words and a **Yes / No** choice in front of you itself, and you decide. What you see depends on where
you are talking from:

- **TUI, web UI or Control UI on the gateway machine:** the **enrollment page** opens in your browser
  (a page served by the plugin on the gateway itself, `/plugins/ademu/enroll/<token>`). It shows the QR,
  then the four words with **Yes — the words match** and **No — they differ**. The web UI also renders
  the QR inline.
- **Telegram, Slack, Discord:** the plugin sends the QR image with the exact `ademu://` link into the
  conversation, then — once your phone has scanned — the four words with Yes / No buttons. Only the
  person who started the enrollment can press them. Replying to that message with "yes" or "no" works
  too.
- **WhatsApp, Signal, Matrix, Mattermost, Google Chat:** same, without buttons — you **reply to the
  words message** (quote it) with `yes` or `no`. Only a quoted reply counts: a plain "yes" typed in the
  chat is an ordinary message for the agent, so nothing else you say during the enrollment changes
  meaning. Only the person who started the enrollment is heard.
- **Any other channel:** the plugin sends the QR + link and later the words with a link to the
  enrollment page — **only if** `channels.ademu.enrollmentPage.baseUrl` (or `gateway.publicOrigin`)
  makes the page reachable from your phone's browser. Otherwise `start` refuses before creating anything
  and names the terminal wizard and that setting.

Either way your actions are the same three: ask, scan (or tap the link on the phone that runs Ademú),
and say yes after comparing the words — by clicking, tapping, or replying to the words message. Nothing
is written unless you did; a No, or three minutes of silence, ends the ceremony with nothing written. The
words never pass through the model, and a model cannot say yes for you.

#### Where it works, and where it does not

| You are on | QR / link | Words | Your Yes / No | Works? |
|---|---|---|---|---|
| TUI, web UI, Control UI on the gateway machine | page (auto-opens) + inline in the web UI | page | page buttons | yes |
| TUI over SSH / remote web UI, no `enrollmentPage.baseUrl` | page URL printed, but unreachable from your browser | — | — | **no** — set `enrollmentPage.baseUrl` (or `gateway.publicOrigin`, or tunnel the gateway port) |
| Telegram, Slack, Discord | pushed into the chat | pushed | **buttons**, or a quoted reply `yes` / `no` (starter only) | yes |
| WhatsApp, Signal, Matrix, Mattermost, Google Chat | pushed into the chat | pushed | **quoted reply** `yes` / `no` to the words message (starter only) | yes |
| iMessage, IRC, Nextcloud Talk, Feishu, Buzz, Tlon, ClickClack, MS Teams | pushed into the chat | pushed + page link | page only | **only with** `enrollmentPage.baseUrl` / `publicOrigin` — their inbound quoted-message id is unverified, so the reply lane stays off until a live check; otherwise `start` refuses |
| LINE, SMS, Nostr, Synology Chat, Twitch, Zalo, A2A, Raft, any other channel | pushed into the chat | pushed + page link | page only | **only with** `enrollmentPage.baseUrl` / `publicOrigin` (no quoting support); otherwise `start` refuses |
| Phone only, any channel | the QR cannot be scanned from the same phone — tap the `ademu://` link | | | depends on the channel making a custom-scheme link tappable (Telegram does not); otherwise scan from a second device or use the page link |
| A group chat on a button channel | pushed to the group | pushed to the group | only the starter's click counts | yes, but everyone in the group sees the words |

Settings: `channels.ademu.enrollmentPage.autoOpen` (default true) opens the page in the gateway
machine's browser when its URL is loopback; `channels.ademu.enrollmentPage.baseUrl` is the
browser-facing origin of the gateway (put it behind TLS first) and also allows non-loopback access to
the page. The page URL is then a bearer link; the four-word comparison against your phone remains the
real check.

### Reconnecting an already-enrolled agent

If you reinstalled the plugin, rotated the token, or lost the config, the device is still enrolled on
Ademú. Run `openclaw channels add --channel ademu` and pick **Connect an already-enrolled agent**:
it issues a fresh device token and writes the account again. (There is no `channels login` path for
Ademú; this is it.)

## Living with it

- **Direct chats:** only the owner (the Ademú account that enrolled the agent) is heard; anyone
  else's DM is dropped before the model sees it.
- **Rooms:** the device receives all room traffic. By default a message that does not address the
  agent is acknowledged and filtered before the model ever sees it (set
  `channels.ademu.groups.<conversationId>.requireMention: false` to let every message through); the agent answers when addressed by name, by an alias from
  `plugins.entries.ademu.config.mentionAliases`, or by the owner (always heard). Per-room settings
  live under `channels.ademu.groups.<conversationId>` (`requireMention`, `toolsBySender`, …).
- **Sending proactively:** the `message` tool with `channel: "ademu"` and a conversation id
  (`ademu:<uuid>` or the bare UUID). Reactions: `action: "react"`.
- **Multiple agents:** one account per agent under `channels.ademu.accounts`, each routed to an
  OpenClaw agent by a `bindings` entry (`channel: "ademu"`, `accountId`). The wizard asks which agent
  to route to; enrolling from chat routes the account to the agent you are talking to, and refuses
  (writing nothing) when that conversation names no configured agent or the account id is already
  routed to another agent. `openclaw channels remove` deletes the account's binding with the account.
  Without a binding, a multi-agent install refuses the account's messages (`agents.ownership: "explicit"`)
  or sends them to the default agent.

## Configuration

```jsonc
{
  "channels": {
    "ademu": {
      "enabled": true,
      // where the bundled device host keeps its state (default: <state dir>/ademu/adc)
      "dataDir": "~/.openclaw/ademu/adc",
      // Ademú servers (defaults = production)
      "server": { "restBaseUrl": "https://api.ademu.com", "wsUrl": "wss://gateway.ademu.com/v1/ws" },
      // the browser enrollment page (door two): open it on the gateway machine automatically (default true);
      // baseUrl = browser-facing origin when the gateway is remote (also allows non-loopback access)
      "enrollmentPage": { "autoOpen": true, "baseUrl": "https://gw.example.com" },
      "accounts": {
        "iris": {
          "agentName": "Iris",
          "deviceId": "…", "agentUserId": "…", "ownerUserId": "…",
          "token": "adc1_…"            // or a SecretRef: { "source": "env", "provider": "default", "id": "ADEMU_TOKEN" }
        }
      }
    }
  },
  "plugins": { "entries": { "ademu": { "config": { "typingKeepaliveMs": 2000, "mentionAliases": ["iris"] } } } }
}
```

**Using your own `adc` daemon** (an operator install, not the bundled one): set `dataDir` and
`socketPath` to its paths. The plugin then runs in *foreign* mode: it attaches to that daemon but
never starts, stops, or upgrades it.

**Owner authority:** enrollment adds `ademu:<ownerUserId>` to the global `commands.ownerAllowFrom`
(if you said yes). Removing the account (`openclaw channels remove`) or logging it out removes that
entry again when no other Ademú account shares the owner.

## Uninstall

`openclaw plugins uninstall ademu` removes the plugin and its `channels.ademu` config. The device
stays enrolled on Ademú and its data stays in the data dir; the token stays valid until you revoke it
(`adc token revoke` against that data dir). Reinstall and use *Connect an already-enrolled agent* to
come back.

## Troubleshooting

- `openclaw plugins inspect ademu --runtime` — is the plugin loaded, channel + tool registered?
- `openclaw channels status` — account state. `blocked` means something you must fix (token
  revoked → reconnect; device not enrolled → finish on the phone; another process attached to the
  device → stop it). `recovering` means the plugin is retrying by itself.
- The device host log: `<dataDir>/daemon.log`; `adc doctor` and `adc status` (with `ADC_DATA_DIR` set
  to the plugin's data dir) speak for the daemon.
- The plugin never logs tokens, QR payloads, safety words, or message bodies.

## Development

```sh
npm ci
npm run build && npm test          # tsc + vitest (unit, contract proofs, gates)
bash dev/privacy-audit.sh          # log call-site privacy scan
npm run ci:acceptance              # headless install into a throwaway OpenClaw state dir (needs openclaw on PATH)
```

Design record: [`docs/design/2026-09-openclaw-ademu-1.md`](./docs/design/2026-09-openclaw-ademu-1.md).
Compat floor derivation: [`docs/design/compat-floor.md`](./docs/design/compat-floor.md).

## License

MIT
