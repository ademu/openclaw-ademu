// Decision 7 gate: the plugin may import only public, current OpenClaw plugin-sdk subpaths, and
// every RUNTIME-VALUE symbol it imports must exist in the INSTALLED `openclaw` (the as-shipped
// tarball; under the nightly beta job this is the first thing that turns red). Type-only imports
// are covered by `tsc --noEmit`, not here.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = new URL("../..", import.meta.url).pathname;

/** Public, typed, current subpaths this plugin is allowed to import. */
export const ALLOWED_SUBPATHS = new Set([
  "core",
  "channel-core",
  "channel-contract",
  "channel-inbound",
  "channel-outbound",
  "channel-ingress-runtime",
  "channel-policy",
  "channel-actions",
  "channel-config-helpers",
  "channel-config-schema",
  "channel-setup",
  "setup",
  "gateway-runtime",
  "routing",
  "runtime-store",
  "agent-scope-runtime",
  "secret-input",
  "secret-input-runtime",
  "channel-secret-basic-runtime",
  "text-chunking",
  "string-coerce-runtime",
  "runtime-env",
  "account-id",
  "account-helpers",
  "account-resolution",
  "config-contracts",
  "state-paths",
  "command-auth",
  // The ONE recorded exception: the QR helpers have no focused subpath (design entry, V2).
  "media-runtime",
]);

/** Removal-pending, deprecated shims, or private-local — never importable by this plugin. */
export const FORBIDDEN_SUBPATHS = new Set([
  "channel-lifecycle",
  "channel-message",
  "channel-reply-pipeline",
  "config-runtime",
  "infra-runtime",
  "inbound-reply-dispatch",
  "security-runtime",
  "retry-runtime",
  "reply-reference",
  "channel-mention-gating",
  "channel-config-writes",
  "plugin-state-runtime",
  "bundled-channel-config-schema",
  "channel-test-helpers",
  "plugin-test-api",
]);

const ENTRY_FILES = ["index.ts", "setup-entry.ts"];

function listTs(path: string): string[] {
  if (!existsSync(path)) return [];
  const st = statSync(path);
  if (st.isFile()) return path.endsWith(".ts") ? [path] : [];
  return readdirSync(path).flatMap((name) => listTs(join(path, name)));
}

type ImportRecord = {
  file: string;
  subpath: string;
  typeOnly: boolean;
  names: string[];
};

const IMPORT_RE =
  /import\s+(type\s+)?(?:(\*\s+as\s+\w+)|(\{[^}]*\})|(\w+))?\s*(?:,\s*(\{[^}]*\}))?\s*from\s*["']openclaw\/plugin-sdk\/([^"']+)["']/g;
const DYNAMIC_RE = /import\(\s*["']openclaw\/plugin-sdk\/([^"']+)["']\s*\)/g;

function collectImports(): ImportRecord[] {
  const files = [
    ...ENTRY_FILES.map((f) => join(ROOT, f)).filter(existsSync),
    ...listTs(join(ROOT, "src")),
  ];
  const records: ImportRecord[] = [];
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const m of text.matchAll(IMPORT_RE)) {
      const typeOnly = Boolean(m[1]);
      const braces = (m[3] ?? m[5] ?? "").replace(/[{}]/g, "");
      const names = braces
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
        .filter((s) => !s.startsWith("type "))
        .map((s) => s.split(/\s+as\s+/)[0]!.trim());
      records.push({ file: relative(ROOT, file), subpath: m[6]!, typeOnly, names });
    }
    for (const m of text.matchAll(DYNAMIC_RE)) {
      records.push({ file: relative(ROOT, file), subpath: m[1]!, typeOnly: false, names: [] });
    }
  }
  return records;
}

describe("SDK import gate", () => {
  const records = collectImports();

  it("imports only allowlisted public subpaths", () => {
    const bad = records.filter((r) => !ALLOWED_SUBPATHS.has(r.subpath));
    expect(
      bad.map((r) => `${r.file}: openclaw/plugin-sdk/${r.subpath}`),
      "non-allowlisted plugin-sdk subpath imported",
    ).toEqual([]);
  });

  it("never imports a removal-pending or private subpath", () => {
    const bad = records.filter((r) => FORBIDDEN_SUBPATHS.has(r.subpath));
    expect(bad.map((r) => `${r.file}: ${r.subpath}`)).toEqual([]);
  });

  it("never touches the trust-gated api.runtime.state surface (K2c)", () => {
    const files = [...ENTRY_FILES.map((f) => join(ROOT, f)).filter(existsSync), ...listTs(join(ROOT, "src"))];
    const hits: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          if (/runtime\.state\.(open|register)/.test(line) || /openChannelIngressQueue|openKeyedStore|openSyncKeyedStore|openBlobStore/.test(line)) {
            hits.push(`${relative(ROOT, file)}:${i + 1}`);
          }
        });
    }
    expect(hits).toEqual([]);
  });

  it("every runtime-value import exists in the installed openclaw", async () => {
    const missing: string[] = [];
    const bySubpath = new Map<string, Set<string>>();
    for (const r of records) {
      if (r.typeOnly) continue;
      const set = bySubpath.get(r.subpath) ?? new Set<string>();
      for (const n of r.names) set.add(n);
      bySubpath.set(r.subpath, set);
    }
    for (const [subpath, names] of bySubpath) {
      let mod: Record<string, unknown>;
      try {
        const spec = `openclaw/plugin-sdk/${subpath}`;
        mod = (await import(/* @vite-ignore */ spec)) as Record<string, unknown>;
      } catch (err) {
        missing.push(`openclaw/plugin-sdk/${subpath}: subpath not importable (${(err as Error).constructor.name})`);
        continue;
      }
      for (const name of names) {
        if (!(name in mod) || mod[name] === undefined) {
          missing.push(`openclaw/plugin-sdk/${subpath}: ${name}`);
        }
      }
    }
    expect(missing, "symbols missing from the installed openclaw").toEqual([]);
  });
});
