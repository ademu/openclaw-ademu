"""collect.py — the plugin side of the what's new feed (AdemuMLS #999): plugin_merge events per push to main."""
import io
import json
import os
import sys
import unittest

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, "..", "..", ".."))
sys.path.insert(0, os.path.join(HERE, ".."))

import collect as co  # noqa: E402

REPO = "ademu/openclaw-ademu"


class FakeGH(object):
    """The `GH` surface collect.py uses — get / graphql — over in-memory answers."""

    def __init__(self, gets=None, prs=None):
        self.gets = gets or {}
        self.prs = prs or {}

    def get(self, path):
        if path not in self.gets:
            raise RuntimeError("unexpected GET " + path)
        return self.gets[path]

    def graphql(self, body):
        return {"data": {"repository": {"pullRequest": self.prs[body["variables"]["n"]]}}}


def pr(number, title, body="", types=(), author="DeTapt"):
    nodes = [{"number": 100 + i, "repository": {"nameWithOwner": REPO}, "issueType": {"name": t}} for i, t in enumerate(types)]
    return {"number": number, "title": title, "body": body, "url": "https://github.com/%s/pull/%d" % (REPO, number),
            "author": {"login": author}, "closingIssuesReferences": {"nodes": nodes, "pageInfo": {"hasNextPage": False}}}


def chain(gh, newest_first, base, pulls):
    """A first-parent chain newest_first → base, each commit naming the PRs in `pulls`."""
    for i, c in enumerate(newest_first):
        parent = newest_first[i + 1] if i + 1 < len(newest_first) else base
        gh.gets["repos/%s/commits/%s" % (REPO, c)] = {"parents": [{"sha": parent}]}
        gh.gets["repos/%s/commits/%s/pulls?per_page=100" % (REPO, c)] = pulls.get(c, [])


def merged(number, sha):
    return [{"number": number, "merged_at": "2026-11-03T12:00:00Z", "merge_commit_sha": sha}]


class Text(unittest.TestCase):
    def test_the_shared_goldens(self):
        # the same file as AdemuMLS dev/whats-new/tests/pr_text_golden.json: a plugin PR reads like an AdemuMLS one
        with open(os.path.join(HERE, "pr_text_golden.json"), encoding="utf-8") as f:
            for case in json.load(f):
                self.assertEqual(co.pr_text(case["title"], case["body"]), case["want"], case["title"])


class MinAdc(unittest.TestCase):
    def test_reads_the_tree(self):
        with open(os.path.join(ROOT, "src", "monitor", "attach.ts"), encoding="utf-8") as f:
            self.assertRegex(co.min_adc(f.read()), r"^\d+\.\d+\.\d+$")

    def test_anything_but_one_plain_declaration_is_an_error(self):
        self.assertEqual(co.min_adc('x\nexport const MIN_ADC_VERSION = "1.2.3";\ny'), "1.2.3")
        for bad in ("", 'export const MIN_ADC_VERSION = "1.2";', 'export const MIN_ADC_VERSION = "1.2.3-rc.1";',
                    'export const MIN_ADC_VERSION = "1.2.3";\nexport const MIN_ADC_VERSION = "1.2.4";'):
            with self.assertRaises(ValueError, msg=bad):
                co.min_adc(bad)


class MergeEvents(unittest.TestCase):
    def test_a_batch_push_gives_one_event_per_pr_in_landing_order(self):
        gh = FakeGH(prs={10: pr(10, "feat(1): first", types=("Feature",)),
                         11: pr(11, "fix(2): second (#11)", body="What's new: The second thing works", types=("Bug",))})
        chain(gh, ["c2", "c1"], "c0", {"c1": merged(10, "c1"), "c2": merged(11, "c2")})
        events = co.merge_events(gh, REPO, "c2", "c0", "1.0.0")
        self.assertEqual(events[0], {"kind": "plugin_merge", "pr": 10, "text": "First", "types": ["Feature"], "author": "DeTapt",
                                     "url": "https://github.com/ademu/openclaw-ademu/pull/10", "min_adc": "1.0.0"})
        self.assertEqual([(e["pr"], e["text"], e["types"]) for e in events[1:]], [(11, "The second thing works", ["Bug"])])

    def test_a_pr_named_by_two_commits_is_announced_once(self):
        gh = FakeGH(prs={10: pr(10, "x")})
        chain(gh, ["c2", "c1"], "c0", {"c1": merged(10, "c1"), "c2": merged(10, "c1")})
        self.assertEqual([e["pr"] for e in co.merge_events(gh, REPO, "c2", "c0", "1.0.0")], [10])

    def test_a_push_without_a_pr_or_an_open_one_gives_nothing(self):
        gh = FakeGH()
        chain(gh, ["c1"], "c0", {"c1": [{"number": 9, "merged_at": None, "state": "open"}]})
        self.assertEqual(co.merge_events(gh, REPO, "c1", "c0", "1.0.0"), [])

    def test_a_first_push_reads_only_its_sha(self):
        gh = FakeGH(prs={10: pr(10, "x")}, gets={"repos/%s/commits/c1/pulls?per_page=100" % REPO: merged(10, "c1")})
        self.assertEqual([e["pr"] for e in co.merge_events(gh, REPO, "c1", "0" * 40, "1.0.0")], [10])

    def test_a_before_off_the_chain_is_never_a_partial_batch(self):
        gh = FakeGH(gets={"repos/%s/commits/c1" % REPO: {"parents": []}})
        with self.assertRaises(RuntimeError):
            co.merge_events(gh, REPO, "c1", "elsewhere", "1.0.0")

    def test_main_prints_one_line_per_event(self):
        attach = os.path.join(ROOT, "src", "monitor", "attach.ts")
        gh = FakeGH(prs={10: pr(10, "fix: tab\tthere")})
        chain(gh, ["c1"], "c0", {"c1": merged(10, "c1")})
        out = io.StringIO()
        self.assertEqual(co.main(["--repo", REPO, "--sha", "c1", "--before", "c0", "--attach", attach], gh=gh, out=out), 0)
        lines = out.getvalue().splitlines()
        self.assertEqual(len(lines), 1)
        self.assertEqual(json.loads(lines[0])["text"], "Tab there")


if __name__ == "__main__":
    unittest.main()
