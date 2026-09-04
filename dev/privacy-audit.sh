#!/usr/bin/env bash
# privacy-audit.sh — fails the build when a secret-shaped token appears at a LOG call-site.
#
# Ported from the Ademú monorepo's dev/privacy-audit.sh TS/JS block (slice ADC-CONTROL-TS) and
# extended for this plugin (slice OPENCLAW-ADEMU-1):
#   - banned tokens gain `.detail` (RequestError/ControlError debug text — peer-controlled),
#     `.raw` (unknown device events carry the untouched wire object), qrDataUrl, and the token/words
#     shapes; the pattern is matched LOWERCASED against the call CONTENT only (never the path);
#   - the log-call scope gains OpenClaw's structured logger forms — `log.info(`, `logger.warn(`,
#     `ctx.log?.error(`, `api.logger.debug(`, `runtime.log(`, `runtime.error(` — on top of console.*,
#     process.std{out,err}.write and bare log()/fail() wrappers.
# Multiline calls are joined until their parens balance (string-, comment-, bracket- and escape-
# aware, 10-line cap). The self-test (test/gates/privacy-audit.test.ts) drives this script over a
# bait tree via PRIVACY_AUDIT_TS_ROOT.
set -u
cd "$(dirname "$0")/.."
FAILED=0

TS_PATTERN='password|passphrase|refresh_token|bearer|plaintext|ciphertext|dsn|access_token|api_secret|adc1_|qr_payload|qrpayload|qrdataurl|agent_name|agentname|\.detail([^a-z0-9_]|$)|\.raw([^a-z0-9_]|$)|(^|[^a-z0-9_])token[[:space:]]*[,})+:=]|[.{$]token([^a-z0-9_]|$)|(^|[^a-z0-9_])words[[:space:]]*[,})+:=]|[.{$]words([^a-z0-9_]|$)'
TS_LOG_SCOPE='console\.(log|info|warn|error|debug)\(|process\.std(out|err)\.write\(|(^|[^a-zA-Z_.])(log|fail)\(|(^|[^a-zA-Z_])(log|logger|runtime)[?]?\.(info|warn|error|debug|log)\('
export TS_PATTERN TS_LOG_SCOPE

# Roots: files or directories (unquoted on purpose — several roots). The self-test overrides the
# roots with its bait tree; in default mode the bait tree (test/fixtures) is excluded.
if [ -n "${PRIVACY_AUDIT_TS_ROOT:-}" ]; then
    ROOTS=$PRIVACY_AUDIT_TS_ROOT
    EXCLUDE_FIXTURES=()
else
    ROOTS="src test index.ts setup-entry.ts scripts"
    EXCLUDE_FIXTURES=(-not -path '*fixtures*')
fi

# shellcheck disable=SC2086
TS_HITS=$(find $ROOTS -type f \( -name '*.ts' -o -name '*.mjs' -o -name '*.js' \) \
    -not -path '*/node_modules/*' -not -path '*/dist/*' ${EXCLUDE_FIXTURES[@]+"${EXCLUDE_FIXTURES[@]}"} -not -name '*.d.ts' -print0 2>/dev/null \
  | xargs -0 awk '
      function scanline(s,   i, c, c2, n) {
          n = length(s)
          for (i = 1; i <= n; i++) {
              c = substr(s, i, 1)
              if (mode == "c") {
                  if (c == "*" && substr(s, i + 1, 1) == "/") { mode = ""; i++ }
                  continue
              }
              if (mode == "") {
                  if (c == "\\") { i++; continue }
                  if (c == "/") {
                      c2 = substr(s, i + 1, 1)
                      if (c2 == "/") break
                      if (c2 == "*") { mode = "c"; i++; continue }
                  }
                  if (c == "\"" || c == "\047" || c == "`") mode = c
                  else if (c == "[") { if (depth > 0) bdepth++ }
                  else if (c == "]") { if (bdepth > 0) bdepth-- }
                  else if (c == "(") { if (bdepth == 0) depth++ }
                  else if (c == ")") { if (bdepth == 0) depth-- }
              } else if (c == "\\") i++
              else if (c == mode) mode = ""
          }
      }
      function flushrec() {
          if (collecting && tolower(joined) ~ ENVIRON["TS_PATTERN"]) printf "%s:%d:%s\n", fname, startline, joined
          collecting = 0
      }
      FNR == 1 { flushrec() }
      {
          if (!collecting && $0 ~ ENVIRON["TS_LOG_SCOPE"]) {
              collecting = 1; joined = ""; depth = 0; bdepth = 0; nlines = 0; mode = ""
              startline = FNR; fname = FILENAME
          }
          if (collecting) {
              joined = joined " " $0
              scanline($0); nlines++
              if (depth <= 0 || nlines > 10) flushrec()
          }
      }
      END { flushrec() }')

if [ -n "$TS_HITS" ]; then
    echo "PRIVACY VIOLATIONS (TS/JS log call-sites):"
    echo "$TS_HITS"
    FAILED=1
fi

if [ "$FAILED" -ne 0 ]; then
    exit 1
fi
echo "privacy audit clean"
