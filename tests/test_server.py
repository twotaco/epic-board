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
import projects as proj
import server
from chats import ChatStore
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


class LoadFolderTests(unittest.TestCase):
    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def write_config(self, text):
        with open(os.path.join(self.dir, "config.json"), "w") as f:
            f.write(text)

    def load(self, **env):
        return server.load_folder(env, self.dir)

    def test_environment_value(self):
        self.assertEqual(self.load(EPIC_BOARD_FOLDER=" f_8c1 "), ("f_8c1", None))

    def test_file_value(self):
        self.write_config('{"repository": "/r", "folder_id": "f_file"}')
        self.assertEqual(self.load(), ("f_file", None))

    def test_environment_wins_over_file(self):
        self.write_config('{"folder_id": "f_file"}')
        self.assertEqual(self.load(EPIC_BOARD_FOLDER="f_env"), ("f_env", None))

    def test_empty_environment_uses_file(self):
        self.write_config('{"folder_id": "f_file"}')
        self.assertEqual(self.load(EPIC_BOARD_FOLDER=""), ("f_file", None))

    def test_nothing_set_is_not_set_and_not_an_error(self):
        self.assertEqual(self.load(), (None, None))
        self.write_config('{"repository": "/r"}')
        self.assertEqual(self.load(), (None, None))

    def test_blank_environment_does_not_fall_through(self):
        self.write_config('{"folder_id": "f_file"}')
        folder, reason = self.load(EPIC_BOARD_FOLDER="   ")
        self.assertIsNone(folder)
        self.assertIn("EPIC_BOARD_FOLDER", reason)

    def test_bad_folder_id_in_the_file(self):
        for text in ('{"folder_id": 3}', '{"folder_id": ""}', '{"folder_id": "  "}', '{"folder_id": null}',
                     '{"folder_id": ["a"]}', '{"folder_id": "%s"}' % ("x" * 201)):
            self.write_config(text)
            folder, reason = self.load()
            self.assertIsNone(folder, text)
            self.assertIn("folder_id", reason)

    def test_unreadable_config_gives_no_folder_with_a_reason_and_never_raises(self):
        for text in ("not json", "[]", '"x"'):
            self.write_config(text)
            folder, reason = self.load()
            self.assertIsNone(folder, text)
            self.assertIn("config.json", reason)

    def test_does_not_change_the_repository_setting(self):
        self.write_config('{"repository": "/from/file", "folder_id": 3}')
        self.assertEqual(server.load_repository({}, self.dir), ("/from/file", None))
        self.assertIsNone(self.load()[0])


class DataDirTests(unittest.TestCase):
    def test_uses_home_and_app_name(self):
        self.assertEqual(server.data_dir({"KIROCREW_HOME": "/h", "KIROCREW_APP_NAME": "epic-board"}),
                         "/h/apps/epic-board/data")

    def test_defaults(self):
        self.assertEqual(server.data_dir({}), os.path.join(os.path.expanduser("~"), ".kiro", "crew", "apps", "epic-board", "data"))
        self.assertEqual(server.data_dir({"KIROCREW_HOME": "", "KIROCREW_APP_NAME": ""}), server.data_dir({}))

    def test_a_name_that_could_name_a_path_is_not_used(self):
        for name in ("..", ".", "a/b", "../x", "a\\b", "a b"):
            self.assertEqual(server.data_dir({"KIROCREW_HOME": "/h", "KIROCREW_APP_NAME": name}),
                             "/h/apps/epic-board/data", name)


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
        if holder is not None:
            settings = proj.Project(id="p", name="Project", repository=self.checkout,
                                    folder=None, folder_reason=None, records_file="chats.json")
            rp = server.RunningProject(settings, holder, None)
            running = [rp]
        else:
            running = []
        state = server.RuntimeState(running, error, 'config', False, "/app/config.json", "/tmp/data", "")
        httpd = server.make_server(0, state)
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


SECRET = "test-secret"
NOW = 1_800_000_000


def sign(method, target, body=b"", secret=SECRET, stamp=NOW):
    import hashlib
    import hmac
    digest = hashlib.sha256(body).hexdigest()
    mac = hmac.new(secret.encode(), f"{stamp}:{method}:{target}:{digest}".encode(), hashlib.sha256).hexdigest()
    return f"{stamp}:{mac}"


def fake_plan_body():
    return {"branch": "main", "groups": [
        {"epic": None, "cards": [{"name": "s", "status": "in progress",
                                  "tasks": {"done": 1, "total": 2}, "spec": "s",
                                  "description": "", "id": "#s", "epic": None}]}
    ]}


class FakeHolder:
    def __init__(self, answer=("plan", None)):
        self.answer, self.calls = answer, 0

    def request(self):
        self.calls += 1
        kind, value = self.answer
        return (kind, fake_plan_body() if kind == "plan" and value is None else value)


