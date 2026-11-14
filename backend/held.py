"""The held plan: the last plan kept in memory, and the background refresh that replaces it.

A request is answered from memory and never runs git. Only one immutable State is shared
between threads. It is replaced as a whole under a lock, and the lock is never held across
a git command or a plan build.
"""
import sys
import threading
import time
import traceback
from collections import namedtuple

from gitsource import SourceError

INTERNAL_MESSAGE = "The plan could not be built."

State = namedtuple(
    "State", ["plan", "error", "fetched_at", "refreshing", "last_refresh_ended", "first_read_ended"])


def spawn_thread(fn):
    threading.Thread(target=fn, daemon=True).start()


def _failure(error):
    """Turn an exception into the {code, message} that is held. Prints a traceback for an unexpected one."""
    if isinstance(error, SourceError):
        code = "repository_not_a_checkout" if error.code == "not_a_checkout" else error.code
        return {"code": code, "message": error.message}
    traceback.print_exception(type(error), error, error.__traceback__, file=sys.stderr)
    return {"code": "internal", "message": INTERNAL_MESSAGE}


class Holder:
    def __init__(self, repository, read_snapshot, open_snapshot, build_plan,
                 clock=time.monotonic, spawn=spawn_thread, interval=60):
        self._repository = repository
        self._read_snapshot = read_snapshot
        self._open_snapshot = open_snapshot
        self._build_plan = build_plan
        self._clock = clock
        self._spawn = spawn
        self._interval = interval
        self._lock = threading.Lock()
        self._state = State(None, None, None, False, None, False)

    def start(self):
        """Read the plan without fetching, then claim and run the first refresh, in a background thread."""
        self._spawn(self._startup)

    def _startup(self):
        self.first_read()
        # A request that arrived after the read ended may have claimed the refresh already.
        if self._claim():
            self.run_refresh()

    def first_read(self):
        """Read the plan from the local origin/<main branch>, without a fetch. Never raises."""
        plan, error = None, None
        try:
            snapshot = self._read_snapshot(self._repository)
            groups, problems = self._build_plan(snapshot)
            plan = self._plan_body(snapshot, {"ok": None}, groups, problems)
        except SourceError as failure:
            if failure.code == "not_a_checkout":
                error = _failure(failure)
        except Exception as failure:
            _failure(failure)  # nothing is held; the first refresh decides
        finally:
            with self._lock:
                self._state = self._state._replace(plan=plan, error=error, first_read_ended=True)

    def request(self):
        """Return ("pending", None), ("error", {code, message}) or ("plan", body). Never waits for git."""
        claimed = False
        with self._lock:
            if self._due():
                self._state = self._state._replace(refreshing=True)
                claimed = True
            state = self._state
            now = self._clock()
        if claimed:
            try:
                self._spawn(self.run_refresh)
            except BaseException:
                with self._lock:
                    self._state = self._state._replace(refreshing=False)
                raise
        if state.plan is not None:
            age = None if state.fetched_at is None else max(0, int(now - state.fetched_at))
            return "plan", dict(state.plan, age_seconds=age, refreshing=state.refreshing)
        if state.error is not None:
            return "error", dict(state.error)
        return "pending", None

    def run_refresh(self):
        """Fetch, build the plan and replace the held state. Never raises, and always ends the refresh."""
        apply = None
        try:
            apply = self._outcome()
        finally:
            with self._lock:
                state = self._state if apply is None else apply(self._state)
                self._state = state._replace(refreshing=False, last_refresh_ended=self._clock())

    def _outcome(self):
        """Do the git work without the lock. Return a function from the current State to the new one."""
        try:
            snapshot = self._open_snapshot(self._repository)
            fetched_at = self._clock()
            groups, problems = self._build_plan(snapshot)
        except Exception as failure:
            return self._failed(_failure(failure))
        if snapshot.fetched is True:
            fetch, stamp = {"ok": True}, fetched_at
        else:
            fetch, stamp = {"ok": False, "reason": snapshot.fetch_error or "The fetch failed."}, None
        plan = self._plan_body(snapshot, fetch, groups, problems)
        return lambda state: state._replace(
            plan=plan, error=None, fetched_at=state.fetched_at if stamp is None else stamp)

    @staticmethod
    def _failed(failure):
        def apply(state):
            if state.plan is None:
                return state._replace(error=failure)
            # The stored plan is never changed: keep a copy with a new fetch.
            kept = dict(state.plan, fetch={"ok": False, "reason": failure["message"]})
            return state._replace(plan=kept, error=None)
        return apply

    def _due(self):
        """Call with the lock held."""
        state = self._state
        return (state.first_read_ended and not state.refreshing and
                (state.last_refresh_ended is None or self._clock() - state.last_refresh_ended >= self._interval))

    def _claim(self):
        with self._lock:
            if not self._due():
                return False
            self._state = self._state._replace(refreshing=True)
            return True

    def _plan_body(self, snapshot, fetch, groups, problems):
        return {"repository": self._repository, "branch": snapshot.branch, "ref": snapshot.ref,
                "commit": snapshot.commit, "fetch": fetch, "groups": groups, "problems": problems}
