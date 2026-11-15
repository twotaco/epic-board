"""Tests for backend/projects.py: load_projects, check_folder, project ids and file names."""
import json
import os
import random
import shutil
import string
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
import projects as proj
import server
from chats import ChatStore, slugify


class CheckFolderTests(unittest.TestCase):
    def test_valid_values(self):
        self.assertEqual(proj.check_folder("f_abc", "src"), ("f_abc", None))
        self.assertEqual(proj.check_folder("  f_abc  ", "src"), ("f_abc", None))

    def test_none_is_invalid(self):
        folder, reason = proj.check_folder(None, "src")
        self.assertIsNone(folder)
        self.assertIn("src", reason)

    def test_empty_string_is_invalid(self):
        folder, reason = proj.check_folder("", "src")
        self.assertIsNone(folder)
        self.assertIn("src", reason)

    def test_whitespace_only_is_invalid(self):
        folder, reason = proj.check_folder("   ", "src")
        self.assertIsNone(folder)
        self.assertIn("src", reason)

    def test_non_string_is_invalid(self):
        for value in (3, [], True, {}):
            folder, reason = proj.check_folder(value, "src")
            self.assertIsNone(folder, value)
            self.assertIn("src", reason, value)

    def test_too_long_is_invalid(self):
        long_val = "x" * 201
        folder, reason = proj.check_folder(long_val, "src")
        self.assertIsNone(folder)
        self.assertIn("src", reason)

    def test_exactly_200_chars_is_valid(self):
        val = "x" * 200
        folder, reason = proj.check_folder(val, "src")
        self.assertEqual(folder, val)
        self.assertIsNone(reason)


