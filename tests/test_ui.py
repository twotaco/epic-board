"""Runs the page tests with Node and checks that app.json still declares the app.

The page tests are tests/ui/*.test.mjs. They run with Node's built-in test runner,
so `python3 -m unittest discover -s tests -t .` stays the one command.

PageTests runs `node --test tests/ui/*.test.mjs`, with the file list built here
and passed explicitly. The directory form, `node --test tests/ui/`, is not used:
Node 22 reads the directory as a module path and fails with
"Cannot find module '.../tests/ui'". The explicit list works on Node 22 and later.

PageTests is skipped, with a stated reason, when `node` is not on the path. A skipped
test is not a pass. AppJsonTests needs no Node and always runs.
"""

import glob
import json
import os
import shutil
import subprocess
import unittest

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
UI_TESTS = os.path.join("tests", "ui")
TIMEOUT_SECONDS = 120


@unittest.skipUnless(shutil.which("node"), "node is not installed; the page tests did not run")
class PageTests(unittest.TestCase):
    def test_node_page_tests_pass(self):
        files = sorted(glob.glob(os.path.join(ROOT, UI_TESTS, "*.test.mjs")))
        self.assertTrue(files, "no page tests found in " + UI_TESTS + "/*.test.mjs")
        relative = [os.path.relpath(path, ROOT) for path in files]
        command = ["node", "--test"] + relative
        try:
            done = subprocess.run(command, cwd=ROOT, capture_output=True, text=True,
                                  timeout=TIMEOUT_SECONDS)
        except subprocess.TimeoutExpired as timeout:
            self.fail("%s did not finish in %d seconds\n%s%s" % (
                " ".join(command), TIMEOUT_SECONDS,
                _text(timeout.stdout), _text(timeout.stderr)))
        if done.returncode != 0:
            self.fail("%s exited with %d\n--- stdout ---\n%s\n--- stderr ---\n%s" % (
                " ".join(command), done.returncode, done.stdout, done.stderr))


def _text(value):
    if value is None:
        return ""
    return value.decode("utf-8", "replace") if isinstance(value, bytes) else value


class AppJsonTests(unittest.TestCase):
    def setUp(self):
        with open(os.path.join(ROOT, "app.json"), encoding="utf-8") as handle:
            self.app = json.load(handle)

    def test_name(self):
        self.assertEqual(self.app["name"], "epic-board")

    def test_backend_declarations(self):
        backend = self.app["backend"]
        self.assertEqual(backend["entryPoint"], "backend/server.py")
        self.assertEqual(backend["type"], "python")
        self.assertEqual(backend["healthCheck"], "/health")
        self.assertEqual(backend["routes"], "/api/apps/epic-board")

    def test_one_page_at_the_app_route(self):
        ui = self.app["ui"]
        self.assertEqual(ui["entry"], "index.mjs")
        self.assertEqual([page["route"] for page in ui["pages"]], ["/apps/epic-board"])

    def test_entry_files_exist(self):
        self.assertTrue(os.path.isfile(os.path.join(ROOT, "ui", self.app["ui"]["entry"])))
        self.assertTrue(os.path.isfile(os.path.join(ROOT, self.app["backend"]["entryPoint"])))

    def test_api_permission_is_exactly_the_two_chat_paths(self):
        # start-a-story, Requirement 1, criterion 3
        permissions = self.app.get("permissions", {})
        self.assertIsInstance(permissions, dict)
        self.assertEqual(permissions.get("api"), ["/api/chat", "/api/chat/slots"])

    def test_no_other_permission_is_declared(self):
        permissions = self.app.get("permissions", {})
        self.assertEqual(sorted(permissions), ["api"])
        for name in ("sessionApproval", "chatSlots", "spawn", "agentTurns", "network", "storage"):
            self.assertNotIn(name, permissions)
        self.assertNotIn("memberThreads", permissions)
        self.assertNotIn("events", permissions)

    def test_the_other_declarations_are_kept(self):
        self.assertEqual(self.app["platform"]["os"], ["macos", "linux"])
        self.assertEqual(self.app["backend"]["port"], "auto")


if __name__ == "__main__":
    unittest.main()
