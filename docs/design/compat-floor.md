# Compatibility floor — derived from the plugin's actual OpenClaw imports

`openclaw.compat.pluginApi` and `openclaw.install.minHostVersion` in `package.json` are NOT set by
convention. For every public `openclaw/plugin-sdk/<subpath>` file and every symbol this plugin
imports, the table records the first OpenClaw commit that shipped it and the earliest **stable**
release tag (`vYYYY.M.PATCH`, cut on release branches) containing that commit. The floor is the
maximum first-release across the table; `test/gates/compat-floor.test.ts` asserts `package.json`
equals it, so a new import forces this table to move.

Derived against the OpenClaw checkout `951c268db0cb` (main, 2026-09-03) with
`git log --diff-filter=A` (files) / `git log -S<symbol>` (symbols) and `git tag --contains`.
Stable tags that exist in the window: v2026.6.{1,5,6,8,9,10,11,33,34}, v2026.7.1, v2026.8.{1,2},
v2026.9.1. The OpenClaw `extended-stable` line is 2026.6.34 (2026-08-04).

## Derived floor: **2026.8.1**

The floor exceeds `extended-stable` (2026.6.34). Extended-stable users can install once that line
passes 2026.8.1 (the next extended-stable cut of a month ≥ 2026.8 carries it).

## Subpath files

| subpath | first commit | first stable release |
|---|---|---|
| `core` | a4850b1b8f2 (2026-03-03) | v2026.3.7 |
| `channel-core` | 667a54a4b73 (2026-04-04) | v2026.4.5 |
| `channel-contract` | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-inbound` | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-outbound` | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-ingress-runtime` | a0fb7fb0454 (2026-05-10) | v2026.5.12 |
| `channel-policy` | f2bd76cd1a4 (2026-03-16) | v2026.3.22 |
| `channel-actions` | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-config-helpers` | ad8d766f656 (2026-03-02) | v2026.3.2 |
| `channel-config-schema` | f2bd76cd1a4 (2026-03-16) | v2026.3.22 |
| `channel-setup` | 07d9f725b61 (2026-03-18) | v2026.3.22 |
| `setup` | 07d9f725b61 (2026-03-18) | v2026.3.22 |
| `gateway-runtime` | 9ebe38b6e36 (2026-03-16) | v2026.3.22 |
| `routing` | 7964563299b (2026-03-16) | v2026.3.22 |
| `runtime-store` | 8d7778d1d6c (2026-03-08) | v2026.3.8 |
| `agent-scope-runtime` | da4a656cdba (2026-08-08) | **v2026.8.1** |
| `secret-input` | 07d9f725b61 (2026-03-18) | v2026.3.22 |
| `secret-input-runtime` | 757c2cc2deb (2026-03-18) | v2026.3.22 |
| `channel-secret-basic-runtime` | dfb6c9c9207 (2026-04-07) | v2026.4.7 |
| `text-chunking` | 56bc9b5058b (2026-02-15) | v2026.2.14 |
| `string-coerce-runtime` | 418056f7a0c (2026-04-17) | v2026.4.20 |
| `runtime-env` | 9ebe38b6e36 (2026-03-16) | v2026.3.22 |
| `account-id` | 6543ce717ca (2026-02-14) | v2026.2.14 |
| `media-runtime` (QR helpers; recorded exception) | 6f6468027a2 (2026-03-24) | v2026.3.24 |

## Symbols

