import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from urllib.error import HTTPError
from urllib.request import urlopen

import server


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

    def get(self, repository, error, path):
        httpd = server.make_server(0, repository, error, "/app/config.json")
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

    def test_plan_ignores_repo_in_query(self):
        status, body = self.get(self.checkout, None, "/api/apps/epic-board/plan?repo=/etc&repository=/tmp")
        self.assertEqual(status, 200)
        self.assertEqual(body["repository"], self.checkout)
        self.assertEqual((body["branch"], body["ref"]), ("main", "origin/main"))
        self.assertEqual(body["fetch"], {"ok": True})
        self.assertEqual(body["problems"], [])
        card = body["groups"][0]["cards"][0]
        self.assertEqual((card["name"], card["status"], card["tasks"]), ("s", "in progress", {"done": 1, "total": 2}))

    def test_not_configured_is_409_with_both_names(self):
        path, error = server.load_repository({}, self.root)
        status, body = self.get(path, error, "/plan")
        self.assertEqual(status, 409)
        self.assertNotIn("groups", body)
        self.assertEqual(body["error"]["settings"][0], "EPIC_BOARD_REPOSITORY")

    def test_not_a_checkout_is_409(self):
        status, body = self.get(self.root, None, "/plan")
        self.assertEqual((status, body["error"]["code"]), (409, "repository_not_a_checkout"))
        self.assertIn("EPIC_BOARD_REPOSITORY", body["error"]["message"])
        self.assertIn("config.json", body["error"]["message"])

    def test_unknown_path_is_404(self):
        self.assertEqual(self.get(self.checkout, None, "/other")[0], 404)


if __name__ == "__main__":
    unittest.main()
