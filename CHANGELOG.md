# Changelog

All notable changes to `@ademu/openclaw-ademu` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver from 0.1.0.
Each release names the minimum adc (the installed Ademú device host) it needs; since AdemuMLS #712 the
plugin bundles no daemon. Releases up to 0.1.0 pinned the exact `@ademu/adc-bin` they were tested with.

## [Unreleased]

Requires adc ≥ **0.6.0** (the installed device host; the plugin bundles none).

### Removed

- **The bundled device host** (AdemuMLS #712, `DECISIONS.md` §7.5). The plugin no longer depends on
  `@ademu/adc-bin` and never spawns, stops, kills or upgrades an adc daemon: the ownership broker,
  its SQLite tables (`daemon_ownership`, `daemon_holders` — an older database keeps them, unread), the
  shutdown fence, the plugin-driven upgrade and the legacy-daemon replacement are gone, with the
  plugin-owned data dir `~/.openclaw/ademu/adc`. No migration: agents enrolled on that data dir must be
  enrolled again (or pointed at it with `dataDir`, attached as long as something serves it).

### Deprecated

- `channels.ademu.server` is accepted and ignored (logged once): the installed device host's own
  config (`~/.config/adc/config.toml`) names the Ademú servers. It will be removed in a later release.

### Changed

- **The plugin attaches to the installed adc service** (AdemuMLS #712). By default it uses the
  installed user service — the data dir from the service's unit (`--data-dir`), all three sockets
  under it — or a system-wide install (Linux and, with clients 0.3.0, macOS). The runtime probes the
  enrollment socket once and attaches, taking a reachable daemon's reported session socket as the
  authority; it never starts a service. While nothing answers, the account is `recovering` with the
  reason (not installed as a service / disabled / not running / the system device host is down) and
  checks again in place (2 s, doubling to every 30 s) — it comes back once adc answers, however long
  that takes, without spending the gateway's ten restart attempts. An enrollment (wizard or `ademu_enroll`) may ask the system to start the
  INSTALLED user service (`launchctl kickstart` / `systemctl --user start`, never a spawn) and waits up
  to 20 s; it never starts anything for a configured path or a system install. A device host older
  than adc 0.6.0, or one without the enrollment socket, is refused as too old. Requires
  `@ademu/adc-control` and `@ademu/adc-client` ^0.3.0. The operator's commands use a bare `adc` for
  the installed service.

- **The plugin enrolls over the ADC enrollment socket and never opens the control socket** (ADC Phase
  3b Phase B, AdemuMLS#386; openclaw-ademu#12, folding #11). The daemon broker probes `daemon_info`
  over `adc-enroll.sock`; the ceremony (QR → words → confirm → one mint) runs on that socket, pinned to
  the device it created; the runtime keeps to the session socket.
- **Hardened hosts.** With nothing configured and a system-wide `adc` installed (a root-owned
  `/etc/adc/config.toml` and `/run/adc/adc-enroll.sock`), the plugin attaches to it and enrolls over its
  enrollment socket. A permission refusal (`PrivilegeError`) is
  never read as "no daemon": the wizard and `ademu_enroll` print the operator ceremony for this host
  (`sudo adc --system agent add` → scan + confirm → `token mint` → paste into the token door). A gated
  enrollment socket does not touch a running account — the runtime needs only the session socket, so
  it attaches and logs the refusal. New config key: `enrollSocketPath`
  (root and per account) for a user-scope daemon whose enrollment socket is not under its data dir; it
  may never name the control or session socket (a config error), and one enrollment socket may not be
  shared by two data dirs.
- **An account stays on the device host that enrolled it.** Both enrollment doors record the scope they
  enrolled at (`daemonScope`: `user` | `system`, per account, never at the root); resolution honours it
  after any explicit `dataDir`/`socketPath`/`enrollSocketPath` and before the system-install detector.
  A system install added later no longer moves a user-scope account onto a daemon that does not know
  its token (the old symptom: "token rejected (revoked or rotated)" and an orphaned private daemon), and
  a system-scope account whose daemon is down — or not up yet at boot — waits for it. The doors ignore
  the recorded scope, so a re-enrollment lands where the host points now. Accounts enrolled before the
  key keep the detector rule.
- **"I have a device token" replaces "Connect an already-enrolled agent".** The wizard asks the mode
  first; the token door takes an operator-minted token (masked input), needs no enrollment connection,
  checks the token over the session socket (`get_self`) and writes the account. `list_devices`,
  `device_status` and the replace-token consent are gone.
- **Mint dispositions.** `daemon_info` is read before the mint (the first mint closes the enrollment
  connection); a mint whose reply was lost, or whose label is already taken, is never retried with
  `replace` — the enrollment ends as `mint_lost` and names the fresh-label command; a configuration
  write that fails after a successful mint names the label to revoke (the chat door ends as
  `commit_failed`, shown on the page too; a device already attached after the mint is terminal as well);
  a full enrollment budget (`enroll_quota`) and an absent or silent enrollment socket are refused with
  the operator ceremony. Every operator command is composed from the daemon identity — `sudo adc
  --system …` on a system install, a bare `adc …` for the installed user service, `ADC_DATA_DIR=…
  ADC_SOCKET_PATH=… adc …` for an explicitly configured device host — with paths and names
  single-quoted for the shell.

- Typing is a pulse (AdemuMLS#621): the daemon relays each keepalive tick as at most one typing frame and
  no longer resends on its own, so the indicator clears ~3 s after the reply instead of staying lit
  forever (the daemon's resend loop was armed by every reply and never disarmed). `typingKeepaliveMs`
  is clamped to 2500 ms at runtime (the schema still accepts 500–10000).
- No typing during heartbeat runs: `heartbeat.sendTyping` is gone. A heartbeat that produces a message
  still delivers it; one that ends in `NO_REPLY` shows nothing.
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
- **The model never holds the page's address.** The enrollment page URL carries the token that
  authorises `/state`, `/confirm` and `/cancel`, so it now reaches exactly one place: the browser the
  plugin opens. `start` no longer returns the URL, the QR image or the `ademu://` link — its result says
  the page opened and nothing else. If no browser ever fetched the page, `status` opens it again itself
  (after a 5 s grace) instead of handing the model a link to relay. A gateway bound to a non-loopback
  address, or one that does not actually listen on loopback (`bind: "tailnet"` puts it on the
  Tailscale IP; checked with a connect to the page's origin), has no page to show: `start` refuses
  before creating a device and names the wizard. A browser
  launcher that cannot spawn is a failed start: the lease is disposed, nothing is written, and the
  wizard is named. Removed with this: `channels.ademu.enrollmentPage.autoOpen` and
  `channels.ademu.enrollmentPage.baseUrl`, the `gateway.publicOrigin` fallback, and the remote-client
  exception in the route — loopback clients only, with no setting that widens it.
- **`start` never ends a live ceremony.** It used to dispose the conversation's in-progress enrollment
  and begin a new one, which made it a cancel action in disguise for a model that has none. Now a `start`
  while one is live creates nothing and answers as `status` does (re-opening the page if no browser
  showed it); only the human ends a ceremony — **Cancel this enrollment** on the page's scan screen (new),
  **No — they differ** on the words screen, or the three-minute expiry. A fresh `start` is possible once
  the previous ceremony is done, failed, cancelled or expired.

### Added

- **Messages that are not text are described to the agent** (openclaw-ademu #22, AdemuMLS #440). A file
  (photo, video, voice note, file) or a message of a kind the plugin does not handle reaches the agent as
  a turn whose text names each file — kind, name, size — before the caption, instead of a caption-only
  or empty turn. Such a message is never a command; it is acked at adoption like text, and ingress never
  waits for a file.
- **`ademu_get_media`: the agent opens a file someone sent** (openclaw-ademu #22, AdemuMLS #440). With an
  adc that serves files (`get_blob`), each file's line names the call that opens it. A photo comes back
  as an image; any other file is saved under OpenClaw's media store and its path returned. The tool
  answers at once — a file still downloading says so, a failed download is queued again — and opens only
  files from the conversation the agent is answering. Needs `@ademu/adc-client` 0.6.0 (the first published client with `get_blob`).
  - A file above the new `mediaMaxOpenMb` plugin setting (default 50 MiB) is refused without being read:
    the file is held in the gateway's memory while it is saved.
  - Opening the same file again reuses the copy already saved instead of writing another one.
  - The tool stops waiting the moment the turn is aborted.
  - A photo that does not decode comes back as its saved path, and a failed download whose message was
    deleted before the re-queue answers "no such file".
  - Only a file with the daemon's own position is named to the tool; the plugin never guesses one from
    the file's order.
  - When the tool is offered, the file lines also tell an agent that doesn't have it to say it can't open
    files instead of calling it. At startup the plugin warns once if `tools` (or an agent's `tools`)
    plainly keeps the tool from agents: a `deny` naming it, an `allow` without it, or the `minimal`
    profile without an `alsoAllow`.
- The **enrollment page**: a browser page served on the gateway itself (`/plugins/ademu/enroll/<token>`)
  that shows the QR, then the four safety words with **Yes — the words match** and **No — they differ**.
  The tool opens it in the gateway machine's browser, so a TUI user (no image rendering there) still
  only asks, scans, and clicks. The route answers local clients only: a loopback peer with a loopback
  `Host` and no forwarding headers (a local reverse proxy or a DNS-rebinding page gets 404). A live
  token's poll and confirm budget is its own, so requests without the token cannot starve the page.

### Fixed

- **A sender can no longer forge OpenClaw runtime context.** Message text, captions, filenames, display
  names and usernames reach OpenClaw with its `<<<BEGIN_/END_OPENCLAW_INTERNAL_CONTEXT>>>` delimiters
  escaped. OpenClaw before 2026.9.3 did not escape inbound text and lifted such blocks into hidden
  runtime context (openclaw/openclaw#140404).
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
