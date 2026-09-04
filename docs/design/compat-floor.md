# Compatibility floor — derived from the plugin's actual OpenClaw imports

`openclaw.compat.pluginApi` and `openclaw.install.minHostVersion` in `package.json` are NOT set by
convention. For every public `openclaw/plugin-sdk/<subpath>` file and every symbol this plugin
imports, the table records the first OpenClaw commit that shipped it *on that barrel* and the earliest
**stable** release tag (`vYYYY.M.PATCH`, cut on release branches) containing that commit. The floor is
the maximum first-release across the table; `test/gates/compat-floor.test.ts` asserts `package.json`
equals it, so a new import forces this table to move.

Derived against the OpenClaw checkout `951c268db0cb` (main, 2026-09-03) from the FINAL import set of
the slice (re-derived 2026-09-04 with `scratchpad/derive-floor.py`: `git log --reverse --diff-filter=A`
for files, `git log --reverse -S<symbol> -- src/plugin-sdk/<subpath>.ts` for symbols, `git tag --contains`
filtered to stable tags). Stable tags in the window: v2026.2.14, v2026.3.{1,2,7,8,22,24,28},
v2026.4.{5,7,11,15,20,23,26}, v2026.5.{2,12,18,27,28}, v2026.6.{1,5,6,8,9,10,11,33,34}, v2026.7.1,
v2026.8.{1,2}, v2026.9.1. The OpenClaw `extended-stable` line is 2026.6.34 (2026-08-04).

## Derived floor: **2026.8.1**

The floor exceeds `extended-stable` (2026.6.34). Extended-stable users can install once that line
passes 2026.8.1 (the next extended-stable cut of a month ≥ 2026.8 carries it). Fifteen items pin it
(bold below); dropping any one does not lower it.

## Subpath files

| subpath | first commit | first stable release |
|---|---|---|
| `account-helpers` | 826c592debf (2026-03-18) | v2026.3.22 |
| `account-id` | 6543ce717ca (2026-02-14) | v2026.2.14 |
| `account-resolution` | ed21b63bb84 (2026-03-02) | v2026.3.2 |
| `agent-scope-runtime` | da4a656cdba (2026-08-08) | **v2026.8.1** |
| `channel-actions` | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-config-helpers` | ad8d766f656 (2026-03-02) | v2026.3.2 |
| `channel-config-schema` | f2bd76cd1a4 (2026-03-16) | v2026.3.22 |
| `channel-contract` | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-core` | 667a54a4b73 (2026-04-04) | v2026.4.5 |
| `channel-inbound` | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-ingress-runtime` | a0fb7fb0454 (2026-05-10) | v2026.5.12 |
| `channel-outbound` | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-policy` | f2bd76cd1a4 (2026-03-16) | v2026.3.22 |
| `channel-secret-basic-runtime` | dfb6c9c9207 (2026-04-07) | v2026.4.7 |
| `channel-setup` | 07d9f725b61 (2026-03-18) | v2026.3.22 |
| `core` | a4850b1b8f2 (2026-03-04) | v2026.3.7 |
| `gateway-runtime` | 9ebe38b6e36 (2026-03-16) | v2026.3.22 |
| `media-runtime` (QR helpers; recorded exception) | 9ebe38b6e36 (2026-03-16) | v2026.3.22 |
| `runtime-store` | 8d7778d1d6c (2026-03-08) | v2026.3.8 |
| `secret-input` | 07d9f725b61 (2026-03-18) | v2026.3.22 |
| `setup` | 53ccc78c636 (2026-03-15) | v2026.3.22 |
| `state-paths` | 9ebe38b6e36 (2026-03-16) | v2026.3.22 |
| `text-chunking` | 56bc9b5058b (2026-02-15) | v2026.2.14 |

## Symbols (runtime values and types; `import type` entries are covered by `tsc`, values by the import gate)

