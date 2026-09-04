// Full runtime entry of the Ademú channel plugin (plan T10). `registerFull` reads the plugin's
// manifest config and adds the owner-gated `ademu_enroll` tool (T13).
import { connect as connectSessionReal } from "@ademu/adc-client";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { ademuPlugin, realEnrollmentLeaseDeps } from "./src/channel.js";
import { ademuConfigSchema, CHANNEL_ID } from "./src/config.js";
import { strings } from "./src/i18n/strings.js";
import { createQr } from "./src/qr.js";
import { applyPluginSettings, setAdemuRuntime } from "./src/runtime.js";
import { registerEnrollTool } from "./src/tools/enroll.js";

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: strings.channelLabel,
  description: strings.channelBlurb,
  plugin: ademuPlugin,
  configSchema: ademuConfigSchema,
  setRuntime: setAdemuRuntime,
  registerFull: (api) => {
    applyPluginSettings(api.pluginConfig);
    registerEnrollTool(api, {
      lease: realEnrollmentLeaseDeps(),
      connectSession: connectSessionReal,
      qr: createQr(api.runtime),
      writeConfig: async (mutate) => {
        await api.runtime.config.mutateConfigFile({
          base: "runtime",
          afterWrite: { mode: "auto" },
          mutate: (draft) => {
            Object.assign(draft, mutate(draft));
          },
        });
      },
    });
  },
});
