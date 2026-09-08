# OPENCLAW-ADEMU-1 — the Ademú channel plugin for OpenClaw

*Design record, written for strangers. Companion plan: `docs/superpowers/plans/2026-09-03-slice-openclaw-ademu-1.md`.
Compat-floor derivation: `compat-floor.md`. Status: **closed** (2026-09-08); §13 is the close-out.*

## 1. What this is

Ademú is an end-to-end encrypted messenger. An **agent device** is an Ademú device whose "mind" is an
external program; the device's full E2EE client stack runs in the Ademú device host, the `adc` daemon,
and the mind drives it over a local socket. This plugin makes **OpenClaw** that mind: it bundles the
daemon (`@ademu/adc-bin`, exact version per release), enrolls an OpenClaw agent as a device through
Ademú's four-word ceremony, and then runs the device as a resident OpenClaw channel — messages in
(already decrypted by the daemon, with cryptographic sender identity), typing while the model composes,
replies out (encrypted before they leave the machine), reactions, green ticks.

It is an **external** plugin (`@ademu/openclaw-ademu`, manifest id `ademu`), built only on OpenClaw's
public `openclaw/plugin-sdk/*` surfaces, against a pinned host (`openclaw@2026.9.1`) with a derived
compatibility floor (`>=2026.8.1`). Nothing in the daemon, the protocol, or the published `@ademu/*`
packages changed for this slice; every gap became a documented disposition instead.

## 2. Decisions (the ratified ones, in plain words)

**Decision 1 — the green tick is a promise about ownership, not about a reply.** Ademú's read-receipt
weight ack (`ack`) is cumulative: acking sequence N acks everything before it. The plugin acks a message
only after OpenClaw has **committed its adoption** of that message — core's `onAdopted` callback, which
fires after the user turn is durably recorded and *before* the model runs. So a green tick means "the
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

**Round 14 (2 HIGH, folded):** two predicates with opposite polarity now govern a recorded child —
*kill authorization* is fail-closed (every fact must match) while *spawn suppression* is conservative
(an alive pid with incomplete facts "may still be alive" and never gets a sibling; only `alive:false` or
a start time proving pid reuse permits a respawn) — and the rule applies to an unreachable bound daemon
too, not only to orphaned or stale rows.

**Round 15: APPROVE** (no findings; 275 tests green). The branch campaign closed after 15 rounds and
78 folded findings — every premise verified in the trees before folding.

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

**Plugin PR:** ademu/openclaw-ademu#1 — first CI run all green: `test (node 22.22.3)`, `test (node 24.15.0)`,
`acceptance (openclaw host)` (headless install into a fresh OpenClaw 2026.9.1 state dir), and the
required `ci-gate`. `beta.yml`'s first run is a `workflow_dispatch` after the merge (the workflow must
exist on the default branch to be dispatchable).

**E2E finding #1 (owner's Hetzner VPS, Linux, 2026-09-04) — the chat door was unreachable on a fresh
install.** "I want to talk to you on Ademú" in the TUI made the agent web-search Ademú instead of
calling `ademu_enroll`: the manifest declared `activation.onStartup: false`, and OpenClaw loads a
startup-lazy channel plugin only when `channels.<id>` is already configured
(`gateway-startup-plugin-config.ts` `shouldConsiderForGatewayStartup`/`hasConfiguredStartupChannel`), so
before the first account exists the gateway never imported the plugin — no tool, no skill. The wizard
door was unaffected (the setup flow loads the plugin explicitly). Fix: `activation.onStartup: true`,
pinned by `test/gates/manifest-activation.test.ts`. Cost: none beyond registering the tool and the
lease service — with zero accounts `server-channels.ts` starts nothing (`listAccountIds` empty → return),
and `registerFull` opens neither SQLite nor a daemon (entries test). The headless acceptance had not
caught this because it seeds an account before inspecting (V14/R8).

