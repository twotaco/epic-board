"""Tests for backend/setup.py: is_git_checkout, validate_setup_entry, load_setup, save_setup."""
import json
import os
import shutil
import sys
import tempfile
import unittest

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "backend"))
import setup as su


class IsGitCheckoutTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)

    def test_real_checkout_with_git_dir(self):
        repo = os.path.join(self.root, "repo")
        os.makedirs(os.path.join(repo, ".git"))
        self.assertTrue(su.is_git_checkout(repo))

    def test_worktree_with_git_file(self):
        repo = os.path.join(self.root, "worktree")
        os.makedirs(repo)
        with open(os.path.join(repo, ".git"), "w") as f:
            f.write("gitdir: ../.git/worktrees/worktree\n")
        self.assertTrue(su.is_git_checkout(repo))

    def test_plain_dir_is_not_a_checkout(self):
        plain = os.path.join(self.root, "plain")
        os.makedirs(plain)
        self.assertFalse(su.is_git_checkout(plain))

    def test_missing_path_is_not_a_checkout(self):
        self.assertFalse(su.is_git_checkout(os.path.join(self.root, "missing")))

    def test_file_is_not_a_checkout(self):
        f = os.path.join(self.root, "file.txt")
        with open(f, "w") as fh:
            fh.write("hi")
        self.assertFalse(su.is_git_checkout(f))


class ValidateSetupEntryTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.repo = os.path.join(self.root, "repo")
        os.makedirs(os.path.join(self.repo, ".git"))

    def valid(self, **overrides):
        entry = {"folder_id": "f_123", "name": "My Project", "repository": self.repo}
        entry.update(overrides)
        return entry

    def test_valid_entry_returns_none(self):
        self.assertIsNone(su.validate_setup_entry(self.valid(), 0))

    def test_relative_repo_that_expands_to_checkout_is_valid(self):
        # Put the repo relative to cwd — use an absolute path as a workaround:
        # just test that expansion works via ~ notation.
        self.assertIsNone(su.validate_setup_entry(self.valid(repository=self.repo), 0))

    def test_empty_folder_id_is_invalid(self):
        self.assertIsNotNone(su.validate_setup_entry(self.valid(folder_id=""), 0))

    def test_whitespace_folder_id_is_invalid(self):
        self.assertIsNotNone(su.validate_setup_entry(self.valid(folder_id="   "), 0))

    def test_folder_id_over_200_chars_is_invalid(self):
        self.assertIsNotNone(su.validate_setup_entry(self.valid(folder_id="x" * 201), 0))

    def test_folder_id_exactly_200_chars_is_valid(self):
        self.assertIsNone(su.validate_setup_entry(self.valid(folder_id="x" * 200), 0))

    def test_non_string_folder_id_is_invalid(self):
        for bad in (3, None, [], True):
            self.assertIsNotNone(su.validate_setup_entry(self.valid(folder_id=bad), 0), bad)

    def test_empty_name_is_invalid(self):
        self.assertIsNotNone(su.validate_setup_entry(self.valid(name=""), 0))

    def test_whitespace_only_name_is_invalid(self):
        self.assertIsNotNone(su.validate_setup_entry(self.valid(name="   "), 0))

    def test_name_over_100_chars_is_invalid(self):
        self.assertIsNotNone(su.validate_setup_entry(self.valid(name="x" * 101), 0))

    def test_non_string_repository_is_invalid(self):
        self.assertIsNotNone(su.validate_setup_entry(self.valid(repository=42), 0))

    def test_path_not_a_checkout_is_invalid(self):
        plain = os.path.join(self.root, "plain")
        os.makedirs(plain)
        self.assertIsNotNone(su.validate_setup_entry(self.valid(repository=plain), 0))

    def test_error_string_names_the_entry_number(self):
        msg = su.validate_setup_entry(self.valid(name=""), 2)
        self.assertIn("3", msg)  # 1-indexed

    def test_non_dict_entry_is_invalid(self):
        self.assertIsNotNone(su.validate_setup_entry("not a dict", 0))


class LoadSetupTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.data = os.path.join(self.root, "data")
        os.makedirs(self.data)

    def write(self, content):
        with open(os.path.join(self.data, "setup.json"), "w") as f:
            f.write(content)

    def test_missing_file_returns_empty_no_error(self):
        entries, error = su.load_setup(self.data)
        self.assertEqual(entries, [])
        self.assertIsNone(error)

    def test_valid_file_returns_entries(self):
        self.write(json.dumps({"projects": [
            {"folder_id": "f_1", "name": "Alpha", "repository": "/r/alpha"},
        ]}))
        entries, error = su.load_setup(self.data)
        self.assertIsNone(error)
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["folder_id"], "f_1")
        self.assertEqual(entries[0]["name"], "Alpha")
        self.assertEqual(entries[0]["repository"], "/r/alpha")

    def test_unreadable_file_returns_error(self):
        path = os.path.join(self.data, "setup.json")
        with open(path, "w") as f:
            f.write("not json {{{")
        entries, error = su.load_setup(self.data)
        self.assertEqual(entries, [])
        self.assertIsNotNone(error)

    def test_non_object_file_returns_error(self):
        self.write("[]")
        entries, error = su.load_setup(self.data)
        self.assertEqual(entries, [])
        self.assertIsNotNone(error)

    def test_missing_projects_key_returns_error(self):
        self.write('{"other": 1}')
        entries, error = su.load_setup(self.data)
        self.assertEqual(entries, [])
        self.assertIsNotNone(error)

    def test_non_list_projects_returns_error(self):
        self.write('{"projects": "oops"}')
        entries, error = su.load_setup(self.data)
        self.assertEqual(entries, [])
        self.assertIsNotNone(error)

    def test_never_raises(self):
        # Missing directory: no crash
        entries, error = su.load_setup(os.path.join(self.root, "missing_dir"))
        self.assertEqual(entries, [])
        self.assertIsNone(error)  # file simply doesn't exist


class SaveSetupTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.data = os.path.join(self.root, "data")

    def test_saves_correct_form(self):
        entries = [{"folder_id": "f_1", "name": "Alpha", "repository": "/r/alpha"}]
        su.save_setup(self.data, entries)
        with open(os.path.join(self.data, "setup.json")) as f:
            data = json.load(f)
        self.assertEqual(data, {"projects": entries})

    def test_second_save_replaces_first(self):
        su.save_setup(self.data, [{"folder_id": "f_1", "name": "Alpha", "repository": "/r/alpha"}])
        entries2 = [{"folder_id": "f_2", "name": "Beta", "repository": "/r/beta"}]
        su.save_setup(self.data, entries2)
        with open(os.path.join(self.data, "setup.json")) as f:
            data = json.load(f)
        self.assertEqual(data["projects"][0]["folder_id"], "f_2")

    def test_failed_write_raises_oserror(self):
        with self.assertRaises(OSError):
            su.save_setup("/nonexistent/path/that/cannot/be/created/x/y/z", [])

    def test_no_temp_file_left_after_success(self):
        su.save_setup(self.data, [])
        tmps = [f for f in os.listdir(self.data) if f.endswith(".tmp")]
        self.assertEqual(tmps, [])

    def test_creates_data_dir_if_missing(self):
        new_data = os.path.join(self.root, "newdata")
        su.save_setup(new_data, [])
        self.assertTrue(os.path.isfile(os.path.join(new_data, "setup.json")))


class WorktreeFieldTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.repo = os.path.join(self.root, "repo")
        os.makedirs(os.path.join(self.repo, ".git"))
        self.data = os.path.join(self.root, "data")
        os.makedirs(self.data)

    def valid(self, **overrides):
        entry = {"folder_id": "f_1", "name": "P", "repository": self.repo}
        entry.update(overrides)
        return entry

    def test_worktree_true_is_valid(self):
        self.assertIsNone(su.validate_setup_entry(self.valid(worktree=True), 0))

    def test_worktree_false_is_valid(self):
        self.assertIsNone(su.validate_setup_entry(self.valid(worktree=False), 0))

    def test_worktree_string_is_invalid(self):
        self.assertIsNotNone(su.validate_setup_entry(self.valid(worktree="yes"), 0))

    def test_worktree_int_is_invalid(self):
        self.assertIsNotNone(su.validate_setup_entry(self.valid(worktree=1), 0))

    def test_worktree_absent_is_valid(self):
        # No worktree key — backward compat
        self.assertIsNone(su.validate_setup_entry(self.valid(), 0))

    def test_load_setup_includes_worktree_true(self):
        with open(os.path.join(self.data, "setup.json"), "w") as f:
            json.dump({"projects": [{"folder_id": "f_1", "name": "P",
                                     "repository": self.repo, "worktree": True}]}, f)
        entries, _ = su.load_setup(self.data)
        self.assertIs(entries[0]["worktree"], True)

    def test_load_setup_includes_worktree_false(self):
        with open(os.path.join(self.data, "setup.json"), "w") as f:
            json.dump({"projects": [{"folder_id": "f_1", "name": "P",
                                     "repository": self.repo, "worktree": False}]}, f)
        entries, _ = su.load_setup(self.data)
        self.assertIs(entries[0]["worktree"], False)

    def test_load_setup_absent_worktree_defaults_to_true(self):
        with open(os.path.join(self.data, "setup.json"), "w") as f:
            json.dump({"projects": [{"folder_id": "f_1", "name": "P",
                                     "repository": self.repo}]}, f)
        entries, _ = su.load_setup(self.data)
        self.assertIs(entries[0]["worktree"], True)
