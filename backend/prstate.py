"""Pull request state for the page, read with `gh pr view`.

Crew strips a pull request's `state` from the source links it gives apps, so the page asks the
backend instead. Runs gh without a shell. Any failure for one address gives None for it.
"""
import json
import re
import subprocess
import threading
import time
from concurrent.futures import ThreadPoolExecutor

PR_URL = re.compile(r"https://github\.com/[A-Za-z0-9-]+/[A-Za-z0-9_.-]+/pull/[1-9][0-9]{0,8}\Z")
MAX_URLS = 10
TTL_SECONDS = 60
GH_TIMEOUT = 8


class PrStateError(Exception):
    pass


def run_gh(url, timeout=GH_TIMEOUT):
    """Return gh's stdout as text, or raise OSError / subprocess.SubprocessError."""
    done = subprocess.run(["gh", "pr", "view", url, "--json", "state,isDraft"], stdin=subprocess.DEVNULL,
                          capture_output=True, timeout=timeout, check=True)
    return done.stdout.decode("utf-8", "replace")


def parse_state(text):
    """'open', 'draft', 'merged' or 'closed' from gh's JSON, else None."""
    try:
        data = json.loads(text)
        state, draft = data["state"], data.get("isDraft")
    except (ValueError, KeyError, TypeError):
        return None
    if state == "OPEN":
        return "draft" if draft is True else "open"
    return state.lower() if state in ("MERGED", "CLOSED") else None


class PrStates:
    # shortcut: the cache lives in memory and is never pruned; a restart clears it, and the keys are few.
    def __init__(self, run=run_gh, clock=time.monotonic, ttl=TTL_SECONDS):
        self.run, self.clock, self.ttl = run, clock, ttl
        self.cache = {}
        self.lock = threading.Lock()

    def _read(self, url):
        with self.lock:
            hit = self.cache.get(url)
            if hit is not None and self.clock() - hit[0] < self.ttl:
                return hit[1]
        try:
            state = parse_state(self.run(url))
        except (OSError, subprocess.SubprocessError, ValueError):
            state = None
        with self.lock:
            self.cache[url] = (self.clock(), state)
        return state

    def states(self, urls):
        """{url: state or None}. Raises PrStateError for a bad list or any address that is not a pull request."""
        if not isinstance(urls, list) or len(urls) > MAX_URLS:
            raise PrStateError(f"urls must be a list of at most {MAX_URLS} addresses.")
        for url in urls:
            if not isinstance(url, str) or not PR_URL.match(url):
                raise PrStateError("Each address must look like https://github.com/<owner>/<repo>/pull/<number>.")
        unique = list(dict.fromkeys(urls))
        if not unique:
            return {}
        with ThreadPoolExecutor(max_workers=len(unique)) as pool:
            return dict(zip(unique, pool.map(self._read, unique)))
