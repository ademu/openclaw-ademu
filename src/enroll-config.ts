// Config writes performed by the two enrollment doors (plan T12/T13): the account block, the channel
// enable flag, and (R3, owner-ratified) the channel-scoped owner authority entry. Pure functions over
// the whole config — the wizard returns the result, the tool hands it to `mutateConfigFile`.
import type { OpenClawConfig } from "openclaw/plugin-sdk/account-resolution";
import { normalizeAccountId } from "openclaw/plugin-sdk/account-id";
import { addOwnerAllowFrom, CHANNEL_ID, listAdemuAccountIds, pruneOwnerAllowFrom } from "./config.js";

export type EnrolledAccountFields = {
  accountId: string;
  agentName: string;
  deviceId: string;
  agentUserId: string;
  ownerUserId: string;
  /** Plaintext token — written into config once (R5: plain string by default, SecretRef-capable). */
  token: string;
  /** R3: also grant the owner `ademu:<ownerUserId>` in commands.ownerAllowFrom. */
  grantOwnerAuthority: boolean;
};

export function applyEnrollment(cfg: OpenClawConfig, fields: EnrolledAccountFields): OpenClawConfig {
  const accountId = normalizeAccountId(fields.accountId);
  const channels = ((cfg as { channels?: Record<string, unknown> }).channels ?? {}) as Record<string, unknown>;
  const channel = (channels[CHANNEL_ID] ?? {}) as Record<string, unknown>;
  const accounts = (channel.accounts ?? {}) as Record<string, unknown>;
  const existing = (accounts[accountId] ?? {}) as Record<string, unknown>;
  const nextAccount = {
    ...existing,
    enabled: true,
    name: fields.agentName,
    agentName: fields.agentName,
    deviceId: fields.deviceId,
    agentUserId: fields.agentUserId,
    ownerUserId: fields.ownerUserId,
    token: fields.token,
  };
  let next = {
    ...cfg,
    channels: {
      ...channels,
      [CHANNEL_ID]: { ...channel, enabled: true, accounts: { ...accounts, [accountId]: nextAccount } },
    },
  } as OpenClawConfig;
  if (fields.grantOwnerAuthority) next = addOwnerAllowFrom(next, fields.ownerUserId);
  return next;
}

/**
 * R3 Rider B (logout): forget the device credentials of ONE account (token, deviceId, agentUserId,
 * ownerUserId) and prune the owner's `ademu:<ownerUserId>` entry when no other account shares that
 * owner. The account block itself stays (name, daemon settings) so "connect an already-enrolled
 * agent" can refill it; the token remains valid daemon-side until `adc token revoke`.
 */
export function clearAccountCredentials(cfg: OpenClawConfig, accountId: string): OpenClawConfig {
  const id = normalizeAccountId(accountId);
  const channels = ((cfg as { channels?: Record<string, unknown> }).channels ?? {}) as Record<string, unknown>;
  const channel = (channels[CHANNEL_ID] ?? {}) as Record<string, unknown>;
  const accounts = (channel.accounts ?? {}) as Record<string, Record<string, unknown>>;
  const existing = accounts[id];
  if (!existing) return cfg;
  const owner = typeof existing.ownerUserId === "string" ? existing.ownerUserId : undefined;
  const { token: _t, deviceId: _d, agentUserId: _a, ownerUserId: _o, ...rest } = existing;
  const next = {
    ...cfg,
    channels: { ...channels, [CHANNEL_ID]: { ...channel, accounts: { ...accounts, [id]: rest } } },
  } as OpenClawConfig;
  return pruneOwnerAllowFrom(next, owner, listAdemuAccountIds(next).filter((other) => other !== id));
}

/** True when `accountId` already names a configured Ademú account (the tool refuses to overwrite). */
export function accountExists(cfg: OpenClawConfig, accountId: string): boolean {
  const id = normalizeAccountId(accountId);
  return listAdemuAccountIds(cfg).includes(id);
}
