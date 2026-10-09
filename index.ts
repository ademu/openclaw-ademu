// Full runtime entry of the Ademú channel plugin (plan T10). `registerFull` reads the plugin's
// manifest config and adds the owner-gated `ademu_enroll` tool (T13) and the `ademu_get_media` tool
// (openclaw-ademu #22).
import { connect as connectSessionReal } from "@ademu/adc-client";
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { ademuPlugin, hostLog, realEnrollmentLeaseDeps } from "./src/channel.js";
import { ademuConfigSchema, CHANNEL_ID } from "./src/config.js";
import { openInBrowser, pageOriginListening, registerEnrollmentPage } from "./src/enrollment-page.js";
import { strings } from "./src/i18n/strings.js";
import { createQr } from "./src/qr.js";
import { applyPluginSettings, getPluginSettings, setAdemuRuntime } from "./src/runtime.js";
import { cancelByHuman, confirmByHuman, type EnrollToolDeps, registerEnrollTool } from "./src/tools/enroll.js";
import { registerMediaTool } from "./src/tools/media.js";

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
      pageListening: pageOriginListening,
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
    // Received files (AdemuMLS #440): the store is resolved per call, so registering touches nothing.
    registerMediaTool(api, {
      saveMediaBuffer: (...args) => api.runtime.channel.media.saveMediaBuffer(...args),
      maxOpenBytes: () => getPluginSettings().mediaMaxOpenMb * 1024 * 1024,
      log: hostLog,
    });
    // The browser enrollment page (QR → words → Yes / No) shares the tool's registry and decision paths.
    registerEnrollmentPage(api, {
      registry,
      qr,
      confirm: (active) => confirmByHuman(active, deps, registry),
      cancel: (active) => cancelByHuman(active, registry),
    });
  },
});
