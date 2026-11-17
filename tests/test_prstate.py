import json
import subprocess
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import Request, urlopen

import server
from prstate import PrStateError, PrStates, parse_state, run_gh
from tests.test_server import NOW, SECRET, sign

URL = "https://github.com/o/r/pull/48"
OPEN = '{"state":"OPEN","isDraft":false}'


def fake_gh(outputs, calls=None):
    def run(url):
        if calls is not None:
            calls.append(url)
        out = outputs[url]
        if isinstance(out, Exception):
            raise out
        return out
    return run


class ParseStateTests(unittest.TestCase):
    def test_states(self):
        self.assertEqual(parse_state(OPEN), "open")
        self.assertEqual(parse_state('{"state":"OPEN","isDraft":true}'), "draft")
        self.assertEqual(parse_state('{"state":"MERGED","isDraft":false}'), "merged")
        self.assertEqual(parse_state('{"state":"CLOSED","isDraft":false}'), "closed")

    def test_bad_output_is_none(self):
        for text in ("", "not json", "[]", "{}", '{"state":"WEIRD"}', '{"state":3}', "null"):
            self.assertIsNone(parse_state(text), text)


class PrStatesTests(unittest.TestCase):
    def test_each_state_and_failures_give_null_for_that_url_only(self):
        urls = [f"https://github.com/o/r/pull/{n}" for n in range(1, 8)]
        outputs = dict(zip(urls, [
            OPEN, '{"state":"OPEN","isDraft":true}', '{"state":"MERGED"}', '{"state":"CLOSED"}',
            FileNotFoundError("gh"), subprocess.TimeoutExpired("gh", 8), "garbage"]))
        got = PrStates(run=fake_gh(outputs)).states(urls)
        self.assertEqual([got[u] for u in urls], ["open", "draft", "merged", "closed", None, None, None])

    def test_gh_exit_failure_is_null(self):
        err = subprocess.CalledProcessError(1, "gh")
        self.assertEqual(PrStates(run=fake_gh({URL: err})).states([URL]), {URL: None})

    def test_bad_urls_are_refused(self):
        calls = []
        ps = PrStates(run=fake_gh({}, calls))
        bad = ["http://github.com/o/r/pull/1", "https://github.com/o/r/issues/1", "https://evil.com/o/r/pull/1",
               "https://github.com/o/r/pull/1 --web", "https://github.com/o/r/pull/1/files", "https://github.com/o/r/pull/0",
               "https://github.com/o/r/pull/1?x=1", "-h", "", 5, None]
        for url in bad:
            with self.assertRaises(PrStateError, msg=repr(url)):
                ps.states([URL, url])
        with self.assertRaises(PrStateError):
            ps.states("nope")
        self.assertEqual(calls, [])

    def test_too_many_urls_are_refused(self):
        urls = [f"https://github.com/o/r/pull/{n}" for n in range(1, 12)]
        with self.assertRaises(PrStateError):
            PrStates(run=fake_gh({})).states(urls)

    def test_cache_hit_within_ttl_then_refresh(self):
        calls, now = [], [0.0]
        ps = PrStates(run=fake_gh({URL: OPEN}, calls), clock=lambda: now[0], ttl=60)
        ps.states([URL])
        now[0] = 59
        ps.states([URL, URL])
        self.assertEqual(calls, [URL])
        now[0] = 61
        ps.states([URL])
        self.assertEqual(calls, [URL, URL])

    def test_failure_is_cached_too(self):
        calls = []
        ps = PrStates(run=fake_gh({URL: OSError("no gh")}, calls), clock=lambda: 0.0)
        ps.states([URL])
        ps.states([URL])
        self.assertEqual(calls, [URL])

    def test_empty_list(self):
        self.assertEqual(PrStates(run=fake_gh({})).states([]), {})

    def test_run_gh_uses_an_argument_list_without_a_shell(self):
        seen = {}

        def fake_run(args, **kwargs):
            seen["args"], seen["kwargs"] = args, kwargs
            return subprocess.CompletedProcess(args, 0, stdout=OPEN.encode())
        real, subprocess.run = subprocess.run, fake_run
        try:
            self.assertEqual(run_gh(URL), OPEN)
        finally:
            subprocess.run = real
        self.assertEqual(seen["args"], ["gh", "pr", "view", URL, "--json", "state,isDraft"])
        self.assertFalse(seen["kwargs"].get("shell", False))
        self.assertEqual(seen["kwargs"]["timeout"], 8)


class PrStatesRouteTests(unittest.TestCase):
    def post(self, body, signed=True, outputs=None):
        state = server.RuntimeState([], None, "config", False, "/app/config.json", "/tmp/data", SECRET, clock=lambda: NOW)
        ps = PrStates(run=fake_gh(outputs or {}))
        httpd = server.ThreadingHTTPServer(("127.0.0.1", 0), server.make_handler(state, None, ps))
        self.addCleanup(httpd.server_close)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        path = "/api/apps/epic-board/pr-states"
        raw = body if isinstance(body, bytes) else json.dumps(body).encode()
        headers = {"Content-Type": "application/json", "X-KiroCrew-Proxy": sign("POST", path, raw) if signed else ""}
        try:
            with urlopen(Request(f"http://127.0.0.1:{httpd.server_port}{path}", data=raw, headers=headers, method="POST")) as r:
                return r.status, json.load(r)
        except HTTPError as failure:
            return failure.code, json.load(failure)

    def test_answers_states(self):
        status, body = self.post({"urls": [URL]}, outputs={URL: '{"state":"CLOSED"}'})
        self.assertEqual((status, body), (200, {"states": {URL: "closed"}}))

    def test_gh_failure_is_still_200_with_null(self):
        status, body = self.post({"urls": [URL]}, outputs={URL: OSError("no gh")})
        self.assertEqual((status, body), (200, {"states": {URL: None}}))

    def test_bad_url_is_400(self):
        self.assertEqual(self.post({"urls": ["https://evil.com/o/r/pull/1"]})[0], 400)

    def test_bad_body_is_400(self):
        for body in (b"nope", {"urls": 3}, {"urls": [], "x": 1}, {}):
            self.assertEqual(self.post(body)[0], 400, body)

    def test_unsigned_is_refused(self):
        self.assertEqual(self.post({"urls": []}, signed=False)[0], 401)


if __name__ == "__main__":
    unittest.main()
