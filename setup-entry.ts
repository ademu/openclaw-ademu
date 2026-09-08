// Lightweight setup-only entry (onboarding, channel status, SecretRef discovery) — plan T10.
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { ademuSetupPlugin } from "./src/setup-plugin.js";

export default defineSetupPluginEntry(ademuSetupPlugin);
