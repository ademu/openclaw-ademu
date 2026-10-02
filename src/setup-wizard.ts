// Door one (plan T12): `openclaw channels add --channel ademu`. A declarative wizard whose whole
// body is `finalize`. Two doors behind one question: enroll a NEW agent (the ceremony over the
// daemon's ENROLLMENT socket — the token is PRODUCED, never typed) or "I have a device token" (an
// already-enrolled agent whose token an operator minted at the CLI: pasted here, checked over the
// SESSION socket with `get_self`; no enrollment connection is needed, so it works even where the
// enrollment socket refuses this user). The account is written under the wizard-resolved accountId;
// the R3 owner grant is a default-yes confirm naming the one "no" case (Rider A). Every progress
// handle is stopped before any prompt and in `finally`; a failure THROWS WizardCancelledError (a void
// return would be recorded as success). The QR goes through `prompter.plain` only (K11) — never
// `note`, never `runtime.log`. Credentials: [] — the token field is sensitive and never a wizard input.
import type { AdcClient, AdcClientOptions } from "@ademu/adc-client";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveAgentConfig, tryResolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
import { PrivilegeError } from "@ademu/adc-control";
import { WizardCancelledError, type WizardPrompter } from "openclaw/plugin-sdk/setup";
import {
  createEnrollmentLease,
  probeTokenIdentity,
  runEnrollment,
  tokenLabelFor,
  type EnrollmentLease,
  type EnrollmentLeaseDeps,
  type EnrollmentResult,
} from "./ceremony.js";
import { CHANNEL_ID, inspectAdemuAccount, inspectAdemuAccountForEnrollment, listAdemuAccountIds } from "./config.js";
import { applyEnrollment } from "./enroll-config.js";
import { strings } from "./i18n/strings.js";
import type { Lease } from "./monitor/daemon.js";
import { revokeLabelCommand, type OperatorContext } from "./operator.js";
import { remedyFor } from "./remedies.js";
import type { Qr } from "./qr.js";

export type WizardDeps = {
  lease: EnrollmentLeaseDeps;
  connectSession: (opts: AdcClientOptions) => Promise<AdcClient>;
  qr: Qr;
};

/** Default agent display name: the default agent's identity name, else a plain fallback (V11). */
export function defaultAgentName(cfg: OpenClawConfig): string {
  const agentId = tryResolveDefaultAgentId(cfg);
  if (!agentId) return strings.enroll.agentNameFallback;
  const agent = resolveAgentConfig(cfg, agentId);
  const name = (agent?.identity as { name?: string } | undefined)?.name ?? agent?.name;
  return name?.trim() || strings.enroll.agentNameFallback;
}

export function isAccountEnrolled(cfg: OpenClawConfig, accountId?: string): boolean {
  const ids = accountId ? [accountId] : listAdemuAccountIds(cfg);
  return ids.some((id) => {
    const a = inspectAdemuAccount(cfg, id);
    return a.enabled && a.configured;
  });
}

/** Shows the QR: terminal → `plain`; hosted/deferred client → link + openUrl + a note (V22). */
export async function presentQr(prompter: WizardPrompter, qr: Qr, payload: string, deferToClient: boolean): Promise<void> {
  if (!deferToClient && prompter.plain) {
    await prompter.plain(`${strings.enroll.scanHint}\n\n${await qr.terminal(payload)}\n${payload}\n`);
    return;
  }
  await prompter.note(`${strings.enroll.scanLinkOnly}\n\n${payload}`, strings.enroll.scanTitle);
  await prompter.openUrl?.(payload);
}

/** The status descriptor is static (no daemon needed) so the setup-only entry can carry it too. */
export const ademuWizardStatus: ChannelSetupWizard["status"] = {
  configuredLabel: strings.enroll.configuredLabel,
  unconfiguredLabel: strings.enroll.unconfiguredLabel,
  configuredHint: strings.enroll.configuredHint,
  resolveConfigured: ({ cfg, accountId }) => isAccountEnrolled(cfg, accountId),
};

type Finalize = NonNullable<ChannelSetupWizard["finalize"]>;
type FinalizeArgs = Parameters<Finalize>[0];
type FinalizeResult = Awaited<ReturnType<Finalize>>;