| subpath → symbol | kind | first commit | first stable release |
|---|---|---|---|
| `account-helpers` → `createAccountListHelpers` | value | 826c592debf (2026-03-18) | v2026.3.22 |
| `account-id` → `normalizeAccountId` | value | 6543ce717ca (2026-02-14) | v2026.2.14 |
| `account-id` → `normalizeOptionalAccountId` | value | 41537e93039 (2026-03-02) | v2026.3.1 |
| `account-resolution` → `OpenClawConfig` | type | 9ebe38b6e36 (2026-03-16) | v2026.3.22 |
| `account-resolution` → `resolveAccountEntry` | value | 9ebe38b6e36 (2026-03-16) | v2026.3.22 |
| `agent-scope-runtime` → `resolveAgentConfig` | value | 5ebfbbf8d78 (2026-08-17) | **v2026.8.1** |
| `agent-scope-runtime` → `tryResolveDefaultAgentId` | value | 5ebfbbf8d78 (2026-08-17) | **v2026.8.1** |
| `channel-actions` → `jsonResult` | value | f2d7a825b12 (2026-04-03) | v2026.4.5 |
| `channel-actions` → `optionalPositiveIntegerSchema` | value | 091e15139bd (2026-05-28) | v2026.5.28 |
| `channel-actions` → `readPositiveIntegerParam` | value | b0e9569ebdb (2026-05-28) | v2026.5.28 |
| `channel-actions` → `readReactionParams` | value | f2d7a825b12 (2026-04-03) | v2026.4.5 |
| `channel-actions` → `readStringParam` | value | f2d7a825b12 (2026-04-03) | v2026.4.5 |
| `channel-actions` → `resolveReactionMessageId` | value | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-config-helpers` → `createHybridChannelConfigAdapter` | value | 05603e4e6ce (2026-03-18) | v2026.3.22 |
| `channel-config-schema` → `buildChannelConfigSchema` | value | 0ae3e70a5c6 (2026-03-18) | v2026.3.22 |
| `channel-config-schema` → `buildGroupEntrySchema` | value | 44314c94514 (2026-07-16) | **v2026.8.1** |
| `channel-config-schema` → `buildMultiAccountChannelSchema` | value | 44314c94514 (2026-07-16) | **v2026.8.1** |
| `channel-contract` → `ChannelGatewayContext` | type | e4b5027c5e2 (2026-04-04) | v2026.4.5 |
| `channel-contract` → `ChannelMessageActionAdapter` | type | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-contract` → `ChannelMessageActionName` | type | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-contract` → `ChannelStatusAdapter` | type | 7688b696de2 (2026-04-27) | v2026.4.26 |
| `channel-core` → `ChannelOutboundSessionRouteParams` | type | 667a54a4b73 (2026-04-04) | v2026.4.5 |
| `channel-core` → `ChannelPlugin` | type | 667a54a4b73 (2026-04-04) | v2026.4.5 |
| `channel-core` → `buildChannelOutboundSessionRoute` | value | 667a54a4b73 (2026-04-04) | v2026.4.5 |
| `channel-core` → `createChatChannelPlugin` | value | 667a54a4b73 (2026-04-04) | v2026.4.5 |
| `channel-core` → `defineChannelPluginEntry` | value | 667a54a4b73 (2026-04-04) | v2026.4.5 |
| `channel-core` → `defineSetupPluginEntry` | value | 667a54a4b73 (2026-04-04) | v2026.4.5 |
| `channel-inbound` → `InboundMentionDecision` | type | 625fd5b3e3e (2026-04-07) | v2026.4.7 |
| `channel-inbound` → `buildMentionRegexes` | value | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-inbound` → `createChannelPartialDeliveryError` | value | 17eea1c0ab6 (2026-07-23) | **v2026.8.1** |
| `channel-inbound` → `hasVisibleInboundReplyDispatch` | value | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-inbound` → `matchesMentionPatterns` | value | 62ddc9d9e0d (2026-03-20) | v2026.3.22 |
| `channel-inbound` → `resolveInboundMentionDecision` | value | 625fd5b3e3e (2026-04-07) | v2026.4.7 |
| `channel-ingress-runtime` → `ChannelIngressContextBinding` | type | 97a53a9b35a (2026-08-14) | **v2026.8.1** |
| `channel-ingress-runtime` → `ChannelIngressResolver` | type | a0fb7fb0454 (2026-05-10) | v2026.5.12 |
| `channel-ingress-runtime` → `ResolvedChannelMessageIngress` | type | a0fb7fb0454 (2026-05-10) | v2026.5.12 |
| `channel-ingress-runtime` → `StableChannelIngressIdentityParams` | type | a0fb7fb0454 (2026-05-10) | v2026.5.12 |
| `channel-ingress-runtime` → `createChannelIngressResolver` | value | a0fb7fb0454 (2026-05-10) | v2026.5.12 |
| `channel-ingress-runtime` → `defineStableChannelIngressIdentity` | value | a0fb7fb0454 (2026-05-10) | v2026.5.12 |
| `channel-outbound` → `ChannelIngressMonitorLifecycle` | type | 7562b79465c (2026-07-19) | **v2026.8.1** |
| `channel-outbound` → `ChannelMessageSendResult` | type | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-outbound` → `ChannelMessageSendTextContext` | type | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-outbound` → `DEFAULT_INGRESS_ADOPTION_STALL_MS` | value | 16c14e5bbfc (2026-07-16) | **v2026.8.1** |
| `channel-outbound` → `MessageReceipt` | type | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-outbound` → `bindIngressLifecycleToReplyOptions` | value | 16c14e5bbfc (2026-07-16) | **v2026.8.1** |
| `channel-outbound` → `createChannelMessageReplyPipeline` (alias of `createChannelReplyPipeline`) | value | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-outbound` → `createMessageReceiptFromOutboundResults` | value | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-outbound` → `defineChannelMessageAdapter` | value | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `channel-policy` → `resolveChannelGroupRequireMention` | value | f2bd76cd1a4 (2026-03-16) | v2026.3.22 |
| `channel-secret-basic-runtime` → `createSimpleChannelSecretContract` | value | 10e60fa0ce6 (2026-08-07) | **v2026.8.1** |
| `channel-setup` → `ChannelSetupWizard` | type | 07d9f725b61 (2026-03-18) | v2026.3.22 |
| `core` → `ChannelMessagingAdapter` | type | 826c592debf (2026-03-18) | v2026.3.22 |
| `core` → `OpenClawPluginApi` | type | a4850b1b8f2 (2026-03-04) | v2026.3.7 |
| `core` → `OpenClawPluginToolContext` | type | aa78a0c00e5 (2026-03-20) | v2026.3.22 |
| `core` → `PluginRuntime` | type | a4850b1b8f2 (2026-03-04) | v2026.3.7 |
| `gateway-runtime` → `channelBlockedPatch` | value | f9d9d1225a1 (2026-08-03) | **v2026.8.1** |
| `gateway-runtime` → `channelReadyPatch` | value | f9d9d1225a1 (2026-08-03) | **v2026.8.1** |
| `media-runtime` → `renderQrPngDataUrl` | value | dde90a345a6 (2026-07-16) | **v2026.8.1** |
| `media-runtime` → `renderQrTerminal` | value | dde90a345a6 (2026-07-16) | **v2026.8.1** |
| `runtime-store` → `createPluginRuntimeStore` | value | 8d7778d1d6c (2026-03-08) | v2026.3.8 |
| `secret-input` → `SecretInputStringResolutionMode` | type | 1769fb2aa1d (2026-04-14) | v2026.4.15 |
| `secret-input` → `buildOptionalSecretInputSchema` | value | 07d9f725b61 (2026-03-18) | v2026.3.22 |
| `secret-input` → `resolveSecretInputString` | value | 1769fb2aa1d (2026-04-14) | v2026.4.15 |
| `setup` → `WizardCancelledError` | value | 64bf80d4d50 (2026-03-27) | v2026.3.28 |
| `setup` → `WizardPrompter` | type | 53ccc78c636 (2026-03-15) | v2026.3.22 |
| `state-paths` → `resolveStateDir` | value | 9ebe38b6e36 (2026-03-16) | v2026.3.22 |
| `text-chunking` → `chunkTextForOutbound` | value | 56bc9b5058b (2026-02-15) | v2026.2.14 |

