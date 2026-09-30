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
words in front of the user on its own — the **enrollment page** it opens in a browser on the gateway
machine (see door two). Both doors assume you are at the gateway machine.

### Door one — the wizard (terminal)

```sh
openclaw channels add --channel ademu
```

1. The wizard asks **Enroll a new agent** or **I have a device token** (see below). For a new agent it
   starts the Ademú device host (in `~/.openclaw/ademu/adc` by default — or attaches to this host's
   system-wide one, see *Hardened hosts*) and shows a QR.
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
words and a **Yes / No** choice in front of you itself, and you decide. Whatever chat you asked from,
the ceremony happens in one place:

- The **enrollment page** opens in your browser on the gateway machine (a page served by the plugin on
  the gateway itself, `/plugins/ademu/enroll/<token>`). It shows the QR, then the four words with
  **Yes — the words match** and **No — they differ**. The agent is told only that the page opened: it
  never receives the page's address, the QR or the words, so nothing it says can stand in for them. If
  no tab appeared, ask the agent how it is going — the plugin opens the page again.

Your actions are the same three as door one: ask, scan (or open the link on the phone that runs
Ademú), and click Yes after comparing the words. Nothing is written unless you did; **Cancel** before
scanning, **No** after, or three minutes of silence end the ceremony with nothing written. The words never
pass through the model, a model cannot say yes for you, and it cannot end a ceremony either — asking the
agent to start again while one is running only tells you where it stands.

#### Where it works, and where it does not

| You are on | QR / link | Words | Your Yes / No | Works? |
|---|---|---|---|---|
| TUI, web UI, Control UI on the gateway machine | page (auto-opens) + inline in the web UI | page | page buttons | yes |
| A chat channel (Telegram, WhatsApp, …) while sitting at the gateway machine | page (auto-opens on the gateway machine) | page | page buttons | yes |
| TUI over SSH, a remote web UI, or a chat channel away from the gateway machine | the page opens on the gateway machine, where you are not | — | — | **no** — run `openclaw channels add --channel ademu` on the gateway machine |
| A gateway bound to a non-loopback address, or a headless gateway with no browser | — | — | — | **no** — `start` refuses before creating anything and names the wizard |
| Phone only | the QR cannot be scanned from the same phone — open the `ademu://` link from the page | | | scan from a second device, or use the page's copy-link on the phone |

Pushing the QR, the words and Yes / No buttons into the chat itself (Telegram, Slack, Discord buttons;
quoted-reply decisions elsewhere) is not part of this release; that lane lives on a separate branch.

There are no settings for the page. Its URL is a bearer link that only the browser the plugin opens
ever receives; the route answers loopback clients only, and the four-word comparison against your phone
remains the real check.

### I have a device token (reconnecting an already-enrolled agent)

If you reinstalled the plugin, rotated the token, or lost the config, the device is still enrolled on
Ademú. Mint a token for it at the `adc` CLI and paste it into the wizard: run
`openclaw channels add --channel ademu`, pick **I have a device token**, paste. The plugin checks the
token against the device host's session socket (`get_self`), asks the owner question, and writes the
account again. (There is no `channels login` path for Ademú; this is it.)

```sh
# the bundled device host keeps its state in the plugin's data dir — tell the CLI where:
ADC_DATA_DIR=~/.openclaw/ademu/adc adc agent list
ADC_DATA_DIR=~/.openclaw/ademu/adc adc token mint <device_id> --label openclaw-<accountId>
# on a hardened host (system-wide adc): sudo adc --system token mint <device_id> --label openclaw-<accountId>
```

