# @ademu/openclaw-ademu

The **Ademú** channel for [OpenClaw](https://openclaw.ai): enroll an OpenClaw agent as a device on
Ademú (end-to-end encrypted messaging) and talk to it from your phone. The plugin bundles the Ademú
device host (the `adc` daemon) so there is nothing else to install.

- Two ways to enroll: the `openclaw channels add --channel ademu` wizard, or telling your agent
  "I want to talk to you on Ademú" (an owner-only chat tool walks you through it).
- The agent then lives in Ademú conversations: owner-only direct chats, rooms where it answers when
  addressed, a typing indicator while it composes, replies encrypted before they leave the machine.
- A **blue tick** on your phone means the device host received the message *and OpenClaw committed
  to handling it* — before the model runs. It is not a "read" or "answered" signal.

Minimum host: **OpenClaw ≥ 2026.8.1** (tested with 2026.9.1). Node 22.22+ or 24.15+. macOS and
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

Tell your agent (from the web UI or any channel where you are the owner):

> I want to talk to you on Ademú.

The agent uses the `ademu_enroll` tool: it shows the QR, waits for your scan, reads you the four
words, and — only after you say they match — finishes enrollment and writes the config. The tool is
invisible to non-owners.

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
- **Multiple agents:** one account per agent under `channels.ademu.accounts`; route each to an
  OpenClaw agent with the usual `bindings` (`channel: "ademu"`, `accountId`).

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
