# SLICE OPENCLAW-ADEMU-1 — the Ademú channel plugin for OpenClaw: "I want to talk to you on Ademú"

_The owner's slice brief as issued on 2026-09-03 (the spec this repository was built from). The
implementation plan that executed it, with every verification and review round, is
`docs/superpowers/plans/2026-09-03-slice-openclaw-ademu-1.md`; the public design record is
`docs/design/2026-09-openclaw-ademu-1.md`. Where the plan's Gate 0 corrected a claim below (marked
[V] in the brief), the plan wins._

**Ground.** Written against the OpenClaw recon (2026-09-02) and its drift/gap mini-probe
(2026-09-03, checkout `951c268db0cb` = main @ package.json 2026.8.1; npm `latest` 2026.8.2,
`beta` 2026.9.1-beta.1, `extended-stable` 2026.6.34), the six published `@ademu` packages as npm
serves them (adc-client/adc-control 0.1.1, adc-bin + platforms 0.2.4), and seven owner-ratified
decisions (below). Claims marked [V] MUST be re-verified at Gate 0 against the openclaw checkout
AS IT IS THEN (their cadence is monthly with hours-long betas — drift is a finding) and against
the published `.d.ts` of our packages; the tree wins, corrections fold silently, and one stop
condition applies: if a re-verification makes a pinned mechanism unusable, STOP and report.

**Scope: a NEW public repository `ademu/openclaw-ademu`** — the first slice outside the monorepo.
Zero changes to the monorepo except one design-entry pointer paragraph (a small follow-up PR).
Zero changes to the daemon, the protocol, or the published packages (any gap found in them is a
STOP-and-report, not a workaround — they have external consumers now). Zero publishing in-slice
(npm and ClawHub publication are launch-calendar items; this slice ships a package that installs
from `npm pack` output through OpenClaw's real installer).

## What this is

The connector that makes one sentence work. Today an OpenClaw agent cannot reach Ademú at all.
After this slice: a user installs the plugin (the adc daemon arrives inside it), says "I want to
talk to you on Ademú" — or runs `openclaw channels add --channel ademu` — and the agent renders an
enrollment QR, the owner scans it with the Ademú app, confirms four safety words, and the agent
announces it is reachable from the phone. From then on the agent is a RESIDENT: Ademú
conversations are channels it lives in; messages arrive with cryptographic sender identity; the
owner sees blue ticks when the harness has the message and a typing indicator while the agent
composes; replies go back end-to-end encrypted. Plaintext never touches Ademú's servers — the
agent's device runs locally, inside OpenClaw's own process lifetime.

## Decisions (owner-ratified 2026-09-02/03)

1. **Ack = after durable admit, before the model runs.** A blue tick means "your agent's harness
   has this message safely." Cumulative acks make selective non-acking impossible; a dropped
   stranger's DM is acked too. _(Plan: letter changed to "ack at adoption" under Option B, owner
   2026-09-04; the promise holds.)_
2. **Vocabulary: "enroll", never "pair"** on every OpenClaw-facing surface; a test greps for it.
3. **Two onboarding doors, one ceremony, daemon bundled:** the setup wizard and an owner-gated
   `ademu_enroll` tool; the adc daemon arrives with the plugin (`@ademu/adc-bin`); the plugin owns
   the daemon's lifetime, attaching to an already-running daemon if present (recorded divergence
   from Signal's refuse-if-busy). Windows: unsupported, channel `blocked`.
4. **Distribution:** public repo `ademu/openclaw-ademu`, package `@ademu/openclaw-ademu`, manifest
   id `ademu`, channel label "Ademú", ClawHub slug `ademu/openclaw-ademu`; Tier A now (external
   ClawHub plugin), Tier C (upstream bundled channel) as the strategic goal; no publish in-slice.
5. **Security defaults:** DM allowlist = `[owner_user_id]` enforced in our inbound pipeline; no
   OpenClaw `pairing` declared; sender identity verified; rooms: the owner is always heard, guests
   only when they address the agent; `resolveSenderRole(user_id) → 'owner' | 'other'` is the seam.
6. **Multi-agent = multi-account:** `channels.ademu.accounts.<accountId>`, one per Ademú device;
   one daemon serves all accounts; logout clears config and says the token remains valid until
   `adc token revoke`.
7. **Treadmill accepted:** target extended-stable for users; CI against a pinned `openclaw` and a
   nightly job against `openclaw@beta`; no import from removal-pending subpaths.

_(Sections 1–8 of the brief — repository/toolchain, channel runtime, wizard, tool, skills, config
schema, tests, E2E — and the "Explicitly out" and "Definition of done" lists are carried, with the
Gate 0 dispositions and all review-round corrections, in the plan document.)_