export function createAdemuSetupWizard(deps: WizardDeps): ChannelSetupWizard {
  return {
    channel: CHANNEL_ID,
    status: ademuWizardStatus,
    credentials: [],
    finalize: async (args) => {
      const { cfg, accountId, prompter } = args;
      await prompter.intro(strings.enroll.wizardIntro);
      // The account's recorded scope is ignored: a re-enrollment lands where the host points now.
      const account = inspectAdemuAccountForEnrollment(cfg, accountId);
      const operator: OperatorContext = { identity: account.daemon, label: tokenLabelFor(accountId) };
      // The question comes BEFORE any daemon lease: the token door must not need the enrollment socket.
      const mode = await prompter.select<"new" | "token">({
        message: strings.enroll.modeQuestion,
        options: [
          { value: "new", label: strings.enroll.modeNew },
          { value: "token", label: strings.enroll.modeToken },
        ],
      });
      /**
       * A known failure becomes fixed remedy copy + WizardCancelledError; anything else is rethrown.
       * The trailer (the revoke-by-label instruction after a mint) is shown whatever the error is.
       */
      const fail = async (err: unknown, ctx: OperatorContext, trailer?: string): Promise<never> => {
        if (err instanceof WizardCancelledError) {
          if (trailer) await prompter.note(trailer, strings.channelLabel);
          throw err;
        }
        const remedy = remedyFor(err, ctx);
        if (!remedy) {
          if (trailer) {
            await prompter.note(trailer, strings.channelLabel);
            if (err instanceof Error) err.message = `${err.message}\n\n${trailer}`;
          }
          throw err;
        }
        const note = trailer ? `${remedy}\n\n${trailer}` : remedy;
        await prompter.note(note, strings.channelLabel);
        throw new WizardCancelledError(note);
      };
      return mode === "token" ? await tokenDoor(deps, args, account, operator, fail) : await newDoor(deps, args, account, operator, fail);
    },
  };
}

type Account = ReturnType<typeof inspectAdemuAccountForEnrollment>;
type Fail = (err: unknown, ctx: OperatorContext, trailer?: string) => Promise<never>;

/**
 * "I have a device token": a setup lease for the session socket path (it also starts a user-scope
 * device host that is not running), `get_self`, the grant, the write. The door never needs the
 * enrollment socket: a broker refusal there (a group-gated posture, or an explicitly configured
 * hardened layout) is not fatal — the session socket is the token's door, so the probe falls back to
 * the identity's own session socket path and proceeds without a lease.
 */
async function tokenDoor(deps: WizardDeps, args: FinalizeArgs, account: Account, operator: OperatorContext, fail: Fail): Promise<FinalizeResult> {
  const { cfg, accountId, prompter, options } = args;
  const beforeEffect = options?.beforePersistentEffect ?? (async () => {});
  const token = (
    await prompter.text({
      message: strings.enroll.tokenPrompt,
      sensitive: true,
      validate: (value) => (value.trim() ? undefined : strings.enroll.tokenEmpty),
    })
  ).trim();
  if (!token) throw new WizardCancelledError(strings.enroll.tokenEmpty);
  let progress = prompter.progress(account.daemon.scope === "system" ? strings.enroll.attachingSystemDaemon : strings.enroll.startingHost);
  let daemonLease: Lease | undefined;
  let sessionSocketPath = account.daemon.raw.sessionSocket;
  try {
    try {
      daemonLease = await deps.lease.daemons.acquire({ identity: account.daemon, server: account.server, role: "setup", beforeEffect });
      sessionSocketPath = daemonLease.info.sessionSocketPath;
    } catch (err) {
      progress.stop();
      // The enrollment socket refused this user: irrelevant to a token — keep the configured session path.
      if (!(err instanceof PrivilegeError)) await fail(err, operator);
    }
    progress.stop();
    progress = prompter.progress(strings.enroll.checkingToken);
    let identity: Awaited<ReturnType<typeof probeTokenIdentity>>;
    try {
      identity = await probeTokenIdentity({
        token,
        sessionSocketPath,
        connectSession: deps.connectSession,
        signal: new AbortController().signal,
        confirmTakeover: async () => {
          progress.stop();
          return prompter.confirm({ message: strings.enroll.takeoverConfirm, initialValue: false });
        },
      });
    } finally {
      progress.stop();
    }
    const agentName =
      identity.agentDisplayName.trim() || (await prompter.text({ message: strings.enroll.agentNamePrompt, initialValue: defaultAgentName(cfg) })).trim() || defaultAgentName(cfg);
    // R3 Rider A — default yes, the copy names the grant and the one "no" scenario.
    const grant = await prompter.confirm({ message: strings.enroll.ownerGrantConfirm, initialValue: true });
    await beforeEffect();
    const nextCfg = applyEnrollment(cfg, {
      accountId,
      agentName,
      deviceId: identity.deviceId,
      agentUserId: identity.agentUserId,
      ownerUserId: identity.ownerUserId,
      token,
      daemonScope: account.daemon.scope,
      grantOwnerAuthority: grant,
    });
    await prompter.outro(strings.enroll.connected(agentName));
    return { cfg: nextCfg };
  } catch (err) {
    return await fail(err, operator);
  } finally {
    progress.stop();
    await daemonLease?.release().catch(() => {});
  }
}

