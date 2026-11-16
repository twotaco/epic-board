import os
import shutil
import subprocess
import tempfile
import unittest
from unittest import mock

import gitsource
from gitsource import SourceError, open_snapshot, read_snapshot, run_git


def git(cwd, *args):
    subprocess.run(["git", "-C", cwd, "-c", "user.name=t", "-c", "user.email=t@t", *args],
                   check=True, capture_output=True)


class Repos(unittest.TestCase):
    """A bare origin, a seeding clone, and a checkout, under a path with spaces."""

    def setUp(self):
        self.root = tempfile.mkdtemp(prefix="epic board ")
        self.addCleanup(shutil.rmtree, self.root, True)
        self.origin = os.path.join(self.root, "origin.git")
        self.seed = os.path.join(self.root, "seed")
        self.checkout = os.path.join(self.root, "my checkout")
        subprocess.run(["git", "init", "-q", "--bare", "-b", "main", self.origin], check=True)
        subprocess.run(["git", "init", "-q", "-b", "main", self.seed], check=True)
        git(self.seed, "remote", "add", "origin", self.origin)
        self.commit_file("docs/epics/e.md", "# E\n")
        git(self.seed, "push", "-q", "origin", "main")
        subprocess.run(["git", "clone", "-q", self.origin, self.checkout], check=True)

    def commit_file(self, path, text):
        full = os.path.join(self.seed, path)
        os.makedirs(os.path.dirname(full), exist_ok=True)
        with open(full, "w") as f:
            f.write(text)
        git(self.seed, "add", path)
        git(self.seed, "commit", "-q", "-m", "c")


class OpenSnapshotTests(Repos):
    def test_reads_main_when_origin_head_set(self):
        snap = open_snapshot(self.checkout)
        self.assertEqual((snap.branch, snap.ref, snap.fetch_error), ("main", "origin/main", None))
        self.assertIs(snap.fetched, True)
        self.assertEqual(len(snap.commit), 40)

    def test_origin_head_names_another_branch(self):
        git(self.seed, "checkout", "-q", "-b", "trunk")
        git(self.seed, "push", "-q", "origin", "trunk")
        git(self.checkout, "fetch", "-q", "origin")
        git(self.checkout, "remote", "set-head", "origin", "trunk")
        self.assertEqual(open_snapshot(self.checkout).branch, "trunk")

    def test_falls_back_to_main_when_origin_head_unset(self):
        git(self.checkout, "remote", "set-head", "origin", "-d")
        self.assertEqual(open_snapshot(self.checkout).branch, "main")

    def test_fetch_picks_up_new_commit(self):
        first = open_snapshot(self.checkout).commit
        self.commit_file("x.txt", "x")
        git(self.seed, "push", "-q", "origin", "main")
        self.assertNotEqual(open_snapshot(self.checkout).commit, first)

    def test_failed_fetch_with_earlier_copy(self):
        first = open_snapshot(self.checkout)
        os.rename(self.origin, self.origin + ".gone")
        snap = open_snapshot(self.checkout)
        self.assertEqual(snap.commit, first.commit)
        self.assertIs(snap.fetched, False)
        self.assertTrue(snap.fetch_error)

    def test_failed_fetch_without_earlier_copy(self):
        bare = os.path.join(self.root, "lonely")
        subprocess.run(["git", "init", "-q", bare], check=True)
        git(bare, "remote", "add", "origin", os.path.join(self.root, "missing.git"))
        with self.assertRaises(SourceError) as caught:
            open_snapshot(bare)
        self.assertEqual(caught.exception.code, "ref_unreadable")

    def test_not_a_checkout(self):
        plain = os.path.join(self.root, "plain")
        os.mkdir(plain)
        for path in (os.path.join(self.root, "nope"), plain):
            with self.assertRaises(SourceError) as caught:
                open_snapshot(path)
            self.assertEqual(caught.exception.code, "not_a_checkout")


