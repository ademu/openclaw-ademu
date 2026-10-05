# Changelog

All notable changes to `@ademu/openclaw-ademu` are recorded here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/); versions follow semver from 0.1.0.
Each release pins the exact `@ademu/adc-bin` (Ademú device daemon) version it was tested with.

## [Unreleased]

Tested with `@ademu/adc-bin` **0.3.0**.

### Changed

- **The plugin enrolls over the ADC enrollment socket and never opens the control socket** (ADC Phase
  3b Phase B, AdemuMLS#386; openclaw-ademu#12, folding #11). The daemon broker probes `daemon_info`
  over `adc-enroll.sock`; the ceremony (QR → words → confirm → one mint) runs on that socket, pinned to
  the device it created; the runtime keeps to the session socket. Owned daemons are spawned with
  `ADC_ENROLL_SOCKET_PATH` (six env vars) and stopped by verified-pid SIGTERM → SIGKILL — the control
  `shutdown` op is gone. Requires `@ademu/adc-control` ^0.2.0 and `@ademu/adc-client` ^0.2.0; a device
  host from before the enrollment socket that the plugin started is replaced through the ownership fence
  at the next gateway start.
- **Hardened hosts.** With nothing configured and a system-wide `adc` installed (a root-owned
  `/etc/adc/config.toml` and `/run/adc/adc-enroll.sock`), the plugin attaches to it — zero spawns, zero
  ownership claims — and enrolls over its enrollment socket. A permission refusal (`PrivilegeError`) is
  never read as "no daemon": the wizard and `ademu_enroll` print the operator ceremony for this host
  (`sudo adc --system agent add` → scan + confirm → `token mint` → paste into the token door). At user
  scope (an explicitly configured daemon) the runtime reports `blocked` instead of restarting; on a
  detected system install a gated enrollment socket does not touch a running account — the runtime
  needs only the session socket, so it attaches and logs the refusal. New config key: `enrollSocketPath`
  (root and per account) for a user-scope daemon whose enrollment socket is not under its data dir; it
  may never name the control or session socket (a config error), and one enrollment socket may not be
  shared by two data dirs. A bundled daemon older than adc 0.5.0 is refused before any spawn (typed,
  `blocked`) instead of leaving `stale` rows behind.
- **An account stays on the device host that enrolled it.** Both enrollment doors record the scope they
  enrolled at (`daemonScope`: `user` | `system`, per account, never at the root); resolution honours it
  after any explicit `dataDir`/`socketPath`/`enrollSocketPath` and before the system-install detector.
  A system install added later no longer moves a user-scope account onto a daemon that does not know
  its token (the old symptom: "token rejected (revoked or rotated)" and an orphaned private daemon), and
  a system-scope account whose daemon is down — or not up yet at boot — no longer starts a private one.
  A user-scope identity held in place by an explicit key or the recorded scope is never spawned beside a
  system install: `DaemonScopeError` (`blocked`) names the keys to remove, or says the agent was enrolled
  on this user's own device host, and to enroll it again — the doors ignore the recorded scope, so a
  re-enrollment lands where the host points now. A daemon still running at those paths is attached as
  before and is not upgraded (a reachable one is kept on its version; a pre-0.5.0 one is refused
  without being stopped); a lost ownership record over the plugin's own data dir is refused the same
  way instead of retrying forever. Accounts enrolled before the key keep the detector rule.
- **Upgrades are forward only, and an existing device never gets an empty daemon.** A rolled-back plugin
  keeps a running daemon newer than its bundled adc, and refuses to start its older adc on data a newer
  one last ran on (adc cannot open migrated data) with a message to update the plugin. A configured
  account or a pasted token whose data dir is missing or empty is refused (`blocked`, naming the dir)
  instead of getting a fresh, empty daemon that rejects the token. "Refused this user" now says to log
  in again and restart the gateway after the user is added to the device host's group.
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
  --system …` on a system install, `ADC_DATA_DIR=… ADC_SOCKET_PATH=… adc …` at user scope (the CLI's
  own socket ladder must not pick another daemon) — with paths and names single-quoted for the shell.

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
  address has no page to show: `start` refuses before creating a device and names the wizard. A browser
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

- The **enrollment page**: a browser page served on the gateway itself (`/plugins/ademu/enroll/<token>`)
  that shows the QR, then the four safety words with **Yes — the words match** and **No — they differ**.
  The tool opens it in the gateway machine's browser, so a TUI user (no image rendering there) still
  only asks, scans, and clicks. The route answers loopback clients only.

### Fixed

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
