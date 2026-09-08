// Door one (plan T12): `openclaw channels add --channel ademu`. A declarative wizard whose whole
// body is `finalize` — the token is PRODUCED by the ceremony, never typed (credentials: []). The
// account is written under the wizard-resolved accountId; the R3 owner grant is a default-yes
// confirm naming the one "no" case (Rider A). Every progress handle is stopped before any prompt
// and in `finally`; a failure THROWS WizardCancelledError (a void return would be recorded as
// success). The QR goes through `prompter.plain` only (K11) — never `note`, never `runtime.log`.
import type { AdcClient, AdcClientOptions } from "@ademu/adc-client";
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { resolveAgentConfig, tryResolveDefaultAgentId } from "openclaw/plugin-sdk/agent-scope-runtime";
import type { ChannelSetupWizard } from "openclaw/plugin-sdk/channel-setup";
import { WizardCancelledError, type WizardPrompter } from "openclaw/plugin-sdk/setup";
import {
  connectExisting,
  createEnrollmentLease,
  listEnrolledDevices,
  runEnrollment,
  type EnrollmentLease,
  type EnrollmentLeaseDeps,
  type EnrollmentResult,
} from "./ceremony.js";
import { CHANNEL_ID, inspectAdemuAccount, listAdemuAccountIds } from "./config.js";
import { applyEnrollment } from "./enroll-config.js";
import { strings } from "./i18n/strings.js";
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

export function createAdemuSetupWizard(deps: WizardDeps): ChannelSetupWizard {
  return {
    channel: CHANNEL_ID,
    status: ademuWizardStatus,
    credentials: [],
    finalize: async ({ cfg, accountId, prompter, options }) => {
      const beforeEffect = options?.beforePersistentEffect ?? (async () => {});
      const deferToClient = options?.deferDeviceLinkToClient === true;
      await prompter.intro(strings.enroll.wizardIntro);

      const account = inspectAdemuAccount(cfg, accountId);
      let progress = prompter.progress(strings.enroll.startingHost);
      let lease: EnrollmentLease | undefined;
      try {
        try {
          lease = await createEnrollmentLease({
            deps: deps.lease,
            accountId,
            identity: account.daemon,
            server: account.server,
            beforeEffect,
          });
        } catch (err) {
          progress.stop();
          const remedy = remedyFor(err);
          if (!remedy) throw err;
          await prompter.note(remedy, strings.channelLabel);
          throw new WizardCancelledError(remedy);
        }
        progress.stop();

        const enrolled = await listEnrolledDevices(lease.control);
        const mode = enrolled.length
          ? await prompter.select<"new" | "existing">({
              message: strings.enroll.modeQuestion,
              options: [
                { value: "new", label: strings.enroll.modeNew },
                { value: "existing", label: strings.enroll.modeExisting },
              ],
            })
          : "new";

        const common = {
          control: lease.control,
          connectSession: deps.connectSession,
          accountId,
          beforeEffect,
          signal: lease.signal,
          confirmReplace: async () => prompter.confirm({ message: strings.enroll.replaceTokenConfirm, initialValue: false }),
          confirmTakeover: async () => prompter.confirm({ message: strings.enroll.takeoverConfirm, initialValue: false }),
        };

        let result: EnrollmentResult;
        let agentName: string;
        if (mode === "existing") {
          const deviceId = await prompter.select<string>({
            message: strings.enroll.pickDevice,
            options: enrolled.map((d) => ({ value: d.deviceId, label: d.agentName, hint: d.deviceId })),
          });
          agentName = enrolled.find((d) => d.deviceId === deviceId)?.agentName ?? strings.enroll.agentNameFallback;
          lease.deviceId = deviceId;
          lease.terminal = true;
          progress = prompter.progress(strings.enroll.mintingToken);
          try {
            result = await connectExisting({ ...common, deviceId });
          } finally {
            progress.stop();
          }
        } else {
          agentName = (await prompter.text({ message: strings.enroll.agentNamePrompt, initialValue: defaultAgentName(cfg) })).trim() || defaultAgentName(cfg);
          const activeLease = lease;
          let waiting: ReturnType<WizardPrompter["progress"]> | undefined;
          try {
            result = await runEnrollment({
              ...common,
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
          } finally {
            waiting?.stop();
          }
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
          grantOwnerAuthority: grant,
        });
        await prompter.outro(mode === "existing" ? strings.enroll.connected(agentName) : strings.enroll.enrolled(agentName));
        return { cfg: nextCfg };
      } catch (err) {
        if (err instanceof WizardCancelledError) throw err;
        const remedy = remedyFor(err);
        if (remedy) {
          await prompter.note(remedy, strings.channelLabel);
          throw new WizardCancelledError(remedy);
        }
        throw err;
      } finally {
        progress.stop();
        await lease?.dispose("wizard-exit");
      }
    },
  };
}