class ReadSnapshotTests(Repos):
    def test_reads_local_copy_without_fetching(self):
        first = read_snapshot(self.checkout)
        self.commit_file("x.txt", "x")
        git(self.seed, "push", "-q", "origin", "main")
        snap = read_snapshot(self.checkout)
        self.assertEqual(snap.commit, first.commit)
        self.assertEqual((snap.branch, snap.ref), ("main", "origin/main"))
        self.assertIsNone(snap.fetched)
        self.assertIsNone(snap.fetch_error)

    def test_first_read_follows_origin_head_and_falls_back_to_main(self):
        git(self.seed, "checkout", "-q", "-b", "trunk")
        git(self.seed, "push", "-q", "origin", "trunk")
        git(self.checkout, "fetch", "-q", "origin")
        git(self.checkout, "remote", "set-head", "origin", "trunk")
        self.assertEqual((read_snapshot(self.checkout).branch, read_snapshot(self.checkout).ref),
                         ("trunk", "origin/trunk"))
        git(self.checkout, "remote", "set-head", "origin", "-d")
        self.assertEqual(read_snapshot(self.checkout).branch, "main")

    def test_no_remote_branch_is_ref_unreadable_without_fetch_reason(self):
        bare = os.path.join(self.root, "lonely")
        subprocess.run(["git", "init", "-q", bare], check=True)
        git(bare, "remote", "add", "origin", os.path.join(self.root, "missing.git"))
        with self.assertRaises(SourceError) as caught:
            read_snapshot(bare)
        self.assertEqual(caught.exception.code, "ref_unreadable")
        self.assertEqual(caught.exception.message, "Could not read origin/main")

    def test_plain_directory_is_not_a_checkout(self):
        plain = os.path.join(self.root, "plain")
        os.mkdir(plain)
        with self.assertRaises(SourceError) as caught:
            read_snapshot(plain)
        self.assertEqual(caught.exception.code, "not_a_checkout")


class FileAccessTests(Repos):
    def test_reads_commit_not_working_tree(self):
        snap = open_snapshot(self.checkout)
        with open(os.path.join(self.checkout, "docs/epics/e.md"), "w") as f:
            f.write("# CHANGED\n")
        with open(os.path.join(self.checkout, "docs/epics/new.md"), "w") as f:
            f.write("untracked")
        self.assertEqual(snap.list_files("docs/epics"), ["docs/epics/e.md"])
        self.assertEqual(snap.read_file("docs/epics/e.md"), "# E\n")

    def test_missing_file_is_read_failed(self):
        snap = open_snapshot(self.checkout)
        with self.assertRaises(SourceError) as caught:
            snap.read_file("nope.md")
        self.assertEqual(caught.exception.code, "read_failed")

    def test_no_matching_prefix_is_empty(self):
        self.assertEqual(open_snapshot(self.checkout).list_files(".kiro/specs"), [])


class RunnerTests(Repos):
    def test_timeout_is_a_failed_command(self):
        old, gitsource.TIMEOUT = gitsource.TIMEOUT, 0.5
        self.addCleanup(setattr, gitsource, "TIMEOUT", old)
        ok, _, error = run_git(self.checkout, "-c", "alias.slow=!sleep 10", "slow")
        self.assertFalse(ok)
        self.assertIn("timed out", error)


