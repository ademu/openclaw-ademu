// Full runtime entry of the Ademú channel plugin (plan T10). `registerFull` reads the plugin's
// manifest config and adds the owner-gated `ademu_enroll` tool (T13).
import { connect as connectSessionReal } from "@ademu/adc-client";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { ademuPlugin, realEnrollmentLeaseDeps } from "./src/channel.js";
import { ademuConfigSchema, CHANNEL_ID } from "./src/config.js";
import { openInBrowser, registerEnrollmentPage } from "./src/enrollment-page.js";
import { strings } from "./src/i18n/strings.js";
import { createQr } from "./src/qr.js";
import { applyPluginSettings, setAdemuRuntime } from "./src/runtime.js";
import { confirmFromPage, type EnrollToolDeps, registerEnrollTool } from "./src/tools/enroll.js";

export default defineChannelPluginEntry({
  id: CHANNEL_ID,
  name: strings.channelLabel,
  description: strings.channelBlurb,
  plugin: ademuPlugin,
  configSchema: ademuConfigSchema,
  setRuntime: setAdemuRuntime,
  registerFull: (api) => {
    applyPluginSettings(api.pluginConfig);
    const qr = createQr(api.runtime);
    const deps: EnrollToolDeps = {
      lease: realEnrollmentLeaseDeps(),
      connectSession: connectSessionReal,
      qr,
      openUrl: openInBrowser,
      writeConfig: async (mutate) => {
        await api.runtime.config.mutateConfigFile({
          base: "runtime",
          afterWrite: { mode: "auto" },
          mutate: (draft) => {
            // ADDITIVE ONLY: `Object.assign` copies the returned keys onto the host's draft, so a key
            // omitted from the result survives there. Removing a row means returning the shortened
            // array under its key; removing a whole key is not possible on this path (and the tool
            // never needs it — account removal runs through the host's `deleteAccount` write).
            Object.assign(draft, mutate(draft));
          },
        });
      },
    };
    const registry = registerEnrollTool(api, deps);
    // The browser enrollment page (QR → words → Yes) shares the tool's registry and confirm path.
    registerEnrollmentPage(api, {
      registry,
      qr,
      confirm: (active) => confirmFromPage(active, deps, registry),
      cfg: () => api.runtime.config.current() as never,
    });
  },
});