| subpath → symbol | first commit | first stable release |
|---|---|---|
| `channel-outbound` → `bindIngressLifecycleToReplyOptions` | 16c14e5bbfc (2026-07-17) | **v2026.8.1** |
| `channel-outbound` → `createChannelMessageReplyPipeline` (alias of `createChannelReplyPipeline`) | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-outbound` → `createTypingCallbacks` | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-outbound` → `defineChannelMessageAdapter` | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-outbound` → `verifyChannelMessageReceiveAckPolicyAdapterProofs` | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-outbound` → `verifyDurableFinalCapabilityProofs` | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-outbound` → `createAccountStatusSink` | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-outbound` → `waitUntilAbort` | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-ingress-runtime` → `createChannelIngressResolver` | a0fb7fb0454 (2026-05-10) | v2026.5.12 |
| `channel-ingress-runtime` → `resolveStableChannelMessageIngress` | a0fb7fb0454 (2026-05-10) | v2026.5.12 |
| `channel-ingress-runtime` → `defineStableChannelIngressIdentity` | a0fb7fb0454 (2026-05-10) | v2026.5.12 |
| `channel-inbound` → `resolveInboundMentionDecision` | 625fd5b3e3e (2026-04-07) | v2026.4.7 |
| `channel-inbound` → `buildMentionRegexes` | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-inbound` → `buildChannelInboundEventContext` | 07f05e972e2 (2026-05-17) | v2026.5.18 |
| `channel-inbound` → `dispatchChannelInboundTurn` | 0e792b6de30 (2026-07-17) | **v2026.8.1** |
| `channel-inbound` → `hasVisibleInboundReplyDispatch` | (re-derive at execution) | ≤ v2026.8.1 |
| `gateway-runtime` → `channelReadyPatch` / `channelBlockedPatch` | f9d9d1225a1 (2026-08-03) | **v2026.8.1** |
| `channel-core` → `defineChannelPluginEntry` / `defineSetupPluginEntry` / `createChatChannelPlugin` / `buildChannelOutboundSessionRoute` | 667a54a4b73 (2026-04-04) | v2026.4.5 |
| `channel-policy` → `resolveChannelGroupRequireMention` | f2bd76cd1a4 (2026-03-16) | v2026.3.22 |
| `channel-actions` → `resolveReactionMessageId` | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-actions` → `readReactionParams` | f2d7a825b12 (2026-04-03) | v2026.4.5 |
| `channel-actions` → `optionalPositiveIntegerSchema` | 091e15139bd (2026-05-28) | v2026.5.28 |
| `channel-config-helpers` → `createHybridChannelConfigAdapter` | 05603e4e6ce (2026-03-18) | v2026.3.22 |
| `channel-config-helpers` → `resolveChannelConfigWrites` | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-config-schema` → `buildMultiAccountChannelSchema` / `buildGroupEntrySchema` | 44314c94514 (2026-07-16) | **v2026.8.1** |
| `channel-config-schema` → `buildChannelConfigSchema` | 0ae3e70a5c6 (2026-03-18) | v2026.3.22 |
| `channel-config-schema` → `buildJsonChannelConfigSchema` | a3564ae546f (2026-05-02) | v2026.5.2 |
| `channel-secret-basic-runtime` → `createChannelSecretTargetRegistryEntries` | 83bf0379c9d (2026-07-13) | **v2026.8.1** |
| `secret-input` → `buildOptionalSecretInputSchema` | 07d9f725b61 (2026-03-18) | v2026.3.22 |
| `secret-input-runtime` → `resolveConfiguredSecretInputString` | 4336a7f3a9c (2026-04-27) | v2026.4.26 |
| `agent-scope-runtime` → `resolveAgentConfig` | 5ebfbbf8d78 (2026-08-17) | **v2026.8.1** |
| `agent-scope-runtime` → `tryResolveDefaultAgentId` | da4a656cdba (2026-08-08) | **v2026.8.1** |
| `runtime-store` → `createPluginRuntimeStore` | 8d7778d1d6c (2026-03-08) | v2026.3.8 |
| `media-runtime` → `renderQrPngDataUrl` | 6f6468027a2 (2026-03-24) | v2026.3.24 |
| `media-runtime` → `renderQrTerminal` | ea25d7ed5bd (2026-04-23) | v2026.4.23 |

## Host runtime / type surfaces

| surface | first commit | first stable release |
|---|---|---|
| `api.runtime.channel.inbound.buildContext` | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `api.runtime.channel.inbound.dispatch` | 8ee945b9070 (2026-08-09) | **v2026.8.1** |
| `api.runtime.config.mutateConfigFile` | 7f3f108521f (2026-04-27) | v2026.4.26 |
| `ChannelPlugin.reload.configPrefixes` | bcbfb357bec (2026-01-14) | v2026.1.15 |
| `ChannelMessageReceiveAckPolicy` (`after_agent_dispatch`) | 8bfabd6bb13 (2026-05-06) | v2026.5.12 |
| `ChannelAccountSnapshot.terminalDisconnect` | e29448df08e (2026-07-05) | v2026.7.1 |
| `ChannelAccountSnapshot.lifecycle` | aa2a5c96f69 (2026-08-01) | **v2026.8.1** |
| manifest `channelConfigs` / `contracts` | 40bd36e35d3 / ba7804df50d (2026-03-27) | v2026.3.28 |
| manifest `skills` | 51a90533874 (2026-01-23) | v2026.1.22 |
| manifest `activation` | 79c3dbecd12 (2026-04-11) | v2026.4.11 |

The trust gate on `api.runtime.state.*` (bundled/official plugins only) is NOT an import of this
plugin — see the design entry, "Option B".