class LoadProjectsSingleTests(unittest.TestCase):
    """Single-project form: no `projects` key; must behave as load_repository + load_folder today."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def write_config(self, text):
        with open(os.path.join(self.dir, "config.json"), "w") as f:
            f.write(text)

    def load(self, **env):
        return proj.load_projects(env, self.dir)

    def test_env_gives_one_project(self):
        projects, error = self.load(EPIC_BOARD_REPOSITORY="/tmp/myrepo")
        self.assertIsNone(error)
        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0].repository, "/tmp/myrepo")

    def test_config_file_gives_one_project(self):
        self.write_config('{"repository": "/tmp/myrepo"}')
        projects, error = self.load()
        self.assertIsNone(error)
        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0].repository, "/tmp/myrepo")

    def test_name_is_last_path_component(self):
        projects, _ = self.load(EPIC_BOARD_REPOSITORY="/tmp/myrepo")
        self.assertEqual(projects[0].name, "myrepo")

    def test_name_is_project_when_path_has_no_base(self):
        projects, _ = self.load(EPIC_BOARD_REPOSITORY="/")
        self.assertEqual(projects[0].name, "Project")

    def test_nothing_configured_returns_error(self):
        projects, error = self.load()
        self.assertEqual(projects, [])
        self.assertIsNotNone(error)
        self.assertEqual(error["code"], "repository_not_configured")

    def test_bad_config_returns_error(self):
        for text in ("not json", "[]", '{"repository": 3}', '{"repository": "  "}', "{}"):
            self.write_config(text)
            projects, error = self.load()
            self.assertEqual(projects, [], text)
            self.assertIsNotNone(error, text)

    def test_records_file_is_chats_json(self):
        projects, _ = self.load(EPIC_BOARD_REPOSITORY="/tmp/myrepo")
        self.assertEqual(projects[0].records_file, "chats.json")

    def test_folder_from_env(self):
        projects, _ = self.load(EPIC_BOARD_REPOSITORY="/r", EPIC_BOARD_FOLDER="f_xyz")
        self.assertEqual(projects[0].folder, "f_xyz")
        self.assertIsNone(projects[0].folder_reason)

    def test_folder_from_config(self):
        self.write_config('{"repository": "/r", "folder_id": "f_file"}')
        projects, _ = self.load()
        self.assertEqual(projects[0].folder, "f_file")

    def test_bad_folder_in_config_gives_reason(self):
        self.write_config('{"repository": "/r", "folder_id": null}')
        projects, error = self.load()
        self.assertIsNone(error)
        self.assertEqual(len(projects), 1)
        self.assertIsNone(projects[0].folder)
        self.assertIsNotNone(projects[0].folder_reason)
        self.assertIn("folder_id", projects[0].folder_reason)

    def test_matches_load_repository_exactly(self):
        """Single project must give the same repository as load_repository."""
        self.write_config('{"repository": "~/x"}')
        projects, _ = self.load()
        repo, _ = server.load_repository({}, self.dir)
        self.assertEqual(projects[0].repository, repo)

    def test_matches_load_folder_exactly(self):
        """Single project must give the same folder as load_folder."""
        self.write_config('{"repository": "/r", "folder_id": "f_file"}')
        projects, _ = self.load()
        folder, reason = server.load_folder({}, self.dir)
        self.assertEqual(projects[0].folder, folder)
        self.assertEqual(projects[0].folder_reason, reason)


class LoadProjectsMultiTests(unittest.TestCase):
    """Multi-project form: config.json has a `projects` key."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def write_config(self, data):
        with open(os.path.join(self.dir, "config.json"), "w") as f:
            json.dump(data, f)

    def load(self, **env):
        return proj.load_projects(env, self.dir)

    def two_projects(self):
        return [{"name": "Alpha", "repository": "/repos/alpha"},
                {"name": "Beta", "repository": "/repos/beta"}]

    def test_basic_two_projects(self):
        self.write_config({"projects": self.two_projects()})
        projects, error = self.load()
        self.assertIsNone(error)
        self.assertEqual(len(projects), 2)
        self.assertEqual(projects[0].name, "Alpha")
        self.assertEqual(projects[1].name, "Beta")

    def test_projects_not_a_list_is_error(self):
        for bad in (None, {}, "x", 3, True):
            self.write_config({"projects": bad})
            projects, error = self.load()
            self.assertEqual(projects, [], bad)
            self.assertIsNotNone(error, bad)
            self.assertEqual(error["code"], "repository_not_configured", bad)

    def test_empty_list_is_error(self):
        self.write_config({"projects": []})
        projects, error = self.load()
        self.assertEqual(projects, [])
        self.assertIsNotNone(error)

    def test_more_than_20_is_error(self):
        entries = [{"name": f"p{i}", "repository": f"/r/{i}"} for i in range(21)]
        self.write_config({"projects": entries})
        projects, error = self.load()
        self.assertEqual(projects, [])
        self.assertIsNotNone(error)

    def test_entry_not_an_object_is_error(self):
        self.write_config({"projects": ["x"]})
        projects, error = self.load()
        self.assertEqual(projects, [])
        self.assertIsNotNone(error)
        self.assertIn("projects[0]", error["message"])

    def test_name_missing_is_error(self):
        self.write_config({"projects": [{"repository": "/r"}]})
        projects, error = self.load()
        self.assertEqual(projects, [])
        self.assertIn("projects[0].name", error["message"])

    def test_name_not_text_is_error(self):
        for bad in (3, None, [], True):
            self.write_config({"projects": [{"name": bad, "repository": "/r"}]})
            projects, error = self.load()
            self.assertEqual(projects, [], bad)
            self.assertIn("projects[0].name", error["message"], bad)

    def test_name_only_whitespace_is_error(self):
        self.write_config({"projects": [{"name": "   ", "repository": "/r"}]})
        projects, error = self.load()
        self.assertEqual(projects, [])
        self.assertIn("projects[0].name", error["message"])

    def test_name_101_chars_is_error(self):
        self.write_config({"projects": [{"name": "x" * 101, "repository": "/r"}]})
        projects, error = self.load()
        self.assertEqual(projects, [])
        self.assertIn("projects[0].name", error["message"])

    def test_name_100_chars_is_valid(self):
        self.write_config({"projects": [{"name": "x" * 100, "repository": "/r"}]})
        projects, error = self.load()
        self.assertIsNone(error)
        self.assertEqual(len(projects), 1)

    def test_repository_missing_is_error(self):
        self.write_config({"projects": [{"name": "P"}]})
        projects, error = self.load()
        self.assertEqual(projects, [])
        self.assertIn("projects[0].repository", error["message"])

    def test_repository_not_text_is_error(self):
        for bad in (3, None, [], True):
            self.write_config({"projects": [{"name": "P", "repository": bad}]})
            projects, error = self.load()
            self.assertEqual(projects, [], bad)
            self.assertIn("projects[0].repository", error["message"], bad)

    def test_repository_only_whitespace_is_error(self):
        self.write_config({"projects": [{"name": "P", "repository": "  "}]})
        projects, error = self.load()
        self.assertEqual(projects, [])
        self.assertIn("projects[0].repository", error["message"])

    def test_duplicate_repository_is_error(self):
        self.write_config({"projects": [{"name": "A", "repository": "/r"},
                                        {"name": "B", "repository": "/r"}]})
        projects, error = self.load()
        self.assertEqual(projects, [])
        self.assertIn("projects[1]", error["message"])

    def test_duplicate_after_expansion(self):
        """Two different textual paths that expand to the same absolute path."""
        # /tmp is absolute; /tmp/../tmp/x is not the same dir but we can test with subpaths
        # Use a real temp path to avoid OS differences
        t = tempfile.mkdtemp()
        try:
            self.write_config({"projects": [{"name": "A", "repository": t},
                                            {"name": "B", "repository": t + "/."}]})
            projects, error = self.load()
            # /tmp/xxx and /tmp/xxx/. expand to the same path
            self.assertEqual(projects, [])
            self.assertIsNotNone(error)
        finally:
            shutil.rmtree(t, True)

    def test_error_message_does_not_contain_repository_path(self):
        """Error messages from bad projects must not expose repository paths."""
        self.write_config({"projects": [{"name": "   ", "repository": "/secret/repo"}]})
        _, error = self.load()
        self.assertNotIn("/secret/repo", error["message"])
        self.assertNotIn("/secret/repo", error.get("settings", []))

    def test_bad_folder_id_affects_only_its_project(self):
        self.write_config({"projects": [
            {"name": "A", "repository": "/r/a", "folder_id": "good"},
            {"name": "B", "repository": "/r/b", "folder_id": None},
            {"name": "C", "repository": "/r/c"},
        ]})
        projects, error = self.load()
        self.assertIsNone(error)
        self.assertEqual(len(projects), 3)
        self.assertEqual(projects[0].folder, "good")
        self.assertIsNone(projects[0].folder_reason)
        self.assertIsNone(projects[1].folder)
        self.assertIsNotNone(projects[1].folder_reason)  # null folder_id → reason
        self.assertIsNone(projects[2].folder)
        self.assertIsNone(projects[2].folder_reason)  # absent folder_id → no reason

    def test_epic_board_folder_ignored_when_projects_present(self):
        self.write_config({"projects": [{"name": "P", "repository": "/r"}]})
        projects, error = self.load(EPIC_BOARD_FOLDER="env_folder")
        self.assertIsNone(error)
        self.assertIsNone(projects[0].folder)

    def test_epic_board_repository_does_not_add_project(self):
        self.write_config({"projects": [{"name": "P", "repository": "/r/p"}]})
        projects, error = self.load(EPIC_BOARD_REPOSITORY="/r/other")
        self.assertIsNone(error)
        self.assertEqual(len(projects), 1)
        self.assertEqual(projects[0].repository, "/r/p")

    def test_top_level_repository_does_not_add_project(self):
        self.write_config({"repository": "/r/legacy", "projects": [{"name": "P", "repository": "/r/p"}]})
        projects, error = self.load()
        self.assertIsNone(error)
        self.assertEqual(len(projects), 1)

    def test_epic_board_repository_gives_legacy(self):
        self.write_config({"projects": [{"name": "A", "repository": "/r/a"},
                                        {"name": "B", "repository": "/r/b"}]})
        projects, error = self.load(EPIC_BOARD_REPOSITORY="/r/a")
        self.assertIsNone(error)
        # /r/a is the legacy → gets chats.json
        self.assertEqual(projects[0].records_file, "chats.json")
        self.assertNotEqual(projects[1].records_file, "chats.json")

    def test_top_level_repository_gives_legacy(self):
        self.write_config({"repository": "/r/a",
                           "projects": [{"name": "A", "repository": "/r/a"},
                                        {"name": "B", "repository": "/r/b"}]})
        projects, error = self.load()
        self.assertIsNone(error)
        self.assertEqual(projects[0].records_file, "chats.json")
        self.assertNotEqual(projects[1].records_file, "chats.json")


