import contextlib
import copy
import io
import threading
import unittest

from gitsource import SourceError
from held import INTERNAL_MESSAGE, Holder

REPOSITORY = "/repo"


class FakeSnapshot:
    def __init__(self, branch="main", commit="9f2c1d0aaaa", fetched=None, fetch_error=None):
        self.branch = branch
        self.ref = "origin/" + branch
        self.commit = commit
        self.fetched = fetched
        self.fetch_error = fetch_error


class Harness:
    """A Holder wired to fakes: a clock the test sets, programmed git results and a queue of jobs.

    Each of read, open and build is a value to return or an Exception to raise,
    or a function taking the snapshot (build) or the repository (read, open).
    """

    def __init__(self, interval=60):
        self.now = 0.0
        self.jobs = []
        self.reads, self.opens, self.builds = [], [], []
        self.read = FakeSnapshot()
        self.open = FakeSnapshot(fetched=True)
        self.build = ([{"epic": None, "cards": []}], [])
        self.holder = Holder(REPOSITORY, self.read_snapshot, self.open_snapshot, self.build_plan,
                             clock=lambda: self.now, spawn=self.jobs.append, interval=interval)

    @staticmethod
    def _result(value, argument):
        if callable(value):
            return value(argument)
        if isinstance(value, Exception):
            raise value
        return value

    def read_snapshot(self, repository):
        self.reads.append(repository)
        return self._result(self.read, repository)

    def open_snapshot(self, repository):
        self.opens.append(repository)
        return self._result(self.open, repository)

    def build_plan(self, snapshot):
        self.builds.append(snapshot)
        return self._result(self.build, snapshot)

    def run_next_job(self):
        """Run the oldest queued job and keep a traceback it prints off the test output."""
        job = self.jobs.pop(0)
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            job()
        return stderr.getvalue()

    @property
    def state(self):
        return self.holder._state

    def first_read(self):
        with contextlib.redirect_stderr(io.StringIO()) as stderr:
            self.holder.first_read()
        return stderr.getvalue()

    def refresh_once(self, at=None):
        """Request (which claims the due refresh), then run it. Returns stderr text."""
        if at is not None:
            self.now = at
        self.holder.request()
        return self.run_next_job()


class FirstReadTests(unittest.TestCase):
    def test_first_read_succeeds(self):
        h = Harness()
        h.build = ([{"epic": None, "cards": [{"name": "A"}]}], [{"file": "x", "reason": "y"}])
        h.first_read()
        self.assertEqual(h.reads, [REPOSITORY])
        self.assertEqual(h.opens, [])
        state = h.state
        self.assertEqual(state.plan, {
            "repository": REPOSITORY, "branch": "main", "ref": "origin/main", "commit": "9f2c1d0aaaa",
            "fetch": {"ok": None}, "groups": [{"epic": None, "cards": [{"name": "A"}]}],
            "problems": [{"file": "x", "reason": "y"}]})
        self.assertIsNone(state.error)
        self.assertIsNone(state.fetched_at)
        self.assertTrue(state.first_read_ended)
        self.assertFalse(state.refreshing)

    def test_first_read_plan_is_answered_with_no_age(self):
        h = Harness()
        h.first_read()
        kind, body = h.holder.request()
        self.assertEqual(kind, "plan")
        self.assertEqual(body["fetch"], {"ok": None})
        self.assertIsNone(body["age_seconds"])

    def test_first_read_fails_not_a_checkout(self):
        h = Harness()
        h.read = SourceError("not_a_checkout", "/repo is not a directory")
        h.first_read()
        state = h.state
        self.assertIsNone(state.plan)
        self.assertEqual(state.error, {"code": "repository_not_a_checkout", "message": "/repo is not a directory"})
        self.assertIsNone(state.fetched_at)
        self.assertTrue(state.first_read_ended)
        self.assertEqual(h.holder.request(),
                         ("error", {"code": "repository_not_a_checkout", "message": "/repo is not a directory"}))

    def test_first_read_fails_not_a_checkout_in_the_build(self):
        h = Harness()
        h.build = SourceError("not_a_checkout", "gone")
        h.first_read()
        self.assertEqual(h.state.error["code"], "repository_not_a_checkout")

    def test_first_read_fails_for_another_reason_holds_nothing(self):
        for failure in (SourceError("ref_unreadable", "no origin/main"),
                        SourceError("read_failed", "git failed"),
                        RuntimeError("boom")):
            with self.subTest(failure=failure):
                h = Harness()
                h.read = failure
                h.first_read()
                state = h.state
                self.assertIsNone(state.plan)
                self.assertIsNone(state.error)
                self.assertIsNone(state.fetched_at)
                self.assertTrue(state.first_read_ended)
                self.assertEqual(h.holder.request(), ("pending", None))

    def test_first_read_never_raises_and_prints_a_traceback_for_an_unexpected_failure(self):
        h = Harness()
        h.read = RuntimeError("boom")
        stderr = h.first_read()
        self.assertIn("RuntimeError: boom", stderr)

    def test_first_read_failure_in_the_build_holds_nothing(self):
        h = Harness()
        h.build = SourceError("read_failed", "cannot list")
        h.first_read()
        self.assertIsNone(h.state.plan)
        self.assertIsNone(h.state.error)


