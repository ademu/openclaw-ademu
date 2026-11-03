#!/usr/bin/env python3
"""The what's new feed's plugin side (AdemuMLS #999): prints one `plugin_merge` event per PR a push to main landed.

    collect.py --repo R --sha S [--before B] [--attach src/monitor/attach.ts]     NDJSON on stdout

The events go to the Ademú agent host through ssh-send.sh, where AdemuMLS's `dev/whats-new/announce.py` is this key's
forced command with `--source plugin` (it accepts `plugin_merge` and nothing else) and posts each one into the team's
"Ademú Releases" group with how to update the plugin. A PR's text is its `What's new:` line, else its cleaned title — the
rule of AdemuMLS's `collect.py`, repeated here because that repository is private; `tests/pr_text_golden.json` is the same
file in both and pins it. Every PR of one push carries the pushed tree's MIN_ADC_VERSION: the plugin you install from
main after it. Python standard library and the `gh` CLI only."""
import argparse
import json
import re
import subprocess
import sys
from collections import OrderedDict

TEXT_CAP = 280
TYPES = ("Feature", "Bug")
ZERO_SHA = "0" * 40

_CLOSING = ("closingIssuesReferences(first:100,after:$after){nodes{number repository{nameWithOwner} issueType{name}}"
            " pageInfo{hasNextPage endCursor}}")
PR_QUERY = ("query($owner:String!,$name:String!,$n:Int!,$after:String){repository(owner:$owner,name:$name){pullRequest(number:$n)"
            "{number title body url author{login} " + _CLOSING + "}}}")
CLOSING_PAGE_QUERY = ("query($owner:String!,$name:String!,$n:Int!,$after:String){repository(owner:$owner,name:$name)"
                      "{pullRequest(number:$n){" + _CLOSING + "}}}")

# --- the text rule: AdemuMLS dev/whats-new/collect.py, kept identical (tests/pr_text_golden.json) ------------------------

_PREFIX = re.compile(r"^(feat|fix|docs|chore|refactor|test|ci|perf|build|style|revert)(\([^)]*\))?!?:\s*", re.I)
_LEAD_NUM = re.compile(r"^#\d+\s+")
_TRAIL_NUMS = re.compile(r"\s*\(#\d+(?:,\s*#\d+)*\)\s*$")
_COMMENT = re.compile(r"<!--.*?-->", re.S)
_WHATS_NEW = re.compile(r"^\s*what['’]s new:[ \t]*(.*?)\s*$", re.I | re.M)
_CONTROL = re.compile(r"[\x00-\x1f\x7f\u2028\u2029]+")


def clean_title(title):
    t = _TRAIL_NUMS.sub("", _LEAD_NUM.sub("", _PREFIX.sub("", title.strip()))).strip()
    return t[:1].upper() + t[1:]


def _cap(text):
    text = " ".join(_CONTROL.sub(" ", text).split())   # announce.py refuses control characters: never send one
    return text if len(text) <= TEXT_CAP else text[:TEXT_CAP - 1].rstrip() + "…"


def pr_text(title, body):
    """The `What's new:` line of the PR body (outside HTML comments), else the cleaned title."""
    for m in _WHATS_NEW.finditer(_COMMENT.sub("", body or "")):
        if m.group(1):
            return _cap(m.group(1))
    return _cap(clean_title(title))


def pr_types(pull, repo):
    """Feature / Bug from the closing issues in this repository, in that order; anything else gives no tag."""
    names = {(n.get("issueType") or {}).get("name") for n in pull["closingIssuesReferences"]["nodes"]
             if n["repository"]["nameWithOwner"] == repo}
    return [t for t in TYPES if t in names]


# --- GitHub ------------------------------------------------------------------------------------------------------------

class GH(object):
    """`gh api` with the job's GH_TOKEN; a failed call raises (the job fails, nothing half-announced)."""

    def _api(self, args, data=None):
        p = subprocess.run(["gh", "api"] + args, input=data, capture_output=True)
        if p.returncode != 0:
            raise RuntimeError("gh api %s failed (exit %d)" % (args[-1], p.returncode))
        return json.loads(p.stdout.decode("utf-8") or "null")

    def get(self, path):
        return self._api([path])

    def graphql(self, body):
        return self._api(["graphql", "--input", "-"], json.dumps(body).encode("utf-8"))


