#!/usr/bin/env node
// Regenerates `channelConfigs.ademu.schema` in openclaw.plugin.json from the ONE source of truth —
// the zod schema in src/config.ts (via the built dist). The parity gate (test/config.test.ts) fails
// when the manifest drifts; run `npm run build && node scripts/sync-manifest-schema.mjs` to resync.
import { readFileSync, writeFileSync } from "node:fs";
import { z } from "zod";
import { AdemuChannelSchema } from "../dist/src/config.js";

const manifestPath = new URL("../openclaw.plugin.json", import.meta.url);
const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
const schema = z.toJSONSchema(AdemuChannelSchema, { unrepresentable: "any", io: "input" });
delete schema.$schema;
manifest.channelConfigs.ademu.schema = schema;
writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
console.log("openclaw.plugin.json: channelConfigs.ademu.schema regenerated from src/config.ts");