The token door needs no enrollment ceremony and no enrollment socket (a refusal there is ignored; the
session socket is the token's door): it is also the recovery path when an operator enrolled the agent
for you, or when the plugin could not finish a mint itself. One residual: the wizard hands the account
back to OpenClaw, which saves the configuration after the wizard has finished — if *that* save fails,
the token is still minted under the label `openclaw-<accountId>`; revoke it at the CLI
(`… token revoke <device_id> --label openclaw-<accountId>`) and run the wizard again.

### Hardened hosts (a system-wide `adc`)

On Linux an operator can run the device host as a system service (`sudo adc service install --system`:
a dedicated `adc` user, `/etc/adc/config.toml`, state in `/var/lib/adc`, the three sockets under
`/run/adc`). The plugin detects that install by itself (a root-owned `/etc/adc/config.toml` and the
enrollment socket `/run/adc/adc-enroll.sock`) whenever `channels.ademu` names no `dataDir`,
`socketPath` or `enrollSocketPath`, and then **attaches** to it: it never starts a device host of its
own beside the hardened one, never stops or upgrades it.

Enrollment still takes the same three actions. The plugin's ceremony runs over the daemon's
**enrollment socket** (`adc-enroll.sock`, world-connectable on a system install): it exposes only the
ceremony (create a device, show the QR, confirm the words, mint one token) and pins each connection to
the device it created; the owner's phone is the gate, and the daemon bounds unfinished ceremonies per
user and host-wide. The plugin never opens the control socket (`/run/adc/adc.sock`, root and group
`adc` only). `sudo adc --system agent list` shows which local user created each device (`creator_uid`).

When the plugin cannot run the ceremony — an operator group-gated the enrollment socket, the host's
enrollment budget is full, or the plugin was pointed at a data dir it may not use — it prints the
operator's path instead of a raw error:

```sh
sudo adc --system agent add "Iris"          # then scan the QR and confirm the words on the phone
sudo adc --system token mint <device_id> --label openclaw-iris
openclaw channels add --channel ademu        # → I have a device token → paste
```

Two recoveries the plugin names by command, because the enrollment socket mints at most one token per
device and closes the connection after it: a mint whose reply was lost (or whose label was taken) is
**not** retried — mint a fresh label at the CLI and paste it; a configuration write that failed after
the mint leaves that token orphaned — revoke it by label (`adc [--system] token revoke <device_id>
--label <label>`).

A device host from before the enrollment socket (adc < 0.5.0) that the plugin itself started is
replaced by the bundled one at the next gateway start (through the same ownership fence — also when a
wizard run had already marked it `stale`). If its recorded version is unknown the plugin leaves it
alone and reports `recovering`: stop it by hand (`ADC_DATA_DIR=<dataDir> adc daemon stop`, or
`kill <pid>`). The bundled daemon itself must be adc 0.5.0 or newer; an older bundle is refused
(`blocked`) rather than started.

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

**Using your own `adc` daemon** (a user-scope daemon you run yourself): set `dataDir` to its data
dir; add `socketPath` (its control socket) and `enrollSocketPath` (its enrollment socket) when they
are not under that dir — on Linux a zero-config daemon binds them under `$XDG_RUNTIME_DIR`. The
plugin then runs in *foreign* mode: it attaches to that daemon but never starts, stops, or upgrades
it. A system-wide install needs none of this (see *Hardened hosts*); naming any of the three keys
turns that detection off.

**Owner authority:** enrollment adds `ademu:<ownerUserId>` to the global `commands.ownerAllowFrom`
(if you said yes). Removing the account (`openclaw channels remove`) or logging it out removes that
entry again when no other Ademú account shares the owner.

## Uninstall

`openclaw plugins uninstall ademu` removes the plugin and its `channels.ademu` config. The device
stays enrolled on Ademú and its data stays in the data dir; the token stays valid until you revoke it
(`ADC_DATA_DIR=<dataDir> adc token revoke <device_id> --label openclaw-<accountId>`). Reinstall, mint
a token and use *I have a device token* to come back.

## Troubleshooting

- `openclaw plugins inspect ademu --runtime` — is the plugin loaded, channel + tool registered?
- `openclaw channels status` — account state. `blocked` means something you must fix (token
  revoked → reconnect; device not enrolled → finish on the phone; another process attached to the
  device → stop it). `recovering` means the plugin is retrying by itself.
- The device host log: `<dataDir>/daemon.log`; `adc doctor` and `adc status` (with `ADC_DATA_DIR` set
  to the plugin's data dir; `sudo adc --system doctor` on a hardened host) speak for the daemon. Doctor
  lists the three sockets — control, session, enrollment — with their modes; the plugin dials only the
  last two.
- `blocked` with "refused this user": the device host's enrollment socket denied the gateway's user
  (an operator's group-gated posture), or a system-wide `adc` is installed and `channels.ademu` points
  at a data dir the plugin may not run a device host in. Fix access, or use the token door.
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
