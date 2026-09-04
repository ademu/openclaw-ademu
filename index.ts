// Full runtime entry of the Ademú channel plugin (plan T10). `registerFull` adds the owner-gated
// `ademu_enroll` tool (T13) and reads the plugin's manifest config.
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { ademuPlugin } from "./src/channel.js";
import { ademuConfigSchema, CHANNEL_ID } from "./src/config.js";
import { strings } from "./src/i18n/strings.js";
import { applyPluginSettings, setAdemuRuntime } from "./src/runtime.js";

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: strings.channelLabel,
  description: strings.channelBlurb,
  plugin: ademuPlugin,
  configSchema: ademuConfigSchema,
  setRuntime: setAdemuRuntime,
  registerFull: (api) => {
    applyPluginSettings(api.pluginConfig);
  },
});