Note on the QR helpers: the functions themselves are older (`renderQrPngDataUrl` v2026.3.24,
`renderQrTerminal` v2026.4.23) but their export from the `media-runtime` barrel dates to
dde90a345a6 (2026-07-16) → v2026.8.1; the barrel is what we import, so the barrel date counts.

## Host runtime / type surfaces (used through `api.runtime`, not imported)

| surface | first commit | first stable release |
|---|---|---|
| `api.runtime.channel.inbound.buildContext` | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `api.runtime.channel.inbound.dispatch` | 8ee945b9070 (2026-08-09) | **v2026.8.1** |
| `api.runtime.channel.routing.resolveAgentRoute` / `commands.*` | 1507a9701b8 (2026-05-27) | v2026.5.27 |
| `api.runtime.config.mutateConfigFile` | 7f3f108521f (2026-04-27) | v2026.4.26 |
| `api.runtime.logging.getChildLogger` | a4850b1b8f2 (2026-03-04) | v2026.3.7 |
| `ChannelPlugin.reload.configPrefixes` | bcbfb357bec (2026-01-14) | v2026.1.15 |
| `ChannelMessageReceiveAckPolicy` (`after_agent_dispatch`) | 8bfabd6bb13 (2026-05-06) | v2026.5.12 |
| `ChannelAccountSnapshot.terminalDisconnect` | e29448df08e (2026-07-05) | v2026.7.1 |
| `ChannelAccountSnapshot.lifecycle` | aa2a5c96f69 (2026-08-01) | **v2026.8.1** |
| manifest `channelConfigs` / `contracts` | 40bd36e35d3 / ba7804df50d (2026-03-27) | v2026.3.28 |
| manifest `skills` | 51a90533874 (2026-01-23) | v2026.1.22 |
| manifest `activation` | 79c3dbecd12 (2026-04-11) | v2026.4.11 |

The trust gate on `api.runtime.state.*` (bundled/official plugins only) is NOT an import of this
plugin — see the design entry, "Option B".