def push_range(gh, repo, before, sha):
    """The first-parent commits the push introduced, newest first; `before` absent or zero → just `sha`. Never a partial
    range: `before` not met on the first-parent chain raises."""
    if not before or before == ZERO_SHA:
        return [sha]
    out, cur, seen = [], sha, set()
    while cur != before:
        if cur in seen:
            raise RuntimeError("push range %s..%s loops at %s" % (before[:8], sha[:8], cur[:8]))
        seen.add(cur)
        out.append(cur)
        parents = gh.get("repos/%s/commits/%s" % (repo, cur)).get("parents") or []
        if not parents:
            raise RuntimeError("push range %s..%s: `before` is not a first-parent ancestor" % (before[:8], sha[:8]))
        cur = parents[0]["sha"]
    return out


def merged_prs_for(gh, repo, sha, before):
    """Every PR the push merged, deduplicated, in landing order (oldest first)."""
    seen, out = set(), []
    for c in reversed(push_range(gh, repo, before, sha)):
        for p in gh.get("repos/%s/commits/%s/pulls?per_page=100" % (repo, c)) or []:
            if (p.get("merged_at") or (p.get("state") == "closed" and p.get("merge_commit_sha"))) and p["number"] not in seen:
                seen.add(p["number"])
                out.append(p["number"])
    return out


def _pr_query(gh, repo, number, query, after):
    owner, name = repo.split("/", 1)
    body = OrderedDict([("query", query), ("variables", OrderedDict([("owner", owner), ("name", name), ("n", int(number)),
                                                                    ("after", after)]))])
    resp = gh.graphql(body)
    if not isinstance(resp, dict) or resp.get("errors") or not (resp.get("data") or {}).get("repository"):
        raise RuntimeError("pull request #%d: graphql errors" % number)
    return resp["data"]["repository"]["pullRequest"]


def pr_details(gh, repo, number):
    """The PR with its whole closing set: later pages are read too, so a tag is never lost to truncation."""
    pull = _pr_query(gh, repo, number, PR_QUERY, None)
    conn = pull["closingIssuesReferences"]
    info = conn.get("pageInfo") or {}
    while info.get("hasNextPage"):
        page = _pr_query(gh, repo, number, CLOSING_PAGE_QUERY, info["endCursor"])["closingIssuesReferences"]
        conn["nodes"] = conn["nodes"] + page["nodes"]
        info = page.get("pageInfo") or {}
    return pull


# --- the events --------------------------------------------------------------------------------------------------------

_MIN_ADC = re.compile(r'^export const MIN_ADC_VERSION = "((?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3})\.(?:0|[1-9][0-9]{0,3}))";$', re.M)


def min_adc(source):
    """MIN_ADC_VERSION as `src/monitor/attach.ts` declares it; anything else is an error, never a guess."""
    found = _MIN_ADC.findall(source)
    if len(found) != 1:
        raise ValueError("MIN_ADC_VERSION not found exactly once in attach.ts")
    return found[0]


def merge_events(gh, repo, sha, before, minimum):
    events = []
    for number in merged_prs_for(gh, repo, sha, before):
        p = pr_details(gh, repo, number)
        events.append({"kind": "plugin_merge", "pr": p["number"], "text": pr_text(p["title"], p["body"]),
                       "types": pr_types(p, repo), "author": (p.get("author") or {}).get("login") or "",
                       "url": p["url"], "min_adc": minimum})
    return events


def main(argv=None, gh=None, out=sys.stdout):
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--repo", required=True)
    ap.add_argument("--sha", required=True)
    ap.add_argument("--before", default="")
    ap.add_argument("--attach", default="src/monitor/attach.ts")
    args = ap.parse_args(argv)
    with open(args.attach, encoding="utf-8") as f:
        minimum = min_adc(f.read())
    for e in merge_events(gh or GH(), args.repo, args.sha, args.before, minimum):
        out.write(json.dumps(e, ensure_ascii=False, separators=(",", ":")) + "\n")
    return 0


if __name__ == "__main__":
    sys.exit(main())
