// SecretRef contract for the per-account device token (design entry §2 R5): declares
// `channels.ademu.accounts.<id>.token` as a secret target so `openclaw secrets` can plan/configure/
// audit it, and lets the gateway resolve a configured SecretRef into the runtime config snapshot
// before `startAccount` reads it strictly. No root-level token exists (accounts only).
import { createSimpleChannelSecretContract } from "openclaw/plugin-sdk/channel-secret-basic-runtime";

export const channelSecrets = createSimpleChannelSecretContract({
  channelKey: "ademu",
  label: "Ademú",
  accountFields: ["token"],
  channelFields: [],
  mode: "account-inheritance",
});
