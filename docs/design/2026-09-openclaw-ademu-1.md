# OPENCLAW-ADEMU-1 — the Ademú channel plugin for OpenClaw

*Design record, written for strangers. Companion plan: `docs/superpowers/plans/2026-09-03-slice-openclaw-ademu-1.md`.
Compat-floor derivation: `compat-floor.md`. Status: **executing** (2026-09-04); the close-out section is
filled when the E2E legs run.*

## 1. What this is

Ademú is an end-to-end encrypted messenger. An **agent device** is an Ademú device whose "mind" is an
external program; the device's full E2EE client stack runs in the Ademú device host, the `adc` daemon,
and the mind drives it over a local socket. This plugin makes **OpenClaw** that mind: it bundles the
daemon (`@ademu/adc-bin`, exact version per release), enrolls an OpenClaw agent as a device through
Ademú's four-word ceremony, and then runs the device as a resident OpenClaw channel — messages in
(already decrypted by the daemon, with cryptographic sender identity), typing while the model composes,
replies out (encrypted before they leave the machine), reactions, blue ticks.

It is an **external** plugin (`@ademu/openclaw-ademu`, manifest id `ademu`), built only on OpenClaw's
public `openclaw/plugin-sdk/*` surfaces, against a pinned host (`openclaw@2026.9.1`) with a derived
compatibility floor (`>=2026.8.1`). Nothing in the daemon, the protocol, or the published `@ademu/*`
packages changed for this slice; every gap became a documented disposition instead.

## 2. Decisions (the ratified ones, in plain words)

**Decision 1 — the blue tick is a promise about ownership, not about a reply.** Ademú's read-receipt
weight ack (`ack`) is cumulative: acking sequence N acks everything before it. The plugin acks a message
only after OpenClaw has **committed its adoption** of that message — core's `onAdopted` callback, which
fires after the user turn is durably recorded and *before* the model runs. So a blue tick means "the
daemon retained this until OpenClaw took durable ownership", never "the agent answered". (Letter change
from the original "ack after durable admit" to "ack after adoption": see §3, Option B.)

**Decision 2 — say "enroll".** Every user-facing surface (wizard copy, tool description, skills, README,
channel blurb) says *enroll/enrollment/connect*. The other common word for linking a device is Ademú's
own word for something else; a vitest gate scans the copy for it and fails the build.

**Owner-only by construction.** In a direct chat only the **owner** — the Ademú account that scanned
the QR — is heard; anyone else's DM is dropped before the model sees it (DM policy `allowlist`,
`allowFrom = [ownerUserId]`, resolved at runtime through OpenClaw's `createChannelIngressResolver`).
Rooms are `open` because a human added the agent; by default the agent answers only when addressed
(name, alias, OpenClaw's own mention patterns; `groups.<id>.requireMention: false` lets every message
through) — the owner is always heard.

**Two doors, one ceremony.** `openclaw channels add --channel ademu` (wizard) and the owner-gated
`ademu_enroll` chat tool share one ceremony module: create device → QR → poll → four words → *human*
confirms → `confirm_words` with the **daemon's** words (never user- or model-typed) → wait for
`enrolled` → mint a device token labelled `openclaw-<accountId>` → read the identity facts from the
session's `get_self`. The token is returned exactly once and written straight into config.

**Instruct-only install.** If the bundled binary is missing for a platform, the plugin says so and
stops; it never downloads or installs anything on its own.

**Decision 7 — release channel.** The plugin pins `openclaw@2026.9.1` as its build host and tracks
`openclaw@beta` nightly (informational). Footnote, owner-ratified: the *derived* floor (2026.8.1)
exceeds OpenClaw's `extended-stable` line (2026.6.34); extended-stable users can install once that line
passes 2026.8.1. The README states the minimum host plainly.

## 3. The ingress design — Option B (owner decision, 2026-09-04)

**What we found.** OpenClaw ships a durable channel-ingress queue/monitor, but its factories
(`api.runtime.state.openChannelIngressQueue` and the other keyed/blob stores) throw for any plugin that
is not bundled or on OpenClaw's official-plugin catalog (`registry-runtime.ts`, present in every host in
our range). That fired the slice's one STOP rule; the owner chose **Option B**:

