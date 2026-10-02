// The operator's CLI commands, composed from the daemon identity (never from an error message): a
// system install is driven with `sudo adc --system`; a user-scope daemon with the plugin's data dir in
// ADC_DATA_DIR (the CLI's default data dir is NOT the plugin's). Spec M20 (b)–(d): the manual ceremony
// is the fallback on a hardened host, a lost mint reply is answered by minting a fresh label at the
// CLI, an orphaned token (config write failed after the mint) is revoked by label.
import type { DaemonIdentity } from "./config.js";
import { strings } from "./i18n/strings.js";

export type OperatorContext = {
  identity?: DaemonIdentity | undefined;
  deviceId?: string | undefined;
  /** The token label the ceremony used (`openclaw-<accountId>`). */
  label?: string | undefined;
  agentName?: string | undefined;
};

/** POSIX single-quoting: the one safe way to hand a path or a name to a copied shell line. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * `sudo adc --system` on a system install; for a user-scope daemon `ADC_DATA_DIR` AND `ADC_SOCKET_PATH`
 * (the CLI's own ladder prefers `$XDG_RUNTIME_DIR` over the data dir on Linux, and a configured control
 * socket may live anywhere — the ceremony verbs the operator runs are control-socket ops); bare `adc`
 * when the identity is unknown.
 */
export function adcCommandPrefix(identity: DaemonIdentity | undefined): string {
  if (!identity) return "adc";
  if (identity.scope === "system") return "sudo adc --system";
  return `ADC_DATA_DIR=${shellQuote(identity.raw.dataDir)} ADC_SOCKET_PATH=${shellQuote(identity.raw.controlSocket)} adc`;
}

/** The three operator steps: enroll at the CLI, mint the token, paste it into the wizard's token door. */
export function operatorCeremony(ctx: OperatorContext): string {
  return strings.enroll.operatorSteps(adcCommandPrefix(ctx.identity), shellQuote(ctx.agentName ?? strings.enroll.agentNameFallback), ctx.label ?? "openclaw-<accountId>");
}

/** M20 (b): a lost mint reply — mint a fresh label at the CLI and paste it. */
export function mintFreshLabelCommand(ctx: OperatorContext): string {
  const fresh = ctx.label ? `${ctx.label}-2` : "openclaw-<accountId>-2";
  return `${adcCommandPrefix(ctx.identity)} token mint ${ctx.deviceId ?? "<device_id>"} --label ${fresh}`;
}

/** M20 (c): a config write that failed after the mint — revoke that label. */
export function revokeLabelCommand(ctx: OperatorContext): string {
  return `${adcCommandPrefix(ctx.identity)} token revoke ${ctx.deviceId ?? "<device_id>"} --label ${ctx.label ?? "openclaw-<accountId>"}`;
}