class FirstRefreshClaimedTests(unittest.TestCase):
    def test_startup_claims_the_first_refresh_and_changes_nothing_else(self):
        h = Harness()
        entered, release = threading.Event(), threading.Event()

        def blocked_open(repository):
            entered.set()
            release.wait(5)
            return FakeSnapshot(fetched=True)

        h.open = blocked_open
        h.holder.start()
        self.assertEqual(len(h.jobs), 1)
        first_read_plan = None
        thread = threading.Thread(target=h.jobs.pop(0))
        thread.start()
        try:
            self.assertTrue(entered.wait(5))
            state = h.state
            first_read_plan = state.plan
            self.assertTrue(state.refreshing)
            self.assertIsNotNone(state.plan)
            self.assertEqual(state.plan["fetch"], {"ok": None})
            self.assertIsNone(state.error)
            self.assertIsNone(state.fetched_at)
            self.assertIsNone(state.last_refresh_ended)
        finally:
            release.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertFalse(h.state.refreshing)
        self.assertEqual(h.state.plan["fetch"], {"ok": True})
        self.assertEqual(first_read_plan["fetch"], {"ok": None})  # the stored plan was replaced, not edited

    def test_startup_claims_when_the_first_read_failed(self):
        h = Harness()
        h.read = SourceError("ref_unreadable", "no origin/main")
        h.holder.start()
        h.run_next_job()
        self.assertEqual(len(h.opens), 1)
        self.assertEqual(h.state.plan["fetch"], {"ok": True})

    def test_a_refresh_is_not_claimed_before_the_first_read_ends(self):
        h = Harness()
        h.now = 1000
        self.assertEqual(h.holder.request(), ("pending", None))
        self.assertEqual(h.jobs, [])
        self.assertFalse(h.state.refreshing)


