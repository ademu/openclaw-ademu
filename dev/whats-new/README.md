# What's new feed (AdemuMLS #999)

After every push to main, `.github/workflows/whats-new.yml` posts one message per merged PR into the team's "Ademú
Releases" group: the PR's `What's new:` line (else its cleaned title), and how to update the plugin and the adc it needs
(`MIN_ADC_VERSION` of the pushed tree).

- `collect.py` — reads GitHub, prints `plugin_merge` events (NDJSON). Its text rule repeats AdemuMLS's
  `dev/whats-new/collect.py`; `tests/pr_text_golden.json` is the same file in both repositories — change both together.
- `ssh-send.sh` — a copy of AdemuMLS's: hands the events to the agent host over SSH (pinned host key).
- On the host, AdemuMLS's `dev/whats-new/announce.py` is this key's forced command with `--source plugin`: it posts a
  `plugin_merge` and refuses every other kind. Set-up and diagnosis: AdemuMLS `RUNBOOK.md` §19.
- `tests/` — `python3 -m unittest discover -s dev/whats-new/tests` (CI's `test` lane runs it).
