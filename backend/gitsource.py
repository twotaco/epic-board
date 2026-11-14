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
