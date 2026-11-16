"""Git access: main branch, fetch, tree listing, file reads.

Reads only from a commit in the object store, never the working tree. The only
writes are those of a fetch of the main branch.
"""
import os
import signal
import subprocess
import threading

TIMEOUT = 30  # seconds per git command
_fetch_lock = threading.Lock()


class SourceError(Exception):
    """code: not_a_checkout | ref_unreadable | read_failed"""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def trim(text):
    return text.strip()[:300]


def run_git(repository, *args):
    """Run git without a shell. Return (ok, stdout bytes, error text). A timeout is a failure."""
    env = dict(os.environ, GIT_TERMINAL_PROMPT="0")
    try:
        child = subprocess.Popen(
            ["git", "-C", repository, *args], stdin=subprocess.DEVNULL, stdout=subprocess.PIPE,
            stderr=subprocess.PIPE, env=env, start_new_session=True)
    except OSError as error:
        return False, b"", trim(str(error))
    try:
        out, err = child.communicate(timeout=TIMEOUT)
    except subprocess.TimeoutExpired:
        # Kill the whole group: the ssh that fetch starts would outlive git.
        os.killpg(child.pid, signal.SIGKILL)
        child.communicate()
        return False, b"", f"git timed out after {TIMEOUT} seconds"
    return child.returncode == 0, out, trim(err.decode("utf-8", "replace")) or f"git exited with {child.returncode}"


class Snapshot:
    """fetched: True when the fetch succeeded, False when it failed, None when none was tried.
    fetch_error is set only when fetched is False."""

    def __init__(self, repository, branch, commit, fetched=None, fetch_error=None):
        self.repository = repository
        self.branch = branch
        self.ref = f"origin/{branch}"
        self.commit = commit
        self.fetched = fetched
        self.fetch_error = fetch_error if fetched is False else None

    def list_files(self, *prefixes):
        ok, out, error = run_git(self.repository, "ls-tree", "-r", "-z", "--name-only", self.commit, "--", *prefixes)
        if not ok:
            raise SourceError("read_failed", error)
        return [p for p in out.decode("utf-8", "replace").split("\0") if p]

    def read_file(self, path):
        ok, out, error = run_git(self.repository, "show", f"{self.commit}:{path}")
        if not ok:
            raise SourceError("read_failed", error)
        return out.decode("utf-8", "replace")


def main_branch(repository):
    ok, out, _ = run_git(repository, "symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD")
    name = out.decode("utf-8", "replace").strip() if ok else ""
    return name[len("origin/"):] if name.startswith("origin/") and len(name) > len("origin/") else "main"


def _open(repository, fetch):
    if not os.path.isdir(repository):
        raise SourceError("not_a_checkout", f"{repository} is not a directory")
    ok, _, error = run_git(repository, "rev-parse", "--git-dir")
    if not ok:
        raise SourceError("not_a_checkout", f"{repository} is not a git checkout: {error}")
    branch = main_branch(repository)
    fetched, fetch_error = None, None
    if fetch:
        with _fetch_lock:
            fetched, _, fetch_error = run_git(
                repository, "fetch", "--quiet", "origin", f"+refs/heads/{branch}:refs/remotes/origin/{branch}")
    ok, out, _ = run_git(repository, "rev-parse", "--verify", "--quiet", f"refs/remotes/origin/{branch}^{{commit}}")
    if not ok:
        reason = f": {fetch_error}" if fetched is False else ""
        raise SourceError("ref_unreadable", f"Could not read origin/{branch}{reason}")
    return Snapshot(repository, branch, out.decode().strip(), fetched, None if fetched is not False else fetch_error)


def read_snapshot(repository):
    """Read the local origin/<main branch> without fetching."""
    return _open(repository, fetch=False)


def open_snapshot(repository):
    """Fetch the main branch, then read it."""
    return _open(repository, fetch=True)


def worktree_path(repository, name):
    """The Worktree_Path: <parent>/<basename>--<name>. Example:
      repository=/home/alice/my-project, name=epic-board-a3f2b1c4
      → /home/alice/my-project--epic-board-a3f2b1c4"""
    repo = os.path.abspath(repository)
    return os.path.join(os.path.dirname(repo), f"{os.path.basename(repo)}--{name}")


def create_worktree(repository, path, main_branch):
    """Fetch origin and create a detached worktree at path at origin/main_branch.
    Returns (True, None) on success or (False, error_text) on failure.
    If path already exists as a worktree, returns (True, None) without re-creating.
    Runs: git fetch origin; git worktree add --detach path origin/main_branch.
    If the worktree add fails and the path was partially created, force-removes it."""
    ok, out, _ = run_git(repository, "worktree", "list", "--porcelain")
    if ok:
        real_path = os.path.realpath(path)
        for line in out.decode("utf-8", "replace").splitlines():
            if line.startswith("worktree ") and os.path.realpath(line[9:].strip()) == real_path:
                return True, None
    ok, _, err = run_git(repository, "fetch", "origin")
    if not ok:
        return False, f"fetch failed — {err}"
    ok, _, err = run_git(repository, "worktree", "add", "--detach", path, f"origin/{main_branch}")
    if not ok:
        run_git(repository, "worktree", "remove", "--force", path)
        return False, err
    return True, None


def remove_worktree(repository, path, force=False):
    """Remove the worktree at path. Returns (True, None) or (False, error_text).
    Runs: git worktree remove [--force] path."""
    args = ["worktree", "remove", "--force", path] if force else ["worktree", "remove", path]
    ok, _, err = run_git(repository, *args)
    return (True, None) if ok else (False, err)