**E2E on the owner's Hetzner VPS (Linux, 2026-09-08), so far:** leg 2 (door one, `openclaw channels
add --channel ademu`) PASSED — QR in the SSH terminal, phone scan, four words, enrolled, first agent
device created from a fresh plugin-owned daemon. The chat door (TUI) still did not produce the tool for
the owner; left OPEN for a re-test against the `onStartup: true` build (finding #1) — if it fails
there too, a second cause is to be found (the TUI connects with `operator.admin`, so the owner gate is
not it).

**E2E leg 3 (residency) PASSED on the VPS (2026-09-08):** message from the phone → green tick → typing →
reply; reaction path exercised. **Leg 6, restart step, observed as designed:** a message sent and the
gateway restarted within a second showed the green (read) tick — adoption had committed and acked it —
and no reply ever came: the restart killed the model run and OpenClaw does not resume interrupted
channel runs. This is the recorded limitation from §3/K3 ("a restart mid-turn can lose that turn's
reply, never the message"), now seen live; a launch-hardening candidate is a post-restart "I was
restarted while answering" notice or a re-run from the transcript. **Copy correction from the same
session:** Ademú's read receipt is GREEN (gray = delivered); every surface that said "blue tick" now
says green.

**Repo gates (T21):** ruleset "main gate" id 22259787 (PR required / 0 reviews, no force-push or
deletion, required check `ci-gate`, admin bypass); Issues enabled. **Monorepo pointer PR (T22):**
ademu/AdemuMLS#221.

## 13. Close-out (2026-09-08)

**Where the E2E ran.** Not on the dev Mac as planned but on the owner's Hetzner VPS (Linux), a fresh
OpenClaw install with no other Ademú daemon on the machine — so the isolated-daemon legs ran against a
clean host and leg 8 (the read-only attach to the production daemon, Mac-only) did not run. Legs 1–3
and 6 passed; 4 is open with its fix landed; 5, 7 and 8 are tracked as issues (below).

### E2E legs — one line each

- **Leg 1 (install from the `npm pack` tarball):** PASS — `plugins install npm-pack:…` on the VPS,
  plugin loaded, channel + tool registered after `gateway restart`.
- **Leg 2 (door one, `openclaw channels add --channel ademu`):** PASS — QR rendered in the SSH terminal,
  phone scan, four words matched, enrolled; a fresh plugin-owned daemon under the OpenClaw state dir.
- **Leg 3 (residency):** PASS — message from the phone → green (read) tick → typing indicator → reply;
  reaction path exercised.
- **Leg 4 (door two, chat tool):** OPEN — finding #1 (`activation.onStartup:false` kept the plugin
  unloaded before the first account; fixed to `true`, gate-tested). The owner's re-test with the fixed
  build is pending → issue.
- **Leg 5 (room manners with a second human):** NOT RUN → issue.
- **Leg 6 (lifecycle):** PASS for the two steps run — `gateway restart` brought the channel back and a
  fresh message was answered (a message adopted right before the restart lost its reply, as recorded in
  §3/K3 — observed live); `pkill` of the owned daemon → `recovering` → respawn → ready → reply. The
  token-rotation → connect-existing step was NOT RUN → issue.
- **Leg 7 (uninstall → config gone incl. the R3 prune → restore via connect-existing):** NOT RUN → issue.
- **Leg 8 (foreign mode: read-only attach to the production daemon, takeover displacement recorded):**
  NOT RUN (Mac-only) → issue. Foreign mode is covered by the daemon test suite only.

### Approval riders — one line each

- **Rider R1 (cumulative-ack halt rule):** built as §3 R3 and pinned by the ingress tests (no ack for N
  or later on any pre-adoption failure; restart replays from the daemon cursor); live: the restart step
  of leg 6 showed adoption + ack committing before the model run exactly as specified.
- **Rider R2 (durable ownership, default-isolated data dir, foreign = attach-only):** built as §4;
  OWNED mode demonstrated live (spawn under `<state>/ademu/adc`, kill → respawn, restart re-attach);
  FOREIGN mode demonstrated by tests only (leg 8 not run).
- **Rider R3 (typing keepalive 2000 ms):** built (`typingKeepaliveMs` default 2000 → reply-pipeline
  `keepaliveIntervalMs`); typing observed live on leg 3.

### Design refinements R1–R11 — one line each

- **R1 daemon identity channel-level, default isolated:** as built; live on the VPS (defaults only, no
  `socketPath`/`dataDir` configured).
- **R2 durable ownership state machine:** as built (§4); live: `bound` row survived a gateway restart and
  a daemon kill (respawn under a new generation).
- **R2b ack at adoption (Option B):** as built (§3); live: green tick before the reply on every message.
- **R2c keepalive 2000 ms:** as built; live.
- **R3 owner authority `ademu:<ownerUserId>`:** as built with Riders A (confirm copy) and B (prune on
  removal/logout); the wizard asked the Rider-A question live; the prune is unit-tested (leg 7 not run).
- **R4 no `auth.login`:** held; connect-existing is the wizard's second branch (not exercised live).
- **R5 token in config, SecretRef-capable:** as built; the wizard wrote it live.
- **R6 `heartbeat.sendTyping`:** as built (not observable in the legs run).
- **R7 Windows guard:** as built (blocked before any resolver); unit-tested only.
- **R8 skills assertion in CI:** `skills list --json` works headless (acceptance lane), symlink fallback
  kept; live: the resident and enroll skills were visible to the agent in the TUI.
- **R9 plugin-owned `node:sqlite`:** as built; live on Node ≥ 22.22.3 on the VPS.
- **R10 at-most-once for callback-free zero-output completions:** recorded residual, unchanged; not
  observed in the legs.
- **R11 server endpoints default to production:** as built; live — the VPS daemon reached Ademú with
  zero configuration.

### Verification dispositions V1–V29 — outcome

Every row of §9 HELD at execution as written there, with these additions from the live run: **V13**
ClawHub `package publish --dry-run` works unauthenticated (48 files) — publishing stays a local
release step; **V14** the headless acceptance is real (CI lane green on every PR run) but it seeds an
account before inspecting, which is why it could not catch finding #1 — a no-account inspect step is
a follow-up; **V15/V20** held (peer range never checked; new plugin code needed `gateway restart` — the
owner hit exactly this when the skill appeared only after a restart); **V16** held (VPS Node in range);
**V19** the TUI connects with `operator.admin`, so its sender is owner — the tool's absence on the first
try was finding #1, not the owner gate; **V22** the terminal QR scanned fine over SSH; **V29** moot on
the VPS (no production daemon there) — the Mac hazard remains recorded for leg 8.

### Repo and release facts

- Plugin PR ademu/openclaw-ademu#1: Codex adversarial branch review APPROVE at round 15 (78 findings
  folded); CI (`test` ×2 Node versions, `acceptance`, required `ci-gate`) green on every head; merged
  2026-09-08. The post-APPROVE delta is the one-line `onStartup` flip + its gate test + docs
  (owner-accepted without a further round).
- Ruleset "main gate" id 22259787 (PR required, no force-push/delete, required check `ci-gate`); Issues
  enabled.
- Monorepo pointer PR ademu/AdemuMLS#221 (design index + `docs/design/agents.md` pointer).
- ClawHub dry-run: works unauthenticated; npm/ClawHub publishing remain launch-calendar items.
- `beta.yml` first run (2026-09-08, right after the merge): RED — in our own version-print step, not in
  any gate: `require('openclaw/package.json')` → `ERR_PACKAGE_PATH_NOT_EXPORTED` (OpenClaw does not
  export `./package.json`; the same class as the adc-bin fix in T18 — second occurrence, so the repo
  now has zero exports-map `package.json` requires). Fixed to a file-path read; second run on the fix
  branch: GREEN, `openclaw@beta` resolving to the already-pinned 2026.9.1 (no SDK drift to report).
- Version stays **0.1.0 (unreleased)**; exact `@ademu/adc-bin` pin 0.2.4.

### Follow-ups opened at close-out

ademu/openclaw-ademu issues #2 (leg 4 re-test), #3 (leg 5), #4 (leg 6 rotation step), #5 (leg 7),
#6 (leg 8, Mac-only foreign mode), #7 (launch hardening: reply lost when the gateway restarts after
adoption), #8 (acceptance lane: inspect with no account — would have caught finding #1).
