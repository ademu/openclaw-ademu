#!/usr/bin/env bash
# Headless acceptance (plan T18 / V14): install the packed tarball into an isolated OpenClaw state
# dir, then prove the plugin loads, registers the channel + tool, passes doctor, and exposes both
# skills. No gateway, no model provider, no Ademú network access.
#
# Env: OPENCLAW_HOST_VERSION (default: package.json openclaw.build.openclawVersion), OPENCLAW_BIN
# (default: openclaw on PATH), KEEP_STATE=1 to keep the temp state dir.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

OPENCLAW_BIN="${OPENCLAW_BIN:-openclaw}"
STATE="$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/oc-ademu-XXXXXX")"
export OPENCLAW_STATE_DIR="$STATE/state"
export OPENCLAW_HOME="$STATE/home"
mkdir -p "$OPENCLAW_STATE_DIR" "$OPENCLAW_HOME"
cleanup() { if [ "${KEEP_STATE:-0}" != "1" ]; then rm -rf "$STATE"; fi; }
trap cleanup EXIT

echo "== host: $($OPENCLAW_BIN --version 2>/dev/null || echo unknown)"
echo "== state: $OPENCLAW_STATE_DIR"


echo "== pack"
archive="$(npm pack --silent --ignore-scripts)"
echo "archive: $archive"

echo "== install (npm-pack, forced, capabilities accepted)"
"$OPENCLAW_BIN" plugins install "npm-pack:./$archive" --force --accept-capabilities

# Seed one dummy Ademú account AFTER the install (before it, "channels.ademu" is an unknown channel id
# and the CLI refuses the invalid config); activation is what exposes the skills.
cfg="$OPENCLAW_STATE_DIR/openclaw.json"
[ -f "$cfg" ] || echo '{}' > "$cfg"
jq '.channels.ademu = {
      enabled: true,
      accounts: { ci: {
        enabled: true, agentName: "CI Agent",
        deviceId: "00000000-0000-4000-8000-000000000001",
        agentUserId: "00000000-0000-4000-8000-000000000002",
        ownerUserId: "00000000-0000-4000-8000-000000000003",
        token: "adc1_ci_dummy_token_not_real" } } }' "$cfg" > "$cfg.tmp" && mv "$cfg.tmp" "$cfg"

echo "== inspect --runtime --json"
inspect_json="$("$OPENCLAW_BIN" plugins inspect ademu --runtime --json)"
echo "$inspect_json" > "${INSPECT_OUT:-/dev/null}"
echo "$inspect_json" | head -c 1500; echo
status="$(echo "$inspect_json" | jq -r '.plugin.status // .status // empty')"
[ "$status" = "loaded" ] || { echo "FAIL: plugin status is '$status', expected loaded"; exit 1; }
echo "$inspect_json" | jq -e '[.. | objects | select(.kind? == "channel") | .ids[]?] | index("ademu") != null' >/dev/null \
  || { echo "FAIL: channel 'ademu' not registered"; exit 1; }
echo "$inspect_json" | jq -e '[.. | objects | .names? // empty | .[]?] | index("ademu_enroll") != null' >/dev/null \
  || { echo "FAIL: tool 'ademu_enroll' not registered"; exit 1; }
echo "plugin loaded; channel + tool registered"

echo "== plugins doctor --json"
"$OPENCLAW_BIN" plugins doctor --json >/dev/null

echo "== skills"
if skills_json="$("$OPENCLAW_BIN" skills list --json 2>/dev/null)"; then
  for skill in ademu ademu-enroll; do
    echo "$skills_json" | jq -e --arg s "$skill" '[.. | objects | select(.name? == $s)] | length > 0' >/dev/null \
      || { echo "FAIL: skill '$skill' not listed"; exit 1; }
  done
  echo "skills listed: ademu, ademu-enroll"
else
  # Fallback (R8): the plugin-skills symlinks under the state dir.
  for skill in ademu ademu-enroll; do
    [ -e "$OPENCLAW_STATE_DIR/plugin-skills/$skill" ] || [ -e "$OPENCLAW_STATE_DIR/plugin-skills/ademu/$skill" ] \
      || { echo "FAIL: skill '$skill' not linked under plugin-skills"; exit 1; }
  done
  echo "skills linked under plugin-skills"
fi

echo "ACCEPTANCE PASS"