class RecordsFileTests(unittest.TestCase):
    """Records_File assignment: legacy gets chats.json, others get chats-<id>.json."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def write_config(self, data):
        with open(os.path.join(self.dir, "config.json"), "w") as f:
            json.dump(data, f)

    def load(self, **env):
        return proj.load_projects(env, self.dir)

    def test_no_legacy_each_gets_own_file(self):
        self.write_config({"projects": [{"name": "A", "repository": "/r/a"},
                                        {"name": "B", "repository": "/r/b"}]})
        projects, _ = self.load()
        # Neither is legacy → both get chats-<id>.json
        for p in projects:
            self.assertNotEqual(p.records_file, "chats.json")
            self.assertTrue(p.records_file.startswith("chats-"), p.records_file)
            self.assertTrue(p.records_file.endswith(".json"), p.records_file)

    def test_chats_json_not_used_when_no_legacy(self):
        self.write_config({"projects": [{"name": "A", "repository": "/r/a"},
                                        {"name": "B", "repository": "/r/b"}]})
        projects, _ = self.load()
        files = [p.records_file for p in projects]
        self.assertNotIn("chats.json", files)

    def test_records_file_uses_project_id(self):
        self.write_config({"projects": [{"name": "Alpha", "repository": "/r/a"},
                                        {"name": "Beta", "repository": "/r/b"}]})
        projects, _ = self.load()
        for p in projects:
            if p.records_file != "chats.json":
                self.assertEqual(p.records_file, f"chats-{p.id}.json")

    def test_single_project_uses_chats_json(self):
        projects, _ = self.load(EPIC_BOARD_REPOSITORY="/r")
        self.assertEqual(projects[0].records_file, "chats.json")


class IdTests(unittest.TestCase):
    """Project_Id formation: slugify rules, deduplication, edge cases."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def write_config(self, data):
        with open(os.path.join(self.dir, "config.json"), "w") as f:
            json.dump(data, f)

    def load(self, **env):
        return proj.load_projects(env, self.dir)

    def test_equal_names_get_deduplicated_ids(self):
        self.write_config({"projects": [{"name": "Alpha", "repository": "/r/a"},
                                        {"name": "Alpha", "repository": "/r/b"}]})
        projects, error = self.load()
        self.assertIsNone(error)
        ids = [p.id for p in projects]
        self.assertEqual(len(set(ids)), 2)
        self.assertEqual(ids[0], "alpha")
        self.assertEqual(ids[1], "alpha-2")

    def test_names_that_slug_to_nothing_get_story(self):
        self.write_config({"projects": [{"name": "!!!", "repository": "/r/a"}]})
        projects, _ = self.load()
        self.assertEqual(projects[0].id, "story")

    def test_long_name_id_at_most_60_chars(self):
        self.write_config({"projects": [{"name": "x" * 100, "repository": "/r/a"}]})
        projects, _ = self.load()
        self.assertLessEqual(len(projects[0].id), 60)

    def test_case_and_punctuation_collapsed(self):
        self.write_config({"projects": [{"name": "My Project!!", "repository": "/r/a"}]})
        projects, _ = self.load()
        self.assertEqual(projects[0].id, "my-project")

    def test_id_matches_pattern(self):
        import re
        pattern = re.compile(r"^[a-z0-9-]{1,64}$")
        names = ["Alpha Beta", "My Repo", "Test123", "---", "A B C D", "UPPERCASE"]
        entries = [{"name": n, "repository": f"/r/{i}"} for i, n in enumerate(names)]
        self.write_config({"projects": entries})
        projects, _ = self.load()
        for p in projects:
            self.assertRegex(p.id, pattern, f"id {p.id!r} for name {p.name!r}")

    def test_all_ids_unique(self):
        entries = [{"name": f"project {i}", "repository": f"/r/{i}"} for i in range(5)]
        self.write_config({"projects": entries})
        projects, _ = self.load()
        ids = [p.id for p in projects]
        self.assertEqual(len(ids), len(set(ids)))