**The daemon is the durable store.** The ADC already provides a durable, replayable, cursor-addressed
stream deduplicated by `message_id`; buffering it again in a harness queue was double-buffering. The
plugin owns **one sequential event loop per account** over `client.events()`:

1. validate the frame (malformed payload with a valid `seq` → ack, log the class only; invalid `seq`
   → protocol violation, halt);
2. **watermark**: a persisted `{ deviceId, adoptedSeq }` per account (SQLite); a replayed
   `seq ≤ adoptedSeq` → ack without dispatch;
3. self-sent → ack; DM from a non-owner, or a room message that does not address the agent → ack
   *immediately after the gate decision* (rider R3);
4. otherwise dispatch through `api.runtime.channel.inbound.dispatch` with an **AdoptionTracker** bound
   via `bindIngressLifecycleToReplyOptions`. **`onAdopted` is the commit**: it writes the watermark
   (SQLite, `synchronous=FULL`) and only then resolves — core awaits it before model work — and the
   loop acks after the tracker settles.

**Riders.** R1: adoption is serialized per account (N+1 is not dispatched until N is adopted); model
runs proceed concurrently up to 4 in flight. R2: dedupe by watermark, not a ring. R3: the halt rule is
unchanged — any pre-adoption failure (dispatch rejects, `onAbandoned`, abort, a 5-minute stall
watchdog with `onDeferredHeartbeat` resets, a watermark write failure) halts the loop with no ack for N
or anything after, publishes `recovering` + `ingressUnavailable`, and rejects the account so the gateway
supervisor restarts it and the daemon replays from its cursor. R4: the declared receive ack policy is
the truthful `after_agent_dispatch` ("after the agent run is dispatched"), proven by
`verifyChannelMessageReceiveAckPolicyAdapterProofs`.

**Deferred handoff.** When core defers a turn (`onDeferred`), the dispatch promise's resolution is
ignored; only a later `onAdopted`, `onAbandoned`, abort, or the watchdog settles the tracker.

**Callback-free completions (residual R10, stated plainly).** A dispatch that resolves with neither
`onDeferred` nor `onAdopted` is classified by output evidence with the public
`hasVisibleInboundReplyDispatch`: `dispatched:false` → adopted-equivalent; visible output → adopted-
equivalent (re-running would duplicate output); zero output → **at-most-once**: commit + ack + a
`callback_free_completion` log. Retrying was rejected because OpenClaw's process-local 20-minute inbound
dedupe turns the replay into another zero-output completion and legitimately silent commands would
double their side effects. The recorded path to at-least-once is a terminal disposition on
`ChannelTurnResult` (Tier C ask) — a launch-hardening item, not a v1 blocker.

**Transcript guarantee, precisely.** For normally dispatched immediate turns core records the user turn
before `onAdopted`; for deferred followups adoption precedes the later transcript; pre-record adopted
skips (outbound-echo / bot-loop drops) adopt without a transcript — consumed, not recorded. What we rely
on is only "core has taken durable ownership of the message's disposition at adoption".

**Tier C note (for OpenClaw maintainers).** External plugins are gated from durable ingress by policy;
B is valid in both tiers. Two asks: a terminal disposition on `ChannelTurnResult`, and forwarding
`onSettled` (or a deferred-completion handle) through `bindIngressLifecycleToReplyOptions`.

## 4. The daemon — ownership, identity, lifecycle

**Identity.** A daemon is identified by the canonicalized pair `(dataDir, controlSocket)` (realpath of
the deepest existing ancestor + verbatim tail, because Ademú joins paths verbatim). Cross-axis
collisions across accounts (one data dir with two sockets, one socket for two data dirs) are a config
validation error that blocks `startAccount`. The **session** socket is what `daemon_info`
reports whenever a daemon is reachable — never re-derived then (a squatter on a derived path would
receive the bearer token); only an *unreachable* foreign acquisition keeps the deterministic configured
path, and its session connect then fails until the daemon answers.