class RefreshOutcomeTests(unittest.TestCase):
    def test_fetch_succeeded(self):
        h = Harness()
        h.read = SourceError("not_a_checkout", "was not a checkout")
        h.first_read()
        self.assertIsNotNone(h.state.error)

        h.open = FakeSnapshot(branch="trunk", commit="abcdef0123", fetched=True)

        def slow_build(snapshot):
            h.now += 5  # building takes time; the fetch is stamped before it
            return [{"epic": None, "cards": []}], []

        h.build = slow_build
        h.refresh_once(at=100)
        state = h.state
        self.assertEqual(state.plan["fetch"], {"ok": True})
        self.assertEqual(state.plan["branch"], "trunk")
        self.assertEqual(state.plan["commit"], "abcdef0123")
        self.assertIsNone(state.error)
        self.assertEqual(state.fetched_at, 100)
        self.assertFalse(state.refreshing)
        self.assertEqual(state.last_refresh_ended, 105)
        h.now = 130
        kind, body = h.holder.request()
        self.assertEqual((kind, body["age_seconds"], body["fetch"]), ("plan", 30, {"ok": True}))

    def test_fetch_failed_with_an_earlier_copy_and_no_earlier_fetch(self):
        h = Harness()
        h.first_read()
        h.open = FakeSnapshot(fetched=False, fetch_error="could not resolve host")
        h.refresh_once(at=10)
        state = h.state
        self.assertEqual(state.plan["fetch"], {"ok": False, "reason": "could not resolve host"})
        self.assertIsNone(state.error)
        self.assertIsNone(state.fetched_at)
        self.assertIsNone(h.holder.request()[1]["age_seconds"])

    def test_fetch_failed_leaves_age_counted_from_the_last_successful_fetch(self):
        h = Harness()
        h.first_read()
        h.refresh_once(at=100)
        self.assertEqual(h.state.fetched_at, 100)
        h.open = FakeSnapshot(commit="newer", fetched=False, fetch_error="timed out")
        h.refresh_once(at=200)
        state = h.state
        self.assertEqual(state.plan["fetch"], {"ok": False, "reason": "timed out"})
        self.assertEqual(state.plan["commit"], "newer")
        self.assertIsNone(state.error)
        self.assertEqual(state.fetched_at, 100)
        h.now = 230
        self.assertEqual(h.holder.request()[1]["age_seconds"], 130)

    def test_fetch_failed_without_a_reason_still_gives_a_reason(self):
        h = Harness()
        h.first_read()
        h.open = FakeSnapshot(fetched=False, fetch_error=None)
        h.refresh_once(at=0)
        self.assertEqual(h.state.plan["fetch"]["ok"], False)
        self.assertTrue(h.state.plan["fetch"]["reason"])

    def test_a_refresh_that_returns_the_first_read_style_snapshot_keeps_the_old_age(self):
        h = Harness()
        h.first_read()
        h.refresh_once(at=100)
        h.open = FakeSnapshot(fetched=None)
        h.refresh_once(at=200)
        self.assertEqual(h.state.fetched_at, 100)
        self.assertEqual(h.state.plan["fetch"]["ok"], False)

    def test_build_failure_with_a_plan_held(self):
        h = Harness()
        h.first_read()
        h.refresh_once(at=100)
        held = h.state.plan
        before = copy.deepcopy(held)
        h.build = SourceError("read_failed", "cannot read the specs")
        h.refresh_once(at=200)
        state = h.state
        self.assertEqual(state.plan, dict(before, fetch={"ok": False, "reason": "cannot read the specs"}))
        self.assertIsNone(state.error)
        self.assertEqual(state.fetched_at, 100)
        self.assertEqual(held, before)  # the plan stored earlier was not edited
        kind, body = h.holder.request()
        self.assertEqual(kind, "plan")
        self.assertEqual(body["fetch"], {"ok": False, "reason": "cannot read the specs"})

    def test_build_failure_with_a_plan_held_and_an_unexpected_exception(self):
        h = Harness()
        h.first_read()
        h.build = RuntimeError("bug")
        stderr = h.refresh_once(at=100)
        self.assertIn("RuntimeError: bug", stderr)
        state = h.state
        self.assertEqual(state.plan["fetch"], {"ok": False, "reason": INTERNAL_MESSAGE})
        self.assertIsNone(state.error)
        self.assertIsNone(state.fetched_at)

    def test_open_failure_with_a_plan_held_is_a_failure_too(self):
        h = Harness()
        h.first_read()
        h.open = SourceError("ref_unreadable", "origin/main is missing")
        h.refresh_once(at=100)
        self.assertEqual(h.state.plan["fetch"], {"ok": False, "reason": "origin/main is missing"})
        self.assertIsNone(h.state.error)

    def test_build_failure_with_none_held(self):
        h = Harness()
        h.read = SourceError("ref_unreadable", "no origin/main")
        h.first_read()
        h.build = SourceError("ref_unreadable", "origin/main is missing")
        h.refresh_once(at=100)
        state = h.state
        self.assertIsNone(state.plan)
        self.assertEqual(state.error, {"code": "ref_unreadable", "message": "origin/main is missing"})
        self.assertIsNone(state.fetched_at)
        self.assertEqual(h.holder.request(),
                         ("error", {"code": "ref_unreadable", "message": "origin/main is missing"}))

    def test_build_failure_with_none_held_replaces_a_held_error(self):
        h = Harness()
        h.read = SourceError("not_a_checkout", "not a checkout")
        h.first_read()
        self.assertEqual(h.state.error["code"], "repository_not_a_checkout")
        h.open = SourceError("read_failed", "git failed")
        h.refresh_once(at=100)
        self.assertIsNone(h.state.plan)
        self.assertEqual(h.state.error, {"code": "read_failed", "message": "git failed"})

    def test_a_not_a_checkout_failure_in_a_refresh_is_held_as_repository_not_a_checkout(self):
        h = Harness()
        h.read = SourceError("ref_unreadable", "x")
        h.first_read()
        h.open = SourceError("not_a_checkout", "moved away")
        h.refresh_once(at=100)
        self.assertEqual(h.state.error, {"code": "repository_not_a_checkout", "message": "moved away"})

    def test_a_later_successful_refresh_recovers_from_a_held_error(self):
        h = Harness()
        h.read = SourceError("ref_unreadable", "no origin/main")
        h.first_read()
        h.open = SourceError("read_failed", "git failed")
        h.refresh_once(at=100)
        self.assertIsNotNone(h.state.error)
        h.open = FakeSnapshot(fetched=True)
        h.refresh_once(at=160)
        self.assertIsNone(h.state.error)
        self.assertEqual(h.state.plan["fetch"], {"ok": True})