class ChatStoreFilenameTests(unittest.TestCase):
    """ChatStore with a custom filename reads and writes only that file."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def test_custom_filename_used_for_path(self):
        store = ChatStore(self.dir, filename="chats-alpha.json")
        self.assertEqual(store.path, os.path.join(self.dir, "chats-alpha.json"))

    def test_default_filename_is_chats_json(self):
        store = ChatStore(self.dir)
        self.assertEqual(store.path, os.path.join(self.dir, "chats.json"))

    def test_custom_file_written_on_reserve(self):
        store = ChatStore(self.dir, filename="chats-p.json", new_name=lambda: "chat-001")
        store.reserve("card-1")
        self.assertTrue(os.path.exists(os.path.join(self.dir, "chats-p.json")))
        self.assertFalse(os.path.exists(os.path.join(self.dir, "chats.json")))

    def test_custom_file_read_on_started(self):
        path = os.path.join(self.dir, "chats-p.json")
        with open(path, "w") as f:
            json.dump({"chats": [{"card_id": "c", "name": "n", "key": "k",
                                  "state": "started", "created": "2024-01-01T00:00:00Z"}]}, f)
        store = ChatStore(self.dir, filename="chats-p.json")
        chats = store.started()
        self.assertEqual(len(chats), 1)
        self.assertEqual(chats[0]["card_id"], "c")

    def test_two_stores_different_files_independent(self):
        store_a = ChatStore(self.dir, filename="chats-a.json", new_name=lambda: "chat-a")
        store_b = ChatStore(self.dir, filename="chats-b.json", new_name=lambda: "chat-b")
        store_a.reserve("card-1")
        self.assertEqual(store_b.started(), [])  # store_b's file has no records


# --- Property tests ---

def _random_name(rng, min_len=1, max_len=30):
    safe = string.ascii_letters + string.digits + "-_!@#$%"
    extras = " "
    chars = safe + extras
    n = rng.randint(min_len, max_len)
    # Ensure at least one non-whitespace character so the name is not whitespace-only
    name = "".join(rng.choice(chars) for _ in range(n))
    if not name.strip():
        name = rng.choice(safe) + name
    return name


def _random_projects_config(rng, count=None):
    """Generate a random valid projects list (1-10 entries, unique repos)."""
    if count is None:
        count = rng.randint(1, 10)
    entries = []
    repos = set()
    for i in range(count):
        name = _random_name(rng)
        repo = f"/r/repo-{i}-{rng.randint(0, 9999)}"
        while repo in repos:
            repo = f"/r/repo-{i}-{rng.randint(0, 9999)}"
        repos.add(repo)
        entry = {"name": name, "repository": repo}
        entries.append(entry)
    return entries


class Property2IdsAndFilesUniqueAndStableTests(unittest.TestCase):
    """Property 2: Ids and files are unique and stable across any valid config."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def write_config(self, data):
        with open(os.path.join(self.dir, "config.json"), "w") as f:
            json.dump(data, f)

    def _run_one(self, seed):
        rng = random.Random(seed)
        entries = _random_projects_config(rng)
        self.write_config({"projects": entries})
        projects, error = proj.load_projects({}, self.dir)
        self.assertIsNone(error, f"seed={seed}, config={entries}")
        ids = [p.id for p in projects]
        files = [p.records_file for p in projects]
        # Ids are unique
        self.assertEqual(len(ids), len(set(ids)), f"seed={seed}: duplicate ids {ids}")
        # Files are unique
        self.assertEqual(len(files), len(set(files)), f"seed={seed}: duplicate files {files}")
        # Ids match pattern
        import re
        pattern = re.compile(r"^[a-z0-9-]{1,64}$")
        for id_ in ids:
            self.assertRegex(id_, pattern, f"seed={seed}: bad id {id_!r}")
        # Same config → same ids (stability)
        projects2, _ = proj.load_projects({}, self.dir)
        ids2 = [p.id for p in projects2]
        self.assertEqual(ids, ids2, f"seed={seed}: ids not stable")

    def test_100_iterations(self):
        for seed in range(100):
            with self.subTest(seed=seed):
                self._run_one(seed)