class PickProjectTests(unittest.TestCase):
    def p(self, id_):
        return proj.Project(id=id_, name=id_.title(), repository=f"/r/{id_}", folder=None,
                            folder_reason=None, records_file=f"chats-{id_}.json")

    def pick(self, projects, **query_parts):
        from urllib.parse import urlencode
        qs = {k: v for k, v in query_parts.items()}
        from urllib.parse import parse_qs
        query = {k: [v] if not isinstance(v, list) else v for k, v in qs.items()}
        return server.pick_project(projects, query)

    def test_no_project_key_returns_first(self):
        ps = [self.p("alpha"), self.p("beta")]
        rp, err = server.pick_project(ps, {})
        self.assertEqual(rp.id, "alpha")
        self.assertIsNone(err)

    def test_no_project_key_returns_none_for_empty_list(self):
        rp, err = server.pick_project([], {})
        self.assertIsNone(rp)
        self.assertIsNone(err)

    def test_project_key_finds_by_id(self):
        ps = [self.p("alpha"), self.p("beta")]
        rp, err = server.pick_project(ps, {"project": ["beta"]})
        self.assertEqual(rp.id, "beta")
        self.assertIsNone(err)

    def test_unknown_id_is_404(self):
        ps = [self.p("alpha")]
        rp, err = server.pick_project(ps, {"project": ["unknown"]})
        self.assertIsNone(rp)
        status, body = err
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "project_not_found")

    def test_empty_value_is_404(self):
        ps = [self.p("alpha")]
        rp, err = server.pick_project(ps, {"project": [""]})
        self.assertIsNone(rp)
        self.assertEqual(err[0], 404)

    def test_multiple_project_values_is_400(self):
        ps = [self.p("alpha")]
        rp, err = server.pick_project(ps, {"project": ["alpha", "alpha"]})
        self.assertIsNone(rp)
        self.assertEqual(err[0], 400)
        self.assertEqual(err[1]["error"]["code"], "invalid_request")


def _make_running(id_, holder, store, folder="f_1", folder_reason=None, secret=SECRET):
    settings = proj.Project(id=id_, name=id_.title(), repository=f"/r/{id_}",
                            folder=folder, folder_reason=folder_reason,
                            records_file=f"chats-{id_}.json")
    chats = server.ChatService(store, folder, folder_reason, secret, holder, clock=lambda: NOW)
    return server.RunningProject(settings, holder, chats)


class ProjectsRouteTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.data = os.path.join(self.root, "data")

    def _make_server(self, running, error=None):
        rp_list = running if running else []
        state = server.RuntimeState(rp_list, error, 'config', False, "/app/config.json", self.data, SECRET)
        router = server.ChatRouter(rp_list, SECRET, clock=lambda: NOW) if rp_list else None
        httpd = server.make_server(0, state, router)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        self.addCleanup(httpd.server_close)
        return httpd

    def get(self, httpd, path):
        try:
            with urlopen(f"http://127.0.0.1:{httpd.server_port}{path}") as r:
                return r.status, json.load(r)
        except HTTPError as e:
            return e.code, json.load(e)

    def test_two_projects_returns_id_name_and_worktree(self):
        rp1 = _make_running("alpha", FakeHolder(), ChatStore(self.data, filename="chats-alpha.json"))
        rp2 = _make_running("beta", FakeHolder(), ChatStore(self.data, filename="chats-beta.json"))
        httpd = self._make_server([rp1, rp2])
        status, body = self.get(httpd, "/api/projects")
        self.assertEqual(status, 200)
        self.assertEqual(body, [{"id": "alpha", "name": "Alpha", "worktree": True},
                                 {"id": "beta", "name": "Beta", "worktree": True}])

    def test_empty_project_list_returns_empty_list(self):
        httpd = self._make_server(None)
        status, body = self.get(httpd, "/api/projects")
        self.assertEqual(status, 200)
        self.assertEqual(body, [])

    def test_no_signature_needed(self):
        rp = _make_running("p", FakeHolder(), ChatStore(self.data, filename="chats-p.json"))
        httpd = self._make_server([rp])
        status, body = self.get(httpd, "/projects")
        self.assertEqual(status, 200)

    def test_post_to_projects_is_404(self):
        rp = _make_running("p", FakeHolder(), ChatStore(self.data, filename="chats-p.json"))
        httpd = self._make_server([rp])
        import urllib.request
        req = urllib.request.Request(f"http://127.0.0.1:{httpd.server_port}/projects",
                                     data=b"", method="POST")
        try:
            urllib.request.urlopen(req)
            self.fail("Expected 404")
        except HTTPError as e:
            self.assertEqual(e.code, 404)

    def test_no_repository_path_in_body(self):
        rp = _make_running("p", FakeHolder(), ChatStore(self.data, filename="chats-p.json"))
        httpd = self._make_server([rp])
        _, body = self.get(httpd, "/projects")
        self.assertNotIn("/r/", json.dumps(body))


class MultiProjectTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.data = os.path.join(self.root, "data")
        os.makedirs(self.data)

    def _make_server(self, rps, error=None):
        rp_list = rps if rps else []
        state = server.RuntimeState(rp_list, error, 'config', False, "/app/config.json", self.data, SECRET)
        router = server.ChatRouter(rp_list, SECRET, clock=lambda: NOW) if rp_list else None
        httpd = server.make_server(0, state, router)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        self.addCleanup(httpd.server_close)
        return httpd

    def get(self, httpd, path):
        try:
            with urlopen(f"http://127.0.0.1:{httpd.server_port}{path}") as r:
                return r.status, json.load(r)
        except HTTPError as e:
            return e.code, json.load(e)

    def test_plan_routes_to_correct_holder(self):
        h1 = FakeHolder(("plan", None))
        h2 = FakeHolder(("error", {"code": "ref_unreadable", "message": "bad"}))
        rp1 = _make_running("alpha", h1, ChatStore(self.data, filename="chats-alpha.json"))
        rp2 = _make_running("beta", h2, ChatStore(self.data, filename="chats-beta.json"))
        httpd = self._make_server([rp1, rp2])
        status, body = self.get(httpd, "/plan?project=alpha")
        self.assertEqual(status, 200)
        self.assertEqual(h1.calls, 1)
        self.assertEqual(h2.calls, 0)

    def test_one_projects_error_does_not_affect_other(self):
        h1 = FakeHolder(("plan", None))
        h2 = FakeHolder(("error", {"code": "ref_unreadable", "message": "bad"}))
        rp1 = _make_running("alpha", h1, ChatStore(self.data, filename="chats-alpha.json"))
        rp2 = _make_running("beta", h2, ChatStore(self.data, filename="chats-beta.json"))
        httpd = self._make_server([rp1, rp2])
        # alpha works fine
        s1, b1 = self.get(httpd, "/plan?project=alpha")
        self.assertEqual(s1, 200)
        # beta has an error
        s2, b2 = self.get(httpd, "/plan?project=beta")
        self.assertEqual(s2, 502)
        self.assertEqual(b2["error"]["code"], "ref_unreadable")

    def test_default_project_is_first_when_no_project_param(self):
        h1 = FakeHolder(("plan", None))
        h2 = FakeHolder(("error", {"code": "ref_unreadable", "message": "bad"}))
        rp1 = _make_running("alpha", h1, ChatStore(self.data, filename="chats-alpha.json"))
        rp2 = _make_running("beta", h2, ChatStore(self.data, filename="chats-beta.json"))
        httpd = self._make_server([rp1, rp2])
        status, _ = self.get(httpd, "/plan")
        self.assertEqual(status, 200)
        self.assertEqual(h1.calls, 1)
        self.assertEqual(h2.calls, 0)

    def test_unknown_project_id_is_404(self):
        rp = _make_running("alpha", FakeHolder(), ChatStore(self.data, filename="chats-alpha.json"))
        httpd = self._make_server([rp])
        status, body = self.get(httpd, "/plan?project=unknown")
        self.assertEqual(status, 404)
        self.assertEqual(body["error"]["code"], "project_not_found")

    def test_chats_reservation_in_one_project_does_not_affect_other(self):
        import urllib.request
        # Give each project a card via a fake plan
        plan = fake_plan_body()
        h1 = FakeHolder(("plan", plan))
        h2 = FakeHolder(("plan", plan))
        store1 = ChatStore(self.data, filename="chats-alpha.json", new_name=lambda: "chat-001")
        store2 = ChatStore(self.data, filename="chats-beta.json", new_name=lambda: "chat-002")
        rp1 = _make_running("alpha", h1, store1)
        rp2 = _make_running("beta", h2, store2)
        httpd = self._make_server([rp1, rp2])
        # POST to alpha's chats
        body = json.dumps({"card_id": "#s"}).encode()
        path = f"/api/chats?project=alpha"
        header = sign("POST", path, body)
        req = urllib.request.Request(
            f"http://127.0.0.1:{httpd.server_port}{path}",
            data=body, method="POST",
            headers={"Content-Type": "application/json", "X-KiroCrew-Proxy": header})
        with urllib.request.urlopen(req) as r:
            resp = json.load(r)
        self.assertEqual(resp["card_id"], "#s")
        # Beta's store is untouched
        self.assertEqual(store2.started(), [])

    def test_chats_signature_with_different_project_is_401(self):
        rp1 = _make_running("alpha", FakeHolder(), ChatStore(self.data, filename="chats-alpha.json"))
        rp2 = _make_running("beta", FakeHolder(), ChatStore(self.data, filename="chats-beta.json"))
        httpd = self._make_server([rp1, rp2])
        import urllib.request
        # Sign for project=alpha but send to project=beta
        body = json.dumps({"card_id": "#s"}).encode()
        signed_path = "/api/chats?project=alpha"
        header = sign("POST", signed_path, body)
        actual_path = "/api/chats?project=beta"
        req = urllib.request.Request(
            f"http://127.0.0.1:{httpd.server_port}{actual_path}",
            data=body, method="POST",
            headers={"Content-Type": "application/json", "X-KiroCrew-Proxy": header})
        try:
            urllib.request.urlopen(req)
            self.fail("Expected 401")
        except HTTPError as e:
            self.assertEqual(e.code, 401)

    def test_unreadable_records_file_does_not_affect_other_project(self):
        import urllib.request
        plan = fake_plan_body()
        store1 = ChatStore(self.data, filename="chats-alpha.json")
        store2 = ChatStore(self.data, filename="chats-beta.json", new_name=lambda: "chat-002")
        rp1 = _make_running("alpha", FakeHolder(("plan", plan)), store1)
        rp2 = _make_running("beta", FakeHolder(("plan", plan)), store2)
        httpd = self._make_server([rp1, rp2])
        # Write bad data to alpha's store
        os.makedirs(self.data, exist_ok=True)
        with open(os.path.join(self.data, "chats-alpha.json"), "w") as f:
            f.write("not json")
        # GET alpha chats → chats_unreadable
        path = "/api/chats?project=alpha"
        header = sign("GET", path)
        req = urllib.request.Request(
            f"http://127.0.0.1:{httpd.server_port}{path}",
            headers={"X-KiroCrew-Proxy": header})
        try:
            urllib.request.urlopen(req)
            self.fail("Expected error")
        except HTTPError as e:
            self.assertIn(e.code, (500,))
        # Beta's chats route still works
        path2 = "/api/chats?project=beta"
        header2 = sign("GET", path2)
        req2 = urllib.request.Request(
            f"http://127.0.0.1:{httpd.server_port}{path2}",
            headers={"X-KiroCrew-Proxy": header2})
        with urllib.request.urlopen(req2) as r:
            resp = json.load(r)
        self.assertIn("chats", resp)