**Default isolation (approval rider R2).** Default `dataDir` = `<OPENCLAW_STATE_DIR>/ademu/adc`,
control socket `<dataDir>/adc.sock`, session socket `<dataDir>/adc-session.sock`. Every owned spawn
receives `ADC_DATA_DIR`, `ADC_SOCKET_PATH`, `ADC_SESSION_SOCKET_PATH` (all three — the Linux
`$XDG_RUNTIME_DIR` rungs would otherwise collide with an operator daemon) plus `ADC_REST_BASE_URL` /
`ADC_WS_URL` from `channels.ademu.server` (defaults = Ademú production; **R11** — a fresh plugin data
dir has no `config.toml` and the daemon refuses to start without endpoints). An operator's own `adc`
(e.g. `~/.local/share/adc`) is reached only by explicit config.

**Durable ownership, two modes.** The ownership record is a row in the plugin's SQLite DB
(`daemon_ownership`, keyed by canonical data dir) with a **closed** state enum
`claimed | starting | pending-publication | bound | stopping | stopped | stale` and a generation counter
(compare-and-swap on every transition). *Owned* (a bound row whose live facts — `data_dir`,
`socket_path`, `session_socket_path`, `started_at_ms`, pid + pid start time, `adc daemon run` command
— all match): the plugin may spawn, stop, respawn, and upgrade. *Foreign* (no row, or facts that do not
match): **attach-only** — never spawn, never stop, never upgrade; on loss the status is `recovering`
while the client's reconnect loop probes. Losing the DB degrades an owned daemon to foreign — the safe
direction.