class Property3SingleRepositoryBehavesAsBefore(unittest.TestCase):
    """Property 3: Single repository (no `projects`) matches load_repository + load_folder."""

    def setUp(self):
        self.dir = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.dir, True)

    def write_config(self, data):
        with open(os.path.join(self.dir, "config.json"), "w") as f:
            json.dump(data, f)

    def _run_one(self, seed):
        rng = random.Random(seed)
        # Build a config WITHOUT `projects`
        repo = f"/r/repo-{seed}"
        folder_choice = rng.choice(["absent", "valid", "invalid"])
        config = {"repository": repo}
        env = {}
        if folder_choice == "valid":
            folder_val = "f_" + "".join(rng.choice(string.ascii_lowercase) for _ in range(5))
            if rng.random() < 0.5:
                config["folder_id"] = folder_val
            else:
                env["EPIC_BOARD_FOLDER"] = folder_val
        elif folder_choice == "invalid":
            config["folder_id"] = None  # null → invalid

        self.write_config(config)

        projects, error = proj.load_projects(env, self.dir)
        repo_result, repo_error = server.load_repository(env, self.dir)
        folder_result, folder_reason = server.load_folder(env, self.dir)

        if repo_error is not None:
            self.assertEqual(projects, [], f"seed={seed}")
            self.assertIsNotNone(error, f"seed={seed}")
            self.assertEqual(error["code"], "repository_not_configured", f"seed={seed}")
        else:
            self.assertIsNone(error, f"seed={seed}, error={error}")
            self.assertEqual(len(projects), 1, f"seed={seed}")
            self.assertEqual(projects[0].repository, repo_result, f"seed={seed}: repo mismatch")
            self.assertEqual(projects[0].folder, folder_result, f"seed={seed}: folder mismatch")
            self.assertEqual(projects[0].folder_reason, folder_reason, f"seed={seed}: reason mismatch")
            self.assertEqual(projects[0].records_file, "chats.json", f"seed={seed}: records file")

    def test_100_iterations(self):
        for seed in range(100):
            with self.subTest(seed=seed):
                self._run_one(seed)


if __name__ == "__main__":
    unittest.main()