class AnsweringTests(unittest.TestCase):
    def test_nothing_held_answers_pending(self):
        h = Harness()
        self.assertEqual(h.holder.request(), ("pending", None))
        h.read = SourceError("ref_unreadable", "x")
        h.first_read()
        self.assertEqual(h.holder.request(), ("pending", None))

    def test_a_plan_answer_has_age_and_refreshing_and_leaves_the_stored_plan_alone(self):
        h = Harness()
        h.first_read()
        h.refresh_once(at=100)
        stored = copy.deepcopy(h.state.plan)
        h.now = 107.9
        kind, body = h.holder.request()
        self.assertEqual(kind, "plan")
        self.assertEqual(body["age_seconds"], 7)
        self.assertIs(body["refreshing"], False)
        self.assertEqual({k: v for k, v in body.items() if k not in ("age_seconds", "refreshing")}, stored)
        self.assertEqual(h.state.plan, stored)
        self.assertNotIn("age_seconds", h.state.plan)

    def test_age_is_never_negative(self):
        h = Harness()
        h.first_read()
        h.refresh_once(at=100)
        h.now = 99
        self.assertEqual(h.holder.request()[1]["age_seconds"], 0)

    def test_an_error_answer_is_a_copy(self):
        h = Harness()
        h.read = SourceError("not_a_checkout", "no")
        h.first_read()
        _, error = h.holder.request()
        error["message"] = "changed"
        self.assertEqual(h.holder.request()[1]["message"], "no")

    def test_a_request_is_answered_at_once_while_a_refresh_is_blocked(self):
        h = Harness()
        h.first_read()
        entered, release = threading.Event(), threading.Event()

        def blocked_open(repository):
            entered.set()
            release.wait(5)
            return FakeSnapshot(fetched=True)

        h.open = blocked_open
        h.holder.request()  # claims the refresh and queues it
        thread = threading.Thread(target=h.jobs.pop(0))
        thread.start()
        try:
            self.assertTrue(entered.wait(5))
            h.now = 10_000  # long past the interval: still no second refresh
            kind, body = h.holder.request()
            self.assertTrue(thread.is_alive())  # the refresh is still blocked
            self.assertEqual(kind, "plan")
            self.assertIs(body["refreshing"], True)
            self.assertEqual(body["fetch"], {"ok": None})
            self.assertEqual(h.jobs, [])
        finally:
            release.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())
        self.assertEqual(h.holder.request()[1]["fetch"], {"ok": True})

    def test_a_request_while_the_first_read_is_blocked_is_pending_and_does_not_wait(self):
        h = Harness()
        entered, release = threading.Event(), threading.Event()

        def blocked_read(repository):
            entered.set()
            release.wait(5)
            return FakeSnapshot()

        h.read = blocked_read
        h.holder.start()
        thread = threading.Thread(target=h.jobs.pop(0))
        thread.start()
        try:
            self.assertTrue(entered.wait(5))
            h.now = 10_000
            self.assertEqual(h.holder.request(), ("pending", None))
            self.assertEqual(h.jobs, [])
            self.assertTrue(thread.is_alive())
        finally:
            release.set()
            thread.join(5)
        self.assertFalse(thread.is_alive())