class ServerPropertyTests(unittest.TestCase):
    """Property 1: A project's answers come from that project only.
    Property 3: Single repository behaves as before.
    Property 4: The signature covers the project."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.data = os.path.join(self.root, "data")
        os.makedirs(self.data)

    def _router(self, rps):
        return server.ChatRouter(rps, SECRET, clock=lambda: NOW)

    def _pick_error_code(self, rps, project_id):
        from urllib.parse import parse_qs
        query = parse_qs(f"project={project_id}", keep_blank_values=True)
        settings = [rp.settings for rp in rps]
        rp, err = server.pick_project(settings, query)
        if err:
            return err[0]
        return None

    def test_property1_project_answers_come_from_that_project_only(self):
        import random
        for seed in range(100):
            rng = random.Random(seed)
            n = rng.randint(2, 5)
            holders = [FakeHolder() for _ in range(n)]
            stores = [ChatStore(self.data, filename=f"chats-p{i}.json") for i in range(n)]
            rps = [_make_running(f"p{i}", holders[i], stores[i]) for i in range(n)]
            # Pick a random project
            chosen = rng.randint(0, n - 1)
            settings = [rp.settings for rp in rps]
            from urllib.parse import parse_qs
            q = parse_qs(f"project=p{chosen}", keep_blank_values=True)
            rp, err = server.pick_project(settings, q)
            self.assertIsNone(err, f"seed={seed}")
            self.assertEqual(rp.id, f"p{chosen}", f"seed={seed}")
            # Calling the holder for p{chosen} should not call others
            matched = next(r for r in rps if r.id == f"p{chosen}")
            matched.holder.request()
            for i, h in enumerate(holders):
                if i == chosen:
                    self.assertEqual(h.calls, 1, f"seed={seed}, project=p{chosen}")
                else:
                    self.assertEqual(h.calls, 0, f"seed={seed}, project=p{i} should not be called")

    def test_property3_single_repository_routes_same_with_no_project_param(self):
        import random
        for seed in range(100):
            rng = random.Random(seed)
            h = FakeHolder()
            rp = _make_running("p0", h, ChatStore(self.data, filename="chats-p0.json"))
            settings = [rp.settings]
            # No project param → picks first
            rp_none, err_none = server.pick_project(settings, {})
            self.assertIsNone(err_none, f"seed={seed}")
            self.assertEqual(rp_none.id, "p0", f"seed={seed}")
            # With project=p0 → same project
            from urllib.parse import parse_qs
            q = parse_qs("project=p0", keep_blank_values=True)
            rp_id, err_id = server.pick_project(settings, q)
            self.assertIsNone(err_id, f"seed={seed}")
            self.assertEqual(rp_id.id, "p0", f"seed={seed}")

    def test_property4_signature_covers_project_query(self):
        import random
        for seed in range(100):
            rng = random.Random(seed)
            n = rng.randint(2, 4)
            stores = [ChatStore(self.data, filename=f"chats-q{i}.json") for i in range(n)]
            rps = [_make_running(f"q{i}", FakeHolder(), stores[i]) for i in range(n)]
            router = self._router(rps)
            # Sign for q0
            body = b""
            path_q0 = f"/api/chats?project=q0"
            header = sign("GET", path_q0, body)
            # Use same signature but with project=q1 → should be unauthorized
            if n > 1:
                path_q1 = f"/api/chats?project=q1"
                status, resp = router.handle("GET", path_q1, header, body)
                self.assertEqual(status, 401, f"seed={seed}: expected 401 for tampered project")
            # Same path as signed → should proceed (get to verify signature step)
            status_ok, _ = router.handle("GET", path_q0, header, body)
            # 200 (got chats list) or some other non-401 code
            self.assertNotEqual(status_ok, 401, f"seed={seed}: original path must pass sig check")


class SetupRouteTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.data = os.path.join(self.root, "data")
        os.makedirs(self.data)
        # A real git checkout for POST /setup tests.
        import subprocess
        self.repo = os.path.join(self.root, "repo")
        subprocess.run(["git", "init", "-q", "-b", "main", self.repo], check=True)

    def _make_state(self, running=None, source='config', config_has_projects=False):
        rp_list = running or []
        return server.RuntimeState(rp_list, None, source, config_has_projects,
                                   "/app/config.json", self.data, SECRET, clock=lambda: NOW)

    def _make_server(self, state):
        httpd = server.make_server(0, state)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        self.addCleanup(httpd.server_close)
        return httpd

    def get(self, httpd, path):
        try:
            with urlopen(f"http://127.0.0.1:{httpd.server_port}{path}") as r:
                return r.status, json.load(r)
        except HTTPError as e:
            return e.code, json.load(e)

    def post(self, httpd, path, body_dict, header="", signed=False):
        """Make a POST request. If `signed=True`, sign the body for `path` using SECRET/NOW."""
        import urllib.request
        body = json.dumps(body_dict).encode()
        h = sign("POST", path, body) if signed else header
        req = urllib.request.Request(
            f"http://127.0.0.1:{httpd.server_port}{path}",
            data=body, method="POST",
            headers={"Content-Type": "application/json", "X-KiroCrew-Proxy": h})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except HTTPError as e:
            return e.code, json.load(e)

    # --- GET /setup ---

    def test_get_setup_returns_source_config_has_projects_and_projects(self):
        settings = proj.Project(id="p", name="Project", repository="/r/p",
                                folder="f_1", folder_reason=None, records_file="chats.json")
        rp = server.RunningProject(settings, None, None)
        state = self._make_state([rp], source='config', config_has_projects=False)
        httpd = self._make_server(state)
        status, body = self.get(httpd, "/api/setup")
        self.assertEqual(status, 200)
        self.assertEqual(body["source"], "config")
        self.assertIs(body["config_has_projects"], False)
        self.assertEqual(len(body["projects"]), 1)
        self.assertEqual(body["projects"][0]["id"], "p")
        self.assertEqual(body["projects"][0]["folder_id"], "f_1")

    def test_get_setup_unconfigured_returns_empty_projects(self):
        state = self._make_state([], source='unconfigured')
        httpd = self._make_server(state)
        status, body = self.get(httpd, "/api/setup")
        self.assertEqual(status, 200)
        self.assertEqual(body["source"], "unconfigured")
        self.assertEqual(body["projects"], [])

    def test_get_setup_no_signature_needed(self):
        state = self._make_state()
        httpd = self._make_server(state)
        status, _ = self.get(httpd, "/setup")
        self.assertEqual(status, 200)

    # --- POST /setup ---

    def test_post_setup_missing_signature_is_401(self):
        state = self._make_state()
        httpd = self._make_server(state)
        status, body = self.post(httpd, "/api/setup",
                                 {"projects": [{"folder_id": "f_1", "name": "P",
                                                "repository": self.repo}]})
        self.assertEqual(status, 401)

    def test_post_setup_bad_signature_is_401(self):
        state = self._make_state()
        httpd = self._make_server(state)
        status, body = self.post(httpd, "/api/setup",
                                 {"projects": [{"folder_id": "f_1", "name": "P",
                                                "repository": self.repo}]},
                                 header="bad:signature")
        self.assertEqual(status, 401)

    def test_post_setup_body_not_a_list_is_400(self):
        state = self._make_state()
        httpd = self._make_server(state)
        status, _ = self.post(httpd, "/api/setup", {"projects": "oops"}, signed=True)
        self.assertEqual(status, 400)

    def test_post_setup_too_many_entries_is_400(self):
        entries = [{"folder_id": "f_1", "name": f"P{i}", "repository": self.repo} for i in range(21)]
        state = self._make_state()
        httpd = self._make_server(state)
        status, _ = self.post(httpd, "/api/setup", {"projects": entries}, signed=True)
        self.assertEqual(status, 400)

    def test_post_setup_missing_folder_id_is_400(self):
        state = self._make_state()
        httpd = self._make_server(state)
        status, body = self.post(httpd, "/api/setup",
                                 {"projects": [{"name": "P", "repository": self.repo}]},
                                 signed=True)
        self.assertEqual(status, 400)

    def test_post_setup_name_over_100_chars_is_400(self):
        state = self._make_state()
        httpd = self._make_server(state)
        status, _ = self.post(httpd, "/api/setup",
                              {"projects": [{"folder_id": "f_1", "name": "x" * 101,
                                             "repository": self.repo}]},
                              signed=True)
        self.assertEqual(status, 400)

    def test_post_setup_repo_not_a_checkout_is_400(self):
        state = self._make_state()
        httpd = self._make_server(state)
        plain = os.path.join(self.root, "plain")
        os.makedirs(plain)
        status, _ = self.post(httpd, "/api/setup",
                              {"projects": [{"folder_id": "f_1", "name": "P",
                                             "repository": plain}]},
                              signed=True)
        self.assertEqual(status, 400)

    def test_post_setup_happy_path_saves_and_returns_200(self):
        state = self._make_state()
        httpd = self._make_server(state)
        status, body = self.post(httpd, "/api/setup",
                                 {"projects": [{"folder_id": "f_1", "name": "Alpha",
                                                "repository": self.repo}]},
                                 signed=True)
        self.assertEqual(status, 200)
        self.assertIn("projects", body)
        setup_path = os.path.join(self.data, "setup.json")
        self.assertTrue(os.path.exists(setup_path))

    def test_post_setup_400_does_not_write_file(self):
        state = self._make_state()
        httpd = self._make_server(state)
        self.post(httpd, "/api/setup",
                  {"projects": [{"name": "P", "repository": self.repo}]}, signed=True)
        self.assertFalse(os.path.exists(os.path.join(self.data, "setup.json")))

    def test_post_setup_snapshot_reflects_new_projects(self):
        state = self._make_state()
        httpd = self._make_server(state)
        self.post(httpd, "/api/setup",
                  {"projects": [{"folder_id": "f_1", "name": "Alpha",
                                 "repository": self.repo}]},
                  signed=True)
        snap = state.snapshot()
        self.assertEqual(len(snap), 1)
        self.assertEqual(snap[0].name, "Alpha")

    def test_post_setup_existing_project_keeps_running_project(self):
        """A project that stays in the list should reuse the same RunningProject object."""
        settings = proj.Project(id="alpha", name="Alpha", repository=self.repo,
                                folder="f_1", folder_reason=None, records_file="chats-alpha.json")
        from chats import ChatStore
        store = ChatStore(self.data, filename="chats-alpha.json")
        rp = server.RunningProject(settings, None, server.ChatService(store, "f_1", None, SECRET, None))
        state = server.RuntimeState([rp], None, 'saved', False, "/app/config.json", self.data, SECRET)
        httpd = self._make_server(state)
        self.post(httpd, "/api/setup",
                  {"projects": [{"folder_id": "f_1", "name": "Alpha",
                                 "repository": self.repo}]},
                  signed=True)
        snap = state.snapshot()
        # The id stays "alpha"; same RunningProject is reused.
        self.assertEqual(snap[0].id, "alpha")
        self.assertIs(snap[0], rp)


class SetupEndToEndTests(unittest.TestCase):
    """End-to-end: start unconfigured, POST /setup, verify /plan and /chats work without restart."""

    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        # Real git checkout with a commit and remote (same pattern as ServeTests).
        origin = os.path.join(self.root, "o.git")
        seed = os.path.join(self.root, "seed")
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
        self.data = os.path.join(self.root, "data")
        os.makedirs(self.data)

    def _make_server(self, state):
        """Start a real HTTP server with the given state. ChatRouter reads from state live."""
        router = server.ChatRouter(state, SECRET, clock=lambda: NOW)
        httpd = server.make_server(0, state, router)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        self.addCleanup(httpd.server_close)
        return httpd

    def get(self, httpd, path, header=""):
        import urllib.request
        headers = {"X-KiroCrew-Proxy": header} if header else {}
        req = urllib.request.Request(f"http://127.0.0.1:{httpd.server_port}{path}", headers=headers)
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except HTTPError as e:
            return e.code, json.load(e)

    def post(self, httpd, path, body_dict, signed=False):
        import urllib.request
        body = json.dumps(body_dict).encode()
        h = sign("POST", path, body) if signed else ""
        req = urllib.request.Request(
            f"http://127.0.0.1:{httpd.server_port}{path}",
            data=body, method="POST",
            headers={"Content-Type": "application/json", "X-KiroCrew-Proxy": h})
        try:
            with urllib.request.urlopen(req) as r:
                return r.status, json.load(r)
        except HTTPError as e:
            return e.code, json.load(e)

    def _wait_for_plan(self, httpd, project_id, timeout=10):
        """Poll /plan until non-202 or timeout. Returns (status, body)."""
        import time as _time
        deadline = _time.time() + timeout
        while _time.time() < deadline:
            status, body = self.get(httpd, f"/plan?project={project_id}")
            if status != 202:
                return status, body
            _time.sleep(0.1)
        return 202, {}

    def test_plan_and_chats_work_after_first_save_no_restart(self):
        """Fresh install: unconfigured → POST /setup → /plan 200 and /chats 200, no restart."""
        # Use an empty app dir so load_projects returns the real "not configured" error.
        app_dir = os.path.join(self.root, "app")
        os.makedirs(app_dir)
        projs, problem, source, chp = proj.load_projects(app_dir=app_dir, data_dir=self.data)
        config_path = os.path.join(app_dir, "config.json")
        state = server.RuntimeState(projs, problem, source, chp,
                                    config_path, self.data, SECRET, clock=lambda: NOW)
        httpd = self._make_server(state)

        # Before setup: /plan returns 409 (no repository configured).
        status, body = self.get(httpd, "/plan")
        self.assertEqual(status, 409)
        self.assertEqual(body["error"]["code"], "repository_not_configured")

        # POST /setup with the real checkout.
        path = "/api/setup"
        status, body = self.post(httpd, path,
                                 {"projects": [{"folder_id": "f_1", "name": "Alpha",
                                                "repository": self.checkout}]},
                                 signed=True)
        self.assertEqual(status, 200, body)
        self.assertEqual(len(body["projects"]), 1)
        project_id = body["projects"][0]["id"]

        # /plan must eventually return the plan (holder starts in background thread).
        status, plan_body = self._wait_for_plan(httpd, project_id)
        self.assertEqual(status, 200, plan_body)
        self.assertIn("groups", plan_body)

        # GET /chats (signed) must return 200 with the folder_id we saved.
        chats_path = f"/api/chats?project={project_id}"
        header = sign("GET", chats_path)
        status, chats_body = self.get(httpd, chats_path, header=header)
        self.assertEqual(status, 200, chats_body)
        self.assertEqual(chats_body["folder_id"], "f_1")

    def test_changing_project_folder_takes_effect_without_restart(self):
        """Saving the same project with a different folder is reflected immediately in /chats."""
        app_dir = os.path.join(self.root, "app2")
        os.makedirs(app_dir)
        projs, problem, source, chp = proj.load_projects(app_dir=app_dir, data_dir=self.data)
        config_path = os.path.join(app_dir, "config.json")
        state = server.RuntimeState(projs, problem, source, chp,
                                    config_path, self.data, SECRET, clock=lambda: NOW)
        httpd = self._make_server(state)

        # First save with folder f_1.
        path = "/api/setup"
        status, body = self.post(httpd, path,
                                 {"projects": [{"folder_id": "f_1", "name": "Alpha",
                                                "repository": self.checkout}]},
                                 signed=True)
        self.assertEqual(status, 200, body)
        project_id = body["projects"][0]["id"]

        # Verify folder is f_1.
        chats_path = f"/api/chats?project={project_id}"
        header = sign("GET", chats_path)
        _, chats_body = self.get(httpd, chats_path, header=header)
        self.assertEqual(chats_body["folder_id"], "f_1")

        # Second save with folder f_2 — same project, different folder.
        status, body = self.post(httpd, path,
                                 {"projects": [{"folder_id": "f_2", "name": "Alpha",
                                                "repository": self.checkout}]},
                                 signed=True)
        self.assertEqual(status, 200, body)

        # /chats must immediately reflect the new folder without a restart.
        _, chats_body = self.get(httpd, chats_path, header=sign("GET", chats_path))
        self.assertEqual(chats_body["folder_id"], "f_2")


class WorktreeServerTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.data = os.path.join(self.root, "data")
        os.makedirs(self.data)

    def _store(self):
        return ChatStore(self.data, new_name=lambda: "epic-board-00000001", clock=lambda: "t")

    def _service(self, store=None, worktree=True, repository="/r/p"):
        s = store or self._store()
        return server.ChatService(s, "f_1", None, SECRET, FakeHolder(), clock=lambda: NOW,
                                  repository=repository, worktree=worktree)

    def _call(self, service, method, path, body=b""):
        h = sign(method, path, body)
        return service.handle(method, path, h, body)

    def _post(self, service, path, body_dict):
        raw = json.dumps(body_dict).encode()
        h = sign("POST", path, raw)
        return service.handle("POST", path, h, raw)

    def test_reserve_with_worktree_calls_create_worktree(self):
        expected_path = "/r/p--epic-board-00000001"
        with mock.patch.object(server, "create_worktree", return_value=(True, None)) as cw:
            status, resp = self._post(self._service(worktree=True), "/chats",
                                      {"card_id": "#s"})
        self.assertEqual(status, 200)
        self.assertEqual(resp["worktree_path"], expected_path)
        cw.assert_called_once_with("/r/p", expected_path, "main")
        self.assertIn("own worktree", resp["brief"])

    def test_reserve_without_worktree_has_null_path(self):
        with mock.patch.object(server, "create_worktree") as cw:
            status, resp = self._post(self._service(worktree=False), "/chats", {"card_id": "#s"})
        self.assertEqual(status, 200)
        self.assertIsNone(resp["worktree_path"])
        cw.assert_not_called()
        self.assertNotIn("own worktree", resp["brief"])

    def test_reserve_worktree_failure_is_409(self):
        with mock.patch.object(server, "create_worktree", return_value=(False, "git error")):
            status, resp = self._post(self._service(worktree=True), "/chats", {"card_id": "#s"})
        self.assertEqual(status, 409)
        self.assertEqual(resp["error"]["code"], "worktree_failed")

    def test_delete_worktree_route_success(self):
        store = self._store()
        record = store.reserve("#s")
        store.update_worktree_path(record["name"], "/parent/p--epic-board-00000001")
        service = server.ChatService(store, "f_1", None, SECRET, FakeHolder(), clock=lambda: NOW,
                                     repository="/r/p", worktree=True)
        with mock.patch.object(server, "remove_worktree", return_value=(True, None)) as rw:
            status, resp = self._call(service, "DELETE",
                                      f"/chats/{record['name']}/worktree")
        self.assertEqual(status, 200)
        self.assertTrue(resp.get("ok"))
        rw.assert_called_once()
        self.assertIsNone(store.get_record(record["name"])["worktree_path"])

    def test_delete_worktree_has_changes_is_409(self):
        store = self._store()
        record = store.reserve("#s")
        store.update_worktree_path(record["name"], "/parent/p--wt")
        service = server.ChatService(store, "f_1", None, SECRET, FakeHolder(), clock=lambda: NOW,
                                     repository="/r/p", worktree=True)
        with mock.patch.object(server, "remove_worktree", return_value=(False, "uncommitted")):
            status, resp = self._call(service, "DELETE",
                                      f"/chats/{record['name']}/worktree")
        self.assertEqual(status, 409)
        self.assertEqual(resp["error"]["code"], "worktree_has_changes")

    def test_delete_worktree_force_param(self):
        store = self._store()
        record = store.reserve("#s")
        store.update_worktree_path(record["name"], "/parent/p--wt")
        service = server.ChatService(store, "f_1", None, SECRET, FakeHolder(), clock=lambda: NOW,
                                     repository="/r/p", worktree=True)
        calls = []
        def fake_remove(repo, path, force=False):
            calls.append(force)
            return True, None
        with mock.patch.object(server, "remove_worktree", fake_remove):
            path = f"/chats/{record['name']}/worktree?force=true"
            h = sign("DELETE", path)
            status, resp = service.handle("DELETE", path, h, b"")
        self.assertEqual(status, 200)
        self.assertTrue(calls[0])

    def test_delete_worktree_null_path_is_200(self):
        store = self._store()
        record = store.reserve("#s")
        service = server.ChatService(store, "f_1", None, SECRET, FakeHolder(), clock=lambda: NOW,
                                     repository="/r/p", worktree=True)
        with mock.patch.object(server, "remove_worktree") as rw:
            status, resp = self._call(service, "DELETE",
                                      f"/chats/{record['name']}/worktree")
        self.assertEqual(status, 200)
        self.assertTrue(resp.get("ok"))
        rw.assert_not_called()

    def test_delete_worktree_unknown_name_is_404(self):
        status, resp = self._call(self._service(), "DELETE", "/chats/no-such-name/worktree")
        self.assertEqual(status, 404)
        self.assertEqual(resp["error"]["code"], "chat_not_found")

    def test_started_stores_worktree_folder_id(self):
        store = self._store()
        record = store.reserve("#s")
        service = server.ChatService(store, "f_1", None, SECRET, FakeHolder(), clock=lambda: NOW)
        name = record["name"]
        status, _ = self._post(service, f"/chats/{name}/started",
                               {"key": "k-1", "worktree_folder_id": "folder-id-001"})
        self.assertEqual(status, 200)
        self.assertEqual(store.get_record(name)["worktree_folder_id"], "folder-id-001")

    def test_started_without_folder_id_stores_null(self):
        store = self._store()
        record = store.reserve("#s")
        service = server.ChatService(store, "f_1", None, SECRET, FakeHolder(), clock=lambda: NOW)
        name = record["name"]
        status, _ = self._post(service, f"/chats/{name}/started", {"key": "k-1"})
        self.assertEqual(status, 200)
        self.assertIsNone(store.get_record(name)["worktree_folder_id"])

    def test_started_bad_worktree_folder_id_is_400(self):
        store = self._store()
        record = store.reserve("#s")
        service = server.ChatService(store, "f_1", None, SECRET, FakeHolder(), clock=lambda: NOW)
        name = record["name"]
        for bad in ("a b", "x" * 194, ""):
            raw = json.dumps({"key": "k-1", "worktree_folder_id": bad}).encode()
            h = sign("POST", f"/chats/{name}/started", raw)
            status, resp = service.handle("POST", f"/chats/{name}/started", h, raw)
            self.assertEqual(status, 400, f"bad={bad!r}")

    def test_get_projects_includes_worktree(self):
        import threading
        from urllib.request import urlopen
        settings = proj.Project(id="p", name="Project", repository="/r/p",
                                folder="f_1", folder_reason=None, records_file="chats.json",
                                worktree=False)
        rp = server.RunningProject(settings, None, None)
        state = server.RuntimeState([rp], None, 'config', False, "/app/config.json", self.data, SECRET)
        httpd = server.make_server(0, state)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        self.addCleanup(httpd.server_close)
        from urllib.error import HTTPError
        try:
            with urlopen(f"http://127.0.0.1:{httpd.server_port}/projects") as r:
                body = json.load(r)
        except HTTPError as e:
            body = json.load(e)
        self.assertEqual(body[0]["worktree"], False)

    def test_get_setup_includes_worktree(self):
        import threading
        from urllib.request import urlopen
        settings = proj.Project(id="p", name="Project", repository="/r/p",
                                folder="f_1", folder_reason=None, records_file="chats.json",
                                worktree=False)
        rp = server.RunningProject(settings, None, None)
        state = server.RuntimeState([rp], None, 'config', False, "/app/config.json", self.data, SECRET)
        httpd = server.make_server(0, state)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        self.addCleanup(httpd.server_close)
        from urllib.error import HTTPError
        try:
            with urlopen(f"http://127.0.0.1:{httpd.server_port}/setup") as r:
                body = json.load(r)
        except HTTPError as e:
            body = json.load(e)
        self.assertEqual(body["projects"][0]["worktree"], False)

    def test_post_setup_accepts_worktree_boolean(self):
        import threading
        from urllib.request import urlopen, Request
        from urllib.error import HTTPError
        repo = os.path.join(self.root, "repo")
        import subprocess
        subprocess.run(["git", "init", "-q", repo], check=True)
        state = server.RuntimeState([], None, 'config', False, "/app/config.json", self.data, SECRET,
                                    clock=lambda: NOW)
        httpd = server.make_server(0, state)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        self.addCleanup(httpd.server_close)
        body = json.dumps({"projects": [{"folder_id": "f_1", "name": "P",
                                         "repository": repo, "worktree": False}]}).encode()
        h = sign("POST", "/setup", body)
        req = Request(f"http://127.0.0.1:{httpd.server_port}/setup",
                      data=body, method="POST",
                      headers={"Content-Type": "application/json", "X-KiroCrew-Proxy": h})
        try:
            with urlopen(req) as r:
                resp = json.load(r)
            status = 200
        except HTTPError as e:
            resp = json.load(e)
            status = e.code
        self.assertEqual(status, 200, resp)

    def test_post_setup_rejects_non_boolean_worktree(self):
        import threading
        from urllib.request import urlopen, Request
        from urllib.error import HTTPError
        repo = os.path.join(self.root, "repo")
        import subprocess
        subprocess.run(["git", "init", "-q", repo], check=True)
        state = server.RuntimeState([], None, 'config', False, "/app/config.json", self.data, SECRET,
                                    clock=lambda: NOW)
        httpd = server.make_server(0, state)
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.shutdown)
        self.addCleanup(httpd.server_close)
        body = json.dumps({"projects": [{"folder_id": "f_1", "name": "P",
                                         "repository": repo, "worktree": "yes"}]}).encode()
        h = sign("POST", "/setup", body)
        req = Request(f"http://127.0.0.1:{httpd.server_port}/setup",
                      data=body, method="POST",
                      headers={"Content-Type": "application/json", "X-KiroCrew-Proxy": h})
        try:
            with urlopen(req) as r:
                resp = json.load(r)
            status = 200
        except HTTPError as e:
            resp = json.load(e)
            status = e.code
        self.assertEqual(status, 400, resp)


if __name__ == "__main__":
    unittest.main()