**Roles and the fence.** A terminal wizard runs in the CLI process, so in-memory refcounts cannot see
every user of a daemon; cross-process accounting lives in `daemon_holders` (heartbeat every 30 s, stale
after 90 s or a dead pid). Only the gateway runtime (`role: "runtime"`) may stop a daemon, and only
through an **atomic shutdown fence**: one transaction sweeps stale holders and, if none remain, CASes
`bound → stopping`; acquisitions fail while `stopping`. Setup leases (wizard, tool) may spawn but never
stop — an idle owned daemon is harmless and is adopted by the runtime later (`pending-publication →
bound` promotion by the runtime's acquire; a 1 h sweep for never-published ones, through the same
fence). Stop sequence: control `shutdown` op (the daemon's own verb; it is daemon-global, acceptable
only because an owned data dir hosts nothing but this plugin's devices) → SIGTERM → SIGKILL, hard-capped
at 2500 ms; still alive at the cap → `stale`.

**Signal divergence, recorded.** Signal's plugin owns its daemon unconditionally; we attach-if-running
(adc is single-instance per socket) and decide owned/foreign before ever calling `ensureDaemon`.

**Upgrade.** Bundled `@ademu/adc-bin` version ≠ the bound daemon's parsed leading semver
(`"0.2.4 (abc)"` → `0.2.4`; unparsable → never) → stop through the fence → respawn under a new
generation. Runtime role only.

## 5. The account lifecycle (`startAccount`)

`starting` → preflight (disabled → stopped; identity collision / Windows / not configured → `blocked`)
→ acquire a runtime lease → open the session (`connect({ takeover: true, reconnect: "auto" })`, then
**identity binding fails closed**: `hello.device_id === self.device_id === account.deviceId`, the agent
user ids agree, and the owner matches when configured) → warm the members cache → start the ingress
loop → `ready` → race `[abort, loop lifetime, lease loss]`.

**Outcome contract with the gateway supervisor.** Return normally for *abort* and for *blocked*
(user-actionable, a restart cannot fix it: token revoked/rotated, device not enrolled, displaced by
another mind, protocol violation, identity mismatch, unsupported platform). Throw for *restart*
(daemon lost, ingress halted, transient failures) so the supervisor re-runs the account. `blocked` is
sticky in OpenClaw until a gateway restart or an explicit ready patch, so it is used only for those
cases; everything else is `recovering`. Foreign daemons never reject on daemon loss.

**Cleanup under one absolute deadline (K3).** The host abandons a stop at 5 s; we finish in ≤ 4500 ms by
construction: stop the loop and abort only *un-adopted* turns (adopted ones inherit the lifecycle abort
signal into execution — we never abort those, they are already acked) → wait for adopted deliveries up
to `min(2000, remaining − 2500)` ms → close the session → release the lease within the reserved
2500 ms tail (awaited, never detached; a later acquire of the same identity awaits the release).
Recorded limitation: a gateway restart mid-turn can lose that turn's *reply*, never the message.

**Status vocabulary** is one closed table from error classes to patches; `lastError` is always our own
copy — never an error's `.message`/`.detail` (peer-controlled text).

## 6. Outbound and actions

`message` adapter: durable-final `text`, receive policy `after_agent_dispatch`. Texts are split at
**4000 characters** (`chunkTextForOutbound`; no daemon body cap exists — the ceiling is the 1 MiB
session line — 4000 is the conservative default); each chunk is one `send_text` reported through
`onDeliveryResult`; a failure after the first accepted chunk throws `createChannelPartialDeliveryError`
so core never re-sends delivered chunks. Replies go through the account's **live** session client (a
device has one seat); a registry keyed by accountId hands it to the adapter, and outbound without a
running account fails with a clear error. Targets are conversation ids (UUID), optionally `ademu:`-
prefixed, compared lowercase. Reactions: `message(action: "react")` → `send_reaction`; removal is the
empty emoji (Ademú's wire form). Typing: the reply pipeline's typing callbacks with a **2000 ms**
keepalive (approval rider R3; Ademú's receiver TTL is ~3 s) plus `heartbeat.sendTyping`.

## 7. Configuration, secrets, owner authority

- `channels.ademu` — root-level `dataDir`/`socketPath`/`server` inherited by accounts; `groups.<id>`
  (`requireMention`, `toolsBySender`, …); `accounts.<id>` with `agentName`, `deviceId`, `agentUserId`,
  `ownerUserId`, `token` (plain string by default — the wizard writes it — or a SecretRef;
  `uiHints` marks it sensitive). Schema built with `buildMultiAccountChannelSchema`, hybrid config
  adapter, `reload.configPrefixes = ["channels.ademu"]` (without it every write is a full gateway
  restart). Manifest `configSchema`: `typingKeepaliveMs` (500–10000, default 2000), `mentionAliases`.
- **R3 (owner-ratified): owner authority.** Enrollment writes the channel-scoped `ademu:<ownerUserId>`
  into the global `commands.ownerAllowFrom` — the enrolling human is a cryptographically bound identity
  who just proved root authority over the agent by scanning; not granting it would leave them unable to
  command the agent from the channel they enrolled it for. *Rider A:* the wizard asks with a default-yes
  confirm whose copy names the grant and the one "no" case ("Say no if the phone belongs to someone
  other than you"); the tool grants automatically (its initiator is owner-by-scope and confirmed the
  words from the same phone). *Rider B:* removing the account (`config.deleteAccount`) or logging it
  out (`gateway.logoutAccount`) prunes the entry when no other Ademú account shares that owner.
- No `auth.login`: OpenClaw's login path may not mutate channel config. Reconnecting an enrolled device
  is the wizard's "Connect an already-enrolled agent" (mints a new token under the same label; an
  existing label asks for explicit replace consent → `replace: true`).
- Windows: guarded before any socket resolver (`process.geteuid` is absent there) → `blocked`.

## 8. Privacy

Nothing secret-shaped reaches a log call-site: tokens, `.detail` (daemon debug text is peer-controlled
and non-enumerable on `ControlError`), `.raw` frames, QR payloads, safety words, message bodies. Logs
carry a closed allowlist of fields (`{ event, seq, accountId, errorClass, … }`). The QR is rendered
through `prompter.plain` (never `note`, which reflows at 80 columns; never `runtime.log`). Enforced by
`dev/privacy-audit.sh` (the monorepo scanner, extended with OpenClaw's structured logger forms and a
bait-tree self-test).

## 9. Verification dispositions (Gate 0 → execution)

| # | claim | disposition at execution |
|---|---|---|
| V1 | devDependency = latest | `2026.9.1` pinned (owner); the import gate dynamically imports every runtime symbol from the installed tarball |
| V2 | QR helper home | `api.runtime.media` has **no** QR renderers in 2026.9.1 → `media-runtime` (public, docs-deprecated barrel) is the live path; the one import-gate exception |
| V3 | DM allowlist for a runtime owner | `createChannelIngressResolver` with `allowFrom=[owner]`, decision-only resolve then `contextBinding`-bound resolve |
| V4 | `verified` identity | accepted by the resolver (`authentication: "verified"`, kind `stable-id`) |
| V5 | plugin-wired `toolsBySender` | refuted; users can set `channels.ademu.groups.<id>.toolsBySender` |
| V6 | secret registry | `createSimpleChannelSecretContract` (account-inheritance) + `resolveSecretInputString` inspect/strict |
| V7 | daemon body cap | none → chunk at 4000 |
| V8 | reactions | `actions.handleAction("react")` |
| V9 | typing hook | reply-pipeline `typing.keepaliveIntervalMs = 2000` |
| V10 | ack policy enum | `after_agent_dispatch`, proven |
| V11 | agent identity name | `agents.entries.<id>.identity.name` via `tryResolveDefaultAgentId` + `resolveAgentConfig` |
| V12 | `afterWrite` union | `{mode:"auto"}` + `reload.configPrefixes` |
| V13 | ClawHub dry-run | see close-out |
| V14 | headless acceptance | `scripts/ci-acceptance.sh` (`--force --accept-capabilities`, `inspect --runtime --json`, `doctor --json`, `skills list --json` with a symlink fallback) |
| V16 | Node range | `.node-version` 24.15.0; CI matrix 22.22.3 + 24.15.0 |
| V17/V29 | daemon lifecycle / prod daemon on the dev Mac | owned/foreign modes, default isolation |
| V18 | `terminalDisconnect` sticky | `blocked` only for user-actionable cases |
| V19 | owner gate for the tool | host-computed `senderIsOwner`; R3 entry makes phone-side owner commands work |
| V21 | `channels login` | not implemented; connect-existing in the wizard |
| V22 | wizard QR | `prompter.plain`; deferred/hosted → link + `openUrl` + note |
| V23 | `finalize` contract | returns the whole mutated config; throws `WizardCancelledError` on failure |
| V24 | tool contract | `registerTool(factory, { name: "ademu_enroll" })`, factory returns `null` for non-owners |
| V25/V26 | admit / dispatch surfaces | admit moot (Option B); `inbound.buildContext` + `inbound.dispatch` + `bindIngressLifecycleToReplyOptions` are not trust-gated |
| V27 | subpaths | allowlist + forbidden list enforced by `test/gates/sdk-imports.test.ts`; types that live only on `core` (`ChannelMessagingAdapter`) are type-imports |
| V28 | package facts | `ensureDaemon` env is resolution-only → our own `spawnFn` injects the child env (test-asserted) |

## 10. Deferred / recorded

SDK durable ingress queue (trust-gated; Tier C note); Control UI QR parity (`loginWithQrStart/Wait`
has no words step); `auth.login`; `accountScopedRestart`; ambient `room_event` injection; a proper
icon (the shipped one is generated); npm/ClawHub publishing (launch calendar); Windows; media, threads,
edit/unsend; residual R10 (at-most-once for callback-free zero-output completions).

## 11. Versioning

Semver from **0.1.0**. Each release pins the exact `@ademu/adc-bin` it was tested with (gate:
dependency is exact). Plugin version bump = `package.json` + `CHANGELOG.md` + the version line below
(gate: the three agree). **`beta.yml` went red — procedure:** (1) open an issue
`beta: <symbol/subpath> — <what changed>` with the failing gate output; (2) check the beta's
`plugin-sdk-subpath-records.ts` and `docs/plugins/sdk-migration.md` for the removal-ledger entry naming
the replacement; (3) land the replacement behind the same tests, move the compat floor/table if the
replacement is newer, bump the `openclaw` devDependency pin, release a patch.

Current version: **0.1.0** (unreleased).

## 12. Execution record

**Codex adversarial branch review (round 1, 2026-09-04): REVISE, 21 findings, all folded** (the plan's
§11 has the one-line disposition per finding). The ones that changed the design's letter:

- **Owned-instance verification is fail-closed.** Reattaching to a bound daemon requires all three
  canonical paths (session socket present), the daemon's `started_at_ms`, and a live pid whose start
  time and `adc daemon run` command match the row; any missing or differing fact → *foreign*
  (attach-only). The same verification runs again immediately before the daemon-global `shutdown` op,
  after re-reading the `stopping` generation; a mismatch withholds the op and marks the row `stale`.
- **Orphaned `stopping` rows** recover when the stopper is dead **or** its deadline passed: no listener
  → `stopped`; our verified instance → the stop is *resumed*; an unverified listener → `stale`.
- **An existing empty data dir** is checked (real directory, owned by us) and made 0700 before the
  claim; unsafe → `blocked` with a remedy, no spawn.
- **Terminal client errors** surfacing from the event iterator (revoked token, displaced, protocol
  violation, an invalid `seq`) end the account as `blocked`; only adoption/ack-integrity failures are
  the restart-and-replay halt. **Owned daemons** reject the lifetime on the 5th consecutive reconnect
  attempt (`DaemonLostError` → restart → respawn); foreign daemons retry unbounded.
- **The reconnect barrier** is generation-fenced and opens only after a *successful* warm-up of the
  latest reconnect; a failed warm-up closes the client (restart) instead of reporting ready on a
  partial cache. **Deferred turns** stay under the shutdown guillotine until their own terminal state.
- **Cleanup is bounded end to end**: session close and daemon release are raced against the remaining
  budget, control round trips have a real-clock bound; a hung step is logged and abandoned.
- **The tool door**: `replace_token` is accepted only from the `minting_blocked` state that a
  `label_exists` answer created (the second consent cannot be skipped); the `agentId` axis is enforced
  alongside session, sender and lease token; every terminal path disposes the lease at once; known
  acquisition failures return fixed remedy text; the config write is followed by
  `pending-publication → bound` promotion of the setup-spawned daemon; the runtime sweeps
  never-published setup daemons once per process at its first account start.
- **The manifest channel schema is generated** from the zod source (`scripts/sync-manifest-schema.mjs`)
  and deep-equal-gated; the pack golden compares the complete tarball manifest; the compat-floor gate
  checks every SDK import has a row; the privacy scanner recognizes the host's chained child-logger sink.
- **`security_notice`** (a future live event) sets fixed status copy and posts a fixed room note; the
  only logged fact is whether a room id was present — no field of the frame, not even its seq.

**Round 2 (10 findings, all folded)** tightened the same seams: a *reachable* daemon that reports no
session socket is refused rather than re-derived (the protocol's own rule — a squatter on a derived path
would receive the bearer token); a listener answering after an orphaned claim/start is always foreign
(nothing correlates it to the pid the crashed starter recorded); the pid is re-verified immediately before
each signal; a failed reconnect warm-up *rejects* the barrier (a parked loop body wakes and halts) instead
of leaving the account deadlocked; every `SessionRejectedError` — including future codes — is `blocked`;
the initial warm-up is inside the close-on-failure scope; the tool disposes its lease at once when the
pairing ends revoked/retired in the background and compares every creator axis exactly.

**Round 3 (7 findings, all folded):** a `cancel` landing while `confirm` probes now wins (the enrollment
must still be the live registry entry, un-aborted, immediately before the mint and before the config
write); the account shutdown signal reaches the session open (connect and warm-up are raced against it
and the client is closed on abort); tool admission reserves the conversation synchronously and the
config write re-checks the current draft (an account created meanwhile is never overwritten); a
claimed-but-failed upgrade yields a *foreign* lease over its `stale` row instead of "owned"; event-
processing failures are the restart-and-replay halt again while only iterator/terminal client errors end
the account as `blocked`; the room wording in README and the resident skill says unaddressed messages
are filtered before the model.

**Round 4 (5 findings, all folded):** the enrollment's liveness is re-asserted after every awaited
authority check and inside the host's mutation callback, and once the write is in flight the enrollment
is `committing` — `cancel` is refused instead of promising "nothing written"; the session's close is
memoized and never awaited on the abort path; the tool's conversation reservation precedes its first
await; the room wording states the `requireMention` default and its `false` override.

**Round 5 (4 findings, all folded):** state-changing tool actions are serialized per enrollment with a
synchronous busy claim (a duplicate `confirm`/`replace_token` is refused, so a token can never be
rotated twice with the dead one persisted); the session's memoized close is raced against abort on
the failure-first path as well; a poll aborted by `cancel` reports `cancelled`.

**Round 6 (3 LOW, all folded):** the failure-first close path removes its abort-race listener (a shared
gateway signal gains none across repeated failing opens); the memoized close and the real supersession
path have their own tests — the latter exposed that a cancelled enrollment could forget its successor's
registry entry by device id, now `forget(entry)` removes an entry only while it is still current.

**Round 7 (1 MEDIUM + 2 LOW, all folded):** the daemon probe is abortable at every stage (an account stop
is never held by an unresponsive control socket); enrollment-lease disposal is memoized so later callers
join the running cleanup, and background disposals are tracked so plugin shutdown waits for them.

**Round 8 (3 MEDIUM + 2 LOW, all folded):** the orphaned-`stopping` recovery probe honours the abort
signal; a control connection resolving after an aborted probe is closed once; an abort before
`ensureDaemon` reached its spawn drops the exact `starting` generation (no 20 s "still starting" after a
restart); TTL-expiry disposals are tracked so plugin shutdown waits for them.

**Round 9 (3 MEDIUM + 1 LOW, all folded):** a rejected authority re-check right before the spawn drops
the exact `starting` generation; the package's bare pre-spawn probe has no timeout of its own, so the
plugin supplies a bounded `connectFn` (1 s) through `ensureDaemon`'s public seam — the "≤ 1 s
probe-then-spawn window" the authority model relies on is now enforced by us; the chat tool's execution
signal reaches the daemon acquisition (cancelling during a slow acquire never spawns a setup daemon).

**Round 10 (1 HIGH + 2 MEDIUM + 3 LOW, all folded):** abandoning a `starting` generation is
origin-aware — a fresh claim is deleted, existing ownership is preserved as `stopped`/`stale` (round 9's
fix had made a rejected authority check on a *respawn* downgrade our own daemon to foreign forever); a
slow authority check refreshes its generation by CAS and the spawn re-verifies the generation
synchronously, so only the current winner ever calls `ensureDaemon`; the members cache publishes a
refresh atomically and only for the current reconnect generation, and a failed warm-up leaves the
barrier rejected; the shutdown path contains a late control connection and bounds its close.

**Round 11 (1 HIGH + 2 MEDIUM + 2 LOW, all folded):** every exit of the spawn path abandons its
`starting` generation, and once a child process exists the abandonment is always `stale` with the
child's pid facts kept — a live-but-unverified daemon is never forgotten; a later acquisition refuses to
start a second daemon beside a recorded child that is still alive (it is retried once that process
exits); the synchronous generation guard at the spawn instant and the bounded shutdown close have
their own tests.

**Round 12 (1 HIGH, folded):** a late `ensureDaemon` rejection after an aborted start now always
abandons the `starting` generation (as `stale` with the child's pid facts when a child had spawned), so
a daemon that started but never answered is never forgotten and never gets a sibling.

**Round 13 (1 HIGH + 1 LOW, folded):** an orphaned start is resolved in a fixed order — a listener is
foreign; no listener but a recorded child still alive is `stale` (kept, never given a sibling); only
then is the generation reclaimed and a daemon spawned.

**Headless acceptance caught two more** (exactly the K1 trap the risks ledger predicted): the first
tarball carried a stale `dist/` built before the tool existed, and `@ademu/adc-bin` does not export its
`package.json` (`ERR_PACKAGE_PATH_NOT_EXPORTED` at register time). Both fixed; the acceptance now
proves loaded + channel + `ademu_enroll` + service + both skills against `openclaw@2026.9.1`.

**Recorded during execution:** `api.runtime.media` carries no QR renderers in 2026.9.1 (V2: the
`media-runtime` exception is the live path); `ChannelMessagingAdapter` is exported only from the `core`
subpath (type import); OpenClaw's logout hook has no config-write channel, so Rider B's logout uses
`mutateConfigFile`; the `--link` dev loop (T20) was not exercised — the npm-pack path is the one the
acceptance and E2E use.

**ClawHub dry-run (V13/T19):** `clawhub package publish . --dry-run --json --family code-plugin` works
**unauthenticated** (CLI 0.23.3): 48 files / 62 661 bytes, source
`github:ademu/openclaw-ademu@feat/openclaw-ademu-1`. Publishing stays a launch-calendar item.

**Repo gates (T21):** ruleset "main gate" id 22259787 (PR required / 0 reviews, no force-push or
deletion, required check `ci-gate`, admin bypass); Issues enabled. **Monorepo pointer PR (T22):**
ademu/AdemuMLS#221.

## 13. Close-out

Filled at E2E: one outcome line per V/R/rider, the eight E2E legs (isolated daemon legs 1–7; leg 8 =
read-only attach to the production daemon in foreign mode, recording the takeover displacement of the
device's current mind), the first `beta.yml` run.