class RaceAndFailureTests(unittest.TestCase):
    def test_a_request_between_the_first_read_and_the_startup_claim_claims_the_refresh(self):
        h = Harness()
        original = h.holder.first_read
        answers = []

        def first_read_then_a_request():
            original()
            answers.append(h.holder.request())  # arrives after the read ended, before the startup claim

        h.holder.first_read = first_read_then_a_request
        h.holder.start()
        h.run_next_job()  # the startup job
        self.assertEqual(len(answers), 1)
        self.assertEqual(answers[0][0], "plan")
        self.assertIs(answers[0][1]["refreshing"], True)
        self.assertEqual(h.opens, [])  # the startup thread found a refresh claimed and did nothing
        self.assertEqual(len(h.jobs), 1)  # the request's refresh, queued
        self.assertTrue(h.state.refreshing)
        h.run_next_job()
        self.assertEqual(len(h.opens), 1)
        self.assertEqual(h.jobs, [])
        self.assertFalse(h.state.refreshing)

    def test_an_unexpected_exception_gives_internal_and_does_not_leave_refreshing_set(self):
        h = Harness()
        h.read = SourceError("ref_unreadable", "x")
        h.first_read()
        h.build = ZeroDivisionError("bug")
        stderr = h.refresh_once(at=100)
        self.assertIn("ZeroDivisionError: bug", stderr)
        self.assertFalse(h.state.refreshing)
        self.assertEqual(h.state.last_refresh_ended, 100)
        self.assertEqual(h.holder.request(), ("error", {"code": "internal", "message": INTERNAL_MESSAGE}))

    def test_an_unexpected_exception_in_open_is_internal_too(self):
        h = Harness()
        h.read = SourceError("ref_unreadable", "x")
        h.first_read()
        h.open = OSError("disk")
        h.refresh_once(at=100)
        self.assertEqual(h.state.error, {"code": "internal", "message": INTERNAL_MESSAGE})
        self.assertFalse(h.state.refreshing)

    def test_the_next_refresh_runs_after_a_failed_one(self):
        h = Harness()
        h.read = SourceError("ref_unreadable", "x")
        h.first_read()
        h.build = RuntimeError("bug")
        h.refresh_once(at=100)
        h.build = ([], [])
        h.now = 159
        h.holder.request()
        self.assertEqual(h.jobs, [])
        h.now = 160
        h.holder.request()
        self.assertEqual(len(h.jobs), 1)

    def test_a_spawn_that_fails_does_not_leave_refreshing_set(self):
        h = Harness()
        h.first_read()

        def failing_spawn(job):
            raise RuntimeError("no threads")

        h.holder._spawn = failing_spawn
        with self.assertRaises(RuntimeError):
            h.holder.request()
        self.assertFalse(h.state.refreshing)


class IntervalTests(unittest.TestCase):
    def ended_at_100(self):
        h = Harness()
        h.first_read()
        h.refresh_once(at=100)
        self.assertEqual(h.state.last_refresh_ended, 100)
        self.assertEqual(h.jobs, [])
        return h

    def test_a_request_59_seconds_after_a_refresh_ended_starts_none(self):
        h = self.ended_at_100()
        h.now = 159
        kind, body = h.holder.request()
        self.assertEqual(kind, "plan")
        self.assertIs(body["refreshing"], False)
        self.assertEqual(h.jobs, [])
        self.assertFalse(h.state.refreshing)

    def test_a_request_60_seconds_after_a_refresh_ended_starts_one(self):
        h = self.ended_at_100()
        h.now = 160
        kind, body = h.holder.request()
        self.assertEqual(kind, "plan")
        self.assertIs(body["refreshing"], True)
        self.assertEqual(len(h.jobs), 1)
        self.assertTrue(h.state.refreshing)

    def test_requests_while_a_refresh_is_claimed_start_no_other(self):
        h = self.ended_at_100()
        h.now = 500
        h.holder.request()
        h.holder.request()
        h.now = 5000
        h.holder.request()
        self.assertEqual(len(h.jobs), 1)

    def test_the_interval_is_counted_from_the_end_of_the_refresh(self):
        h = Harness()
        h.first_read()
        h.holder.request()  # claimed at 0
        h.now = 50  # the refresh runs for 50 seconds
        h.run_next_job()
        self.assertEqual(h.state.last_refresh_ended, 50)
        h.now = 109
        h.holder.request()
        self.assertEqual(h.jobs, [])
        h.now = 110
        h.holder.request()
        self.assertEqual(len(h.jobs), 1)

    def test_a_custom_interval_is_used(self):
        h = Harness(interval=5)
        h.first_read()
        h.refresh_once(at=100)
        h.now = 104
        h.holder.request()
        self.assertEqual(h.jobs, [])
        h.now = 105
        h.holder.request()
        self.assertEqual(len(h.jobs), 1)


if __name__ == "__main__":
    unittest.main()
