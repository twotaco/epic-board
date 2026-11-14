import contextlib
import io
import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from unittest import mock
from urllib.error import HTTPError
from urllib.request import urlopen

import gitsource
import server
from held import INTERNAL_MESSAGE, Holder
from plan import build_plan


class LoadRepositoryTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def write_config(self, text):
        with open(os.path.join(self.dir, "config.json"), "w") as f:
            f.write(text)

    def load(self, **env):
        return server.load_repository(env, self.dir)

    def test_env_wins_over_file(self):
        self.write_config('{"repository": "/from/file"}')
        self.assertEqual(self.load(EPIC_BOARD_REPOSITORY="/from/env"), ("/from/env", None))

    def test_empty_env_uses_file(self):
        self.write_config('{"repository": "/from/file"}')
        self.assertEqual(self.load(EPIC_BOARD_REPOSITORY=""), ("/from/file", None))

    def test_expands_home_and_makes_absolute(self):
        path, _ = self.load(EPIC_BOARD_REPOSITORY="~/x")
        self.assertEqual(path, os.path.expanduser("~/x"))

    def test_nothing_configured_names_both(self):
        path, error = self.load()
        self.assertIsNone(path)
        self.assertEqual(error["code"], "repository_not_configured")
        self.assertIn("EPIC_BOARD_REPOSITORY", error["message"])
        self.assertIn(os.path.join(self.dir, "config.json"), error["message"])

    def test_bad_config_does_not_fall_through(self):
        for text in ("not json", "[]", '{"repository": 3}', '{"repository": "  "}', "{}"):
            self.write_config(text)
            path, error = self.load()
            self.assertIsNone(path, text)
            self.assertEqual(error["code"], "repository_not_configured")


class ServeTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        origin, seed = os.path.join(self.root, "o.git"), os.path.join(self.root, "seed")
        self.checkout = os.path.join(self.root, "co")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", origin], check=True)
        subprocess.run(["git", "init", "-q", "-b", "main", seed], check=True)
        os.makedirs(seed + "/.kiro/specs/s")
        with open(seed + "/.kiro/specs/s/tasks.md", "w") as f:
            f.write("- [x] 1\n- [ ] 2\n")
        for args in (["add", "."], ["-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "c"],
                     ["remote", "add", "origin", origin], ["push", "-q", "origin", "main"]):
            subprocess.run(["git", "-C", seed, *args], check=True, capture_output=True)
        subprocess.run(["git", "clone", "-q", origin, self.checkout], check=True)

    def holder(self, repository, read=None, open_=None, build=None):
        """A real Holder (real git and plan by default) with a fake clock and a spawn that only queues."""
        self.now, self.jobs = 100.0, []
        return Holder(repository, read or gitsource.read_snapshot, open_ or gitsource.open_snapshot,
                      build or build_plan, clock=lambda: self.now, spawn=self.jobs.append)

    def run_queued(self):
        with contextlib.redirect_stderr(io.StringIO()):  # an unexpected failure prints its traceback
            while self.jobs:
                self.jobs.pop(0)()

    def get(self, holder, error, path):
        httpd = server.make_server(0, holder, error, "/app/config.json")
        self.addCleanup(httpd.server_close)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        try:
            with urlopen(f"http://127.0.0.1:{httpd.server_port}{path}") as response:
                return response.status, json.load(response)
        except HTTPError as failure:
            return failure.code, json.load(failure)

    def test_health_works_without_configuration(self):
        error = {"code": "repository_not_configured", "message": "x"}
        self.assertEqual(self.get(None, error, "/api/apps/epic-board/health"), (200, {"ok": True}))

    def test_first_read_plan_keeps_repository_despite_query(self):
        holder = self.holder(self.checkout)
        holder.first_read()
        status, body = self.get(holder, None, "/api/apps/epic-board/plan?repo=/etc&repository=/tmp")
        self.assertEqual(status, 200)
        self.assertEqual(body["repository"], self.checkout)
        self.assertEqual((body["branch"], body["ref"]), ("main", "origin/main"))
        self.assertEqual(body["fetch"], {"ok": None})
        self.assertIsNone(body["age_seconds"])
        self.assertIn(body["refreshing"], (True, False))
        self.assertEqual(body["problems"], [])
        card = body["groups"][0]["cards"][0]
        self.assertEqual((card["name"], card["status"], card["tasks"]), ("s", "in progress", {"done": 1, "total": 2}))
        self.assertEqual(card["description"], "")

    def test_refreshed_plan_is_fetched_and_age_zero(self):
        holder = self.holder(self.checkout)
        holder.first_read()
        self.get(holder, None, "/plan")  # the request claims the one refresh and queues it
        self.assertEqual(len(self.jobs), 1)
        self.run_queued()
        status, body = self.get(holder, None, "/api/apps/epic-board/plan?repo=/etc&repository=/tmp")
        self.assertEqual(status, 200)
        self.assertEqual(body["repository"], self.checkout)
        self.assertEqual(body["fetch"], {"ok": True})
        self.assertEqual(body["age_seconds"], 0)
        self.assertIs(body["refreshing"], False)
        self.assertEqual(self.jobs, [])

    def test_plan_answer_has_age_seconds_and_refreshing(self):
        fake = gitsource.Snapshot("/r", "main", "9f2c1d0", fetched=True)
        holder = self.holder("/r", read=lambda r: gitsource.Snapshot(r, "main", "9f2c1d0"),
                             open_=lambda r: fake, build=lambda snapshot: ([], []))
        holder.first_read()
        status, body = self.get(holder, None, "/plan")
        self.assertEqual((status, body["age_seconds"], body["refreshing"]), (200, None, True))
        self.run_queued()
        self.now += 7
        status, body = self.get(holder, None, "/plan")
        self.assertEqual((status, body["age_seconds"], body["refreshing"]), (200, 7, False))

    def test_pending_before_first_read_is_202(self):
        holder = self.holder(self.checkout)
        self.assertEqual(self.get(holder, None, "/plan"), (202, {"pending": True}))
        self.assertEqual(self.jobs, [])  # no refresh before the first read ends

    def test_held_ref_unreadable_is_502(self):
        def unreadable(repository):
            raise gitsource.SourceError("ref_unreadable", "Could not read origin/main")
        holder = self.holder("/r", read=unreadable, open_=unreadable)
        holder.first_read()
        self.assertEqual(self.get(holder, None, "/plan")[0], 202)  # nothing held; the refresh decides
        self.run_queued()
        status, body = self.get(holder, None, "/plan")
        self.assertEqual((status, body["error"]["code"]), (502, "ref_unreadable"))

    def test_held_internal_is_500_without_repository_path(self):
        def broken(repository):
            raise RuntimeError(f"boom in {repository}")
        holder = self.holder("/secret/repo", read=broken, open_=broken)
        with contextlib.redirect_stderr(io.StringIO()):  # an unexpected failure prints its traceback
            holder.first_read()
        self.get(holder, None, "/plan")
        self.run_queued()
        status, body = self.get(holder, None, "/plan")
        self.assertEqual((status, body["error"]["code"]), (500, "internal"))
        self.assertEqual(body["error"]["message"], INTERNAL_MESSAGE)
        self.assertNotIn("/secret/repo", json.dumps(body))

    def test_not_configured_is_409_with_both_names(self):
        calls = []

        def record(*args, **kwargs):
            calls.append(args)
            raise AssertionError("a git command ran")
        path, error = server.load_repository({}, self.root)
        with mock.patch.object(gitsource, "run_git", record), mock.patch.object(subprocess, "Popen", record):
            status, body = self.get(None, error, "/plan")
        self.assertEqual(status, 409)
        self.assertNotIn("groups", body)
        self.assertEqual(body["error"]["settings"][0], "EPIC_BOARD_REPOSITORY")
        self.assertEqual(calls, [])  # no holder exists (None was passed), so no read or refresh could start

    def test_not_a_checkout_is_409(self):
        holder = self.holder(self.root)
        holder.first_read()
        status, body = self.get(holder, None, "/plan")
        self.assertEqual((status, body["error"]["code"]), (409, "repository_not_a_checkout"))
        self.assertIn("EPIC_BOARD_REPOSITORY", body["error"]["message"])
        self.assertIn("config.json", body["error"]["message"])

    def test_unknown_path_is_404(self):
        self.assertEqual(self.get(self.holder(self.checkout), None, "/other")[0], 404)


if __name__ == "__main__":
    unittest.main()
