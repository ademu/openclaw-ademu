#!/usr/bin/env bash
# dev/whats-new/ssh-send.sh <events.ndjson> — hands the what's new events (AdemuMLS #999) to the agent host over SSH.
# A copy of AdemuMLS dev/whats-new/ssh-send.sh.
# The key's authorized_keys line on the host is a forced command (announce.py, `restrict`): this key can run nothing
# else, and stdin is all it carries. The host key is pinned (never accepted on first use).
#   env: ANNOUNCE_SSH_KEY (secret), ANNOUNCE_HOST (user@host), ANNOUNCE_KNOWN_HOSTS (the host's known_hosts line)
set -euo pipefail
events="${1:?usage: ssh-send.sh <events.ndjson>}"
if [ ! -s "$events" ]; then
  echo "whats-new: no events"
  exit 0
fi
: "${ANNOUNCE_SSH_KEY:?ANNOUNCE_SSH_KEY unset}" "${ANNOUNCE_HOST:?ANNOUNCE_HOST unset}" "${ANNOUNCE_KNOWN_HOSTS:?ANNOUNCE_KNOWN_HOSTS unset}"
dir="$(mktemp -d)"
trap 'rm -rf "$dir"' EXIT
umask 077
printf '%s\n' "$ANNOUNCE_SSH_KEY" > "$dir/key"
printf '%s\n' "$ANNOUNCE_KNOWN_HOSTS" > "$dir/known_hosts"
ssh -T -i "$dir/key" -o IdentitiesOnly=yes -o BatchMode=yes -o StrictHostKeyChecking=yes \
  -o UserKnownHostsFile="$dir/known_hosts" -o ConnectTimeout=20 "$ANNOUNCE_HOST" < "$events"