/** Enroll a NEW agent: the ceremony over the enrollment socket (QR → words → confirm → mint). */
async function newDoor(deps: WizardDeps, args: FinalizeArgs, account: Account, operator: OperatorContext, fail: Fail): Promise<FinalizeResult> {
  const { cfg, accountId, prompter, options } = args;
  const beforeEffect = options?.beforePersistentEffect ?? (async () => {});
  const deferToClient = options?.deferDeviceLinkToClient === true;
  let progress = prompter.progress(account.daemon.scope === "system" ? strings.enroll.attachingSystemDaemon : strings.enroll.startingHost);
  let lease: EnrollmentLease | undefined;
  /** Set once a token exists: a failure after this point names the label to revoke (M20 c). */
  let minted: EnrollmentResult | undefined;
  try {
    try {
      lease = await createEnrollmentLease({ deps: deps.lease, accountId, identity: account.daemon, server: account.server, beforeEffect });
    } catch (err) {
      progress.stop();
      await fail(err, operator);
    }
    progress.stop();
    const activeLease = lease!;
    const agentName = (await prompter.text({ message: strings.enroll.agentNamePrompt, initialValue: defaultAgentName(cfg) })).trim() || defaultAgentName(cfg);
    let waiting: ReturnType<WizardPrompter["progress"]> | undefined;
    let result: EnrollmentResult;
    try {
      result = await runEnrollment({
        control: activeLease.control,
        connectSession: deps.connectSession,
        accountId,
        beforeEffect,
        signal: activeLease.signal,
        confirmTakeover: async () => prompter.confirm({ message: strings.enroll.takeoverConfirm, initialValue: false }),
        agentName,
        onDevice: (id) => {
          activeLease.deviceId = id;
        },
        onQr: (payload) => presentQr(prompter, deps.qr, payload, deferToClient),
        onWords: (words) => prompter.note(strings.enroll.words(words), strings.enroll.wordsTitle),
        confirm: async () => {
          const ok = await prompter.confirm({ message: strings.enroll.wordsConfirm, initialValue: true });
          if (ok) waiting = prompter.progress(strings.enroll.waitingEnrollment);
          return ok;
        },
      });
      activeLease.terminal = true;
      minted = result;
    } finally {
      waiting?.stop();
    }
    // R3 Rider A — default yes, the copy names the grant and the one "no" scenario.
    const grant = await prompter.confirm({ message: strings.enroll.ownerGrantConfirm, initialValue: true });
    await beforeEffect();
    const nextCfg = applyEnrollment(cfg, {
      accountId,
      agentName,
      deviceId: result.deviceId,
      agentUserId: result.agentUserId,
      ownerUserId: result.ownerUserId,
      token: result.token,
      daemonScope: account.daemon.scope,
      grantOwnerAuthority: grant,
    });
    await prompter.outro(strings.enroll.enrolled(agentName));
    return { cfg: nextCfg };
  } catch (err) {
    const ctx: OperatorContext = { ...operator, deviceId: lease?.deviceId ?? minted?.deviceId, label: minted?.tokenLabel ?? operator.label };
    const trailer = minted ? strings.enroll.orphanedToken(revokeLabelCommand({ ...ctx, deviceId: minted.deviceId, label: minted.tokenLabel })) : undefined;
    return await fail(err, ctx, trailer);
  } finally {
    progress.stop();
    await lease?.dispose("wizard-exit");
  }
}