class WorktreeTests(unittest.TestCase):
    def test_worktree_path_sibling_of_checkout(self):
        path = gitsource.worktree_path("/home/alice/my-project", "epic-board-a3f2b1c4")
        self.assertEqual(path, "/home/alice/my-project--epic-board-a3f2b1c4")

    def test_worktree_path_basename_and_parent(self):
        path = gitsource.worktree_path("/a/b/c", "name")
        self.assertEqual(os.path.dirname(path), "/a/b")
        self.assertEqual(os.path.basename(path), "c--name")

    def test_worktree_path_does_not_contain_branch_slug(self):
        path = gitsource.worktree_path("/r/p", "epic-board-deadbeef")
        self.assertNotIn("story/", path)

    def test_worktree_path_property(self):
        import random
        seed = random.randrange(2 ** 32)
        rng = random.Random(seed)
        for _ in range(50):
            repo = "/r/" + "".join(rng.choices("abcdefghijklmnopqrstuvwxyz", k=rng.randint(1, 20)))
            name = "epic-board-" + "".join(rng.choices("0123456789abcdef", k=8))
            path = gitsource.worktree_path(repo, name)
            self.assertTrue(path, f"seed={seed}")
            self.assertEqual(os.path.dirname(path), os.path.dirname(os.path.abspath(repo)), f"seed={seed}")
            self.assertTrue(os.path.basename(path).endswith("--" + name), f"seed={seed}")

    def test_create_worktree_success(self):
        calls = []
        def fake_run_git(repo, *args):
            calls.append(args)
            if args[0] == "worktree" and args[1] == "list":
                return True, b"worktree /other\n", ""
            if args[0] == "fetch":
                return True, b"", ""
            return True, b"", ""
        with mock.patch.object(gitsource, "run_git", fake_run_git):
            ok, err = gitsource.create_worktree("/repo", "/path/to/wt", "main")
        self.assertTrue(ok)
        self.assertIsNone(err)
        add_call = next(c for c in calls if c[0] == "worktree" and c[1] == "add")
        self.assertIn("--detach", add_call)
        self.assertIn("/path/to/wt", add_call)
        self.assertIn("origin/main", add_call)

    def test_create_worktree_fetch_failure(self):
        def fake_run_git(repo, *args):
            if args[0] == "worktree" and args[1] == "list":
                return True, b"worktree /other\n", ""
            return False, b"", "network error"
        with mock.patch.object(gitsource, "run_git", fake_run_git):
            ok, err = gitsource.create_worktree("/repo", "/path/to/wt", "main")
        self.assertFalse(ok)
        self.assertIn("fetch failed", err)

    def test_create_worktree_add_failure_cleans_up(self):
        cleanup_calls = []
        def fake_run_git(repo, *args):
            if args[0] == "worktree" and args[1] == "list":
                return True, b"worktree /other\n", ""
            if args[0] == "fetch":
                return True, b"", ""
            if args[0] == "worktree" and args[1] == "add":
                return False, b"", "branch already exists"
            if args[0] == "worktree" and args[1] == "remove":
                cleanup_calls.append(args)
                return True, b"", ""
            return True, b"", ""
        with mock.patch.object(gitsource, "run_git", fake_run_git):
            ok, err = gitsource.create_worktree("/repo", "/path/to/wt", "main")
        self.assertFalse(ok)
        self.assertTrue(err)
        self.assertEqual(len(cleanup_calls), 1)
        self.assertIn("--force", cleanup_calls[0])

    def test_create_worktree_already_exists_returns_ok(self):
        def fake_run_git(repo, *args):
            if args[0] == "worktree" and args[1] == "list":
                return True, b"worktree /existing/path\nHEAD abc123\n", ""
            raise AssertionError(f"unexpected git call: {args}")
        with mock.patch.object(gitsource, "run_git", fake_run_git):
            ok, err = gitsource.create_worktree("/repo", "/existing/path", "main")
        self.assertTrue(ok)
        self.assertIsNone(err)

    def test_remove_worktree_without_force(self):
        calls = []
        def fake_run_git(repo, *args):
            calls.append(args)
            return True, b"", ""
        with mock.patch.object(gitsource, "run_git", fake_run_git):
            ok, err = gitsource.remove_worktree("/repo", "/path/to/wt")
        self.assertTrue(ok)
        self.assertIsNone(err)
        self.assertEqual(calls[0], ("worktree", "remove", "/path/to/wt"))
        self.assertNotIn("--force", calls[0])

    def test_remove_worktree_with_force(self):
        calls = []
        def fake_run_git(repo, *args):
            calls.append(args)
            return True, b"", ""
        with mock.patch.object(gitsource, "run_git", fake_run_git):
            ok, err = gitsource.remove_worktree("/repo", "/path/to/wt", force=True)
        self.assertTrue(ok)
        self.assertIn("--force", calls[0])

    def test_remove_worktree_failure(self):
        def fake_run_git(repo, *args):
            return False, b"", "uncommitted changes"
        with mock.patch.object(gitsource, "run_git", fake_run_git):
            ok, err = gitsource.remove_worktree("/repo", "/path/to/wt")
        self.assertFalse(ok)
        self.assertTrue(err)


if __name__ == "__main__":
    unittest.main()
