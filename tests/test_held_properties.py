"""Property tests for the holder (design.md, "Correctness Properties").

The project adds no dependency, so the properties are checked with seeded random sequences:
every iteration has its own seed, a failure names the seed, and the same seed gives the same
sequence again. The generator and the step runner are module level so that the other
properties can reuse them.
"""
import random
import unittest

from gitsource import SourceError
from tests.test_held import FakeSnapshot, Harness

ITERATIONS = 200
BASE_SEED = 20240601

# What the first read can come back with.
FIRST_READ_RESULTS = ("plan", "not_a_checkout", "other_source_error", "build_source_error", "unexpected")
# What a queued refresh can come back with.
REFRESH_OUTCOMES = ("fetch_ok", "fetch_failed", "open_source_error", "open_not_a_checkout",
                    "build_source_error", "unexpected_open", "unexpected_build")


def generate_steps(rng, max_steps=40):
    """A random list of steps. The first read happens once, at a random place, and nearly always.

    A step is a tuple:
      ("first_read", result)   the first read ends with one of FIRST_READ_RESULTS
      ("request",)             a plan request arrives
      ("advance", seconds)     the clock moves forward 0 to 120 seconds
      ("run_job", outcome)     the oldest queued refresh runs and ends with one of REFRESH_OUTCOMES
    """
    steps = []
    for _ in range(rng.randint(1, max_steps)):
        kind = rng.choices(("request", "advance", "run_job"), weights=(4, 3, 4))[0]
        if kind == "request":
            steps.append(("request",))
        elif kind == "advance":
            steps.append(("advance", rng.choice((0, 59, 60, 120, rng.randint(0, 120)))))
        else:
            steps.append(("run_job", rng.choice(REFRESH_OUTCOMES)))
    if rng.random() < 0.95:
        steps.insert(rng.randint(0, len(steps)), ("first_read", rng.choice(FIRST_READ_RESULTS)))
    return steps


class Run:
    """One Holder on a Harness, driven by steps, remembering what it has held and answered."""

    def __init__(self, interval=60):
        self.harness = Harness(interval=interval)
        self.trace = []            # the steps applied so far
        self.answers = []          # (step index, kind, body) for each request
        self.ever_held_plan = False
        self._commits = 0

    @property
    def state(self):
        return self.harness.state

    def _snapshot(self, **kwargs):
        self._commits += 1
        return FakeSnapshot(commit="c%07d" % self._commits, **kwargs)

    def apply(self, step):
        """Apply one step. Returns the (kind, body) answer for a request, otherwise None."""
        h = self.harness
        self.trace.append(step)
        answer = None
        name = step[0]
        if name == "first_read":
            self._program_first_read(step[1])
            h.first_read()
        elif name == "request":
            answer = h.holder.request()
            self.answers.append((len(self.trace) - 1, answer[0], answer[1]))
        elif name == "advance":
            h.now += step[1]
        elif name == "run_job":
            if h.jobs:  # nothing queued means nothing to run
                self._program_refresh(step[1])
                h.run_next_job()
        else:
            raise ValueError("unknown step %r" % (step,))
        if self.state.plan is not None:
            self.ever_held_plan = True
        return answer

    def _program_first_read(self, result):
        h = self.harness
        h.build = ([{"epic": None, "cards": []}], [])
        if result == "plan":
            h.read = self._snapshot()
        elif result == "not_a_checkout":
            h.read = SourceError("not_a_checkout", "not a checkout")
        elif result == "other_source_error":
            h.read = SourceError("ref_unreadable", "no origin/main")
        elif result == "build_source_error":
            h.read = self._snapshot()
            h.build = SourceError("read_failed", "cannot read the specs")
        elif result == "unexpected":
            h.read = RuntimeError("boom")
        else:
            raise ValueError(result)

    def _program_refresh(self, outcome):
        h = self.harness
        h.build = ([{"epic": None, "cards": []}], [])
        if outcome == "fetch_ok":
            h.open = self._snapshot(fetched=True)
        elif outcome == "fetch_failed":
            h.open = self._snapshot(fetched=False, fetch_error="could not resolve host")
        elif outcome == "open_source_error":
            h.open = SourceError("ref_unreadable", "origin/main is missing")
        elif outcome == "open_not_a_checkout":
            h.open = SourceError("not_a_checkout", "moved away")
        elif outcome == "build_source_error":
            h.open = self._snapshot(fetched=True)
            h.build = SourceError("read_failed", "cannot read the specs")
        elif outcome == "unexpected_open":
            h.open = RuntimeError("bug")
        elif outcome == "unexpected_build":
            h.open = self._snapshot(fetched=True)
            h.build = ZeroDivisionError("bug")
        else:
            raise ValueError(outcome)


def run_seed(seed, observe, interval=60, generate=generate_steps, prepare=None):
    """Generate the steps for a seed and apply them. observe(run, step, answer) is called after each step.

    generate(rng) makes the steps. prepare(run, rng), when given, is called once before the first step,
    with the generator's random source, to set the run up.

    An AssertionError raised by observe, or any other error, is re-raised with the seed and the steps
    so far, so a failure can be run again.
    """
    rng = random.Random(seed)
    steps = generate(rng)
    run = Run(interval=interval)
    try:
        if prepare is not None:
            prepare(run, rng)
        for step in steps:
            answer = run.apply(step)
            observe(run, step, answer)
    except Exception as failure:
        raise AssertionError("seed=%d, after %d of %d steps %r: %s: %s" % (
            seed, len(run.trace), len(steps), run.trace, type(failure).__name__, failure)) from failure
    return run


def seeds(iterations=ITERATIONS, base=BASE_SEED):
    return [base + i for i in range(iterations)]


def check_holder_state(testcase, run, step, answer):
    """Property 1, checked after every step."""
    state = run.state
    testcase.assertFalse(state.plan is not None and state.error is not None,
                         "a plan and an error are both held")
    if run.ever_held_plan:
        testcase.assertIsNotNone(state.plan, "a held plan was lost")
    if answer is not None:
        kind = answer[0]
        if run.ever_held_plan:
            testcase.assertEqual(kind, "plan", "answered %r after a plan was held" % kind)
        elif state.error is not None:
            testcase.assertEqual(kind, "error")
        else:
            testcase.assertEqual(kind, "pending")


class HolderStateProperty(unittest.TestCase):
    """Property 1: The holder never holds a plan and an error, and never loses a plan.

    **Validates: Requirements 5.5, 6.3, 6.4, 6.5**
    """

    def test_a_plan_and_an_error_are_never_held_together_and_a_plan_is_never_lost(self):
        saw_plan = saw_error = saw_pending = 0
        for seed in seeds():
            with self.subTest(seed=seed):
                run = run_seed(seed, lambda r, s, a: check_holder_state(self, r, s, a))
                saw_plan += run.ever_held_plan
                kinds = {kind for _, kind, _ in run.answers}
                saw_error += "error" in kinds
                saw_pending += "pending" in kinds
        # The generator must reach the interesting states, or the property proves little.
        self.assertGreater(saw_plan, ITERATIONS // 4)
        self.assertGreater(saw_error, 0)
        self.assertGreater(saw_pending, 0)


def watch_refreshes(run):
    """Wrap the holder's open_snapshot, which only a running refresh calls.

    While it runs, `refreshing` must be true and a plan request must start no other refresh.
    A failure is recorded in run.violations and not raised, because run_refresh would swallow it.
    """
    run.violations = []
    holder, harness = run.harness.holder, run.harness
    original = holder._open_snapshot

    def open_snapshot(repository):
        queued = len(harness.jobs)
        if not run.state.refreshing:
            run.violations.append("refreshing was not true while a refresh ran")
        holder.request()
        if len(harness.jobs) != queued:
            run.violations.append("a second refresh was claimed while one ran")
        return original(repository)

    holder._open_snapshot = open_snapshot


def without_first_read(rng):
    """Steps for the startup scenario: the first read is done by the startup job, so none is a step.

    One run_job step is always present, so that the startup job is run.
    """
    steps = [step for step in generate_steps(rng) if step[0] != "first_read"]
    steps.insert(rng.randint(0, len(steps)), ("run_job", rng.choice(REFRESH_OUTCOMES)))
    return steps


class RefreshModel:
    """What the refresh rule says should have happened, kept from the steps and the fake clock alone.

    It never reads the holder's private fields. `queued` counts the refresh jobs the model expects to be
    claimed and not yet run. With `startup` the first job in the queue is the startup job, not a refresh.
    """

    def __init__(self, testcase, interval, startup=False, request_after_first_read=False):
        self.testcase = testcase
        self.interval = interval
        self.now = 0.0
        self.first_read_ended = False
        self.queued = 0
        self.last_end = None
        self.startup_pending = startup
        self.request_after_first_read = request_after_first_read
        self.stats = {"claimed_first": 0, "claimed_again": 0, "refused_running": 0, "refused_interval": 0,
                      "refused_early": 0, "claimed_at_interval": 0, "refused_just_before": 0,
                      "startup_claimed": 0, "startup_beaten": 0}

    def due(self):
        return (self.first_read_ended and self.queued == 0 and
                (self.last_end is None or self.now - self.last_end >= self.interval))

    def observe(self, run, step, answer):
        t = self.testcase
        name = step[0]
        if name == "first_read":
            self.first_read_ended = True
        elif name == "advance":
            self.now += step[1]
        elif name == "request":
            due = self.due()
            self._count_request(due)
            self.queued += 1 if due else 0
            if answer[0] == "plan":
                t.assertEqual(answer[1]["refreshing"], self.queued == 1,
                              "the answer's refreshing does not match whether a refresh is claimed")
        elif name == "run_job":
            self._run_job(run)
        self._check(run)
        t.assertEqual(run.violations, [])

    def _count_request(self, due):
        stats = self.stats
        if due:
            stats["claimed_again" if self.last_end is not None else "claimed_first"] += 1
            if self.last_end is not None and self.now - self.last_end == self.interval:
                stats["claimed_at_interval"] += 1
        elif not self.first_read_ended:
            stats["refused_early"] += 1
        elif self.queued:
            stats["refused_running"] += 1
        else:
            stats["refused_interval"] += 1
            if self.now - self.last_end == self.interval - 1:
                stats["refused_just_before"] += 1

    def _run_job(self, run):
        t = self.testcase
        h = run.harness
        if self.startup_pending:
            # The startup job reads the plan, then claims and runs the first refresh unless a request
            # claimed it after the read ended.
            self.startup_pending = False
            self.first_read_ended = True
            t.assertEqual(len(h.reads), 1, "the startup job did not read once")
            if self.request_after_first_read:
                self.stats["startup_beaten"] += 1
                self.queued = 1
                t.assertEqual(h.opens, [], "the startup job ran a refresh a request had claimed")
            else:
                self.stats["startup_claimed"] += 1
                t.assertEqual(len(h.opens), 1, "the startup job did not run the first refresh")
                self.last_end = self.now
                t.assertEqual(run.state.last_refresh_ended, self.now)
            return
        if self.queued:
            self.queued = 0
            self.last_end = self.now
            t.assertEqual(run.state.last_refresh_ended, self.now,
                          "running the refresh did not set last_refresh_ended to the clock")

    def _check(self, run):
        t = self.testcase
        h = run.harness
        holder = h.holder
        refresh_jobs = h.jobs[1:] if self.startup_pending else h.jobs
        if self.startup_pending:
            t.assertEqual(h.jobs[:1], [holder._startup], "the first queued job is not the startup job")
        t.assertIn(len(refresh_jobs), (0, 1), "more than one refresh is claimed and not finished")
        t.assertEqual(len(refresh_jobs), self.queued,
                      "the number of claimed refreshes differs from the rule (%d expected)" % self.queued)
        for job in refresh_jobs:
            t.assertEqual(job, holder.run_refresh)
        t.assertEqual(run.state.refreshing, len(refresh_jobs) == 1,
                      "refreshing is not true exactly while a refresh is claimed and unfinished")


class RefreshRuleProperty(unittest.TestCase):
    """Property 2: At most one refresh, started only when due.

    The model is kept from the steps and the fake clock. `due` is computed from what the test recorded:
    whether the first read has ended, whether a claimed refresh is unfinished, and the clock when the
    last refresh ended.

    **Validates: Requirements 5.4, 6.1, 6.2**
    """

    def test_at_most_one_refresh_is_claimed_and_only_when_due(self):
        totals = {}
        for seed in seeds():
            with self.subTest(seed=seed):
                model = RefreshModel(self, 60)
                run_seed(seed, model.observe, prepare=lambda run, rng: watch_refreshes(run))
                for key, count in model.stats.items():
                    totals[key] = totals.get(key, 0) + count
        # The generator must reach each way a request is answered, or the property proves little.
        for key in ("claimed_first", "claimed_again", "refused_running", "refused_interval", "refused_early",
                    "claimed_at_interval", "refused_just_before"):
            self.assertGreater(totals.get(key, 0), 0, "the generator never reached %s: %r" % (key, totals))

    def test_the_startup_job_reads_then_claims_the_first_refresh(self):
        totals = {}
        for seed in seeds(base=BASE_SEED + 100000):
            with self.subTest(seed=seed):
                def prepare(run, rng):
                    watch_refreshes(run)
                    run._program_first_read(rng.choice(FIRST_READ_RESULTS))
                    holder = run.harness.holder
                    # In some runs a request arrives just after the first read ends, before the startup claim.
                    model.request_after_first_read = rng.random() < 0.3
                    if model.request_after_first_read:
                        read = holder.first_read

                        def read_then_request():
                            read()
                            holder.request()
                        holder.first_read = read_then_request
                    holder.start()
                    self.assertEqual(len(run.harness.jobs), 1, "start() did not queue one job")
                    self.assertFalse(run.state.refreshing)

                model = RefreshModel(self, 60, startup=True)
                run_seed(seed, model.observe, generate=without_first_read, prepare=prepare)
                for key, count in model.stats.items():
                    totals[key] = totals.get(key, 0) + count
        self.assertGreater(totals["startup_claimed"], 0, repr(totals))
        self.assertGreater(totals["startup_beaten"], 0, repr(totals))
        self.assertGreater(totals["claimed_again"], 0, repr(totals))


class AgeModel:
    """What the plan age should be, kept from the steps and the fake clock alone.

    It records the clock when each refresh with the outcome "fetch_ok" ran. The fetch is stamped when
    open_snapshot returns and the fake clock does not move during a job, so that is the clock at the time
    the job runs. Every other outcome is a failed refresh (a fetch that succeeded but whose plan then
    failed to build moves nothing), and so is the first read. It never reads the holder's private fields.
    """

    def __init__(self, testcase):
        self.testcase = testcase
        self.now = 0.0
        self.last_ok = None            # the clock when the latest "fetch_ok" refresh ran
        self.opens_seen = 0
        self.previous = None           # (last_ok, age) of the previous plan answer
        self.stats = {"null_after_first_read": 0, "null_after_failure": 0, "non_null": 0,
                      "failed_after_success": 0, "answer_after_failed_after_success": 0,
                      "monotone_pair": 0, "two_successes": 0}
        self._failed_after_success = False

    def observe(self, run, step, answer):
        name = step[0]
        if name == "advance":
            self.now += step[1]
        elif name == "run_job":
            self._after_job(run, step[1])
        elif name == "request" and answer[0] == "plan":
            self._check_answer(run, answer[1])

    def _after_job(self, run, outcome):
        opened = len(run.harness.opens)
        if opened == self.opens_seen:
            return  # no job was queued, so nothing ran
        self.opens_seen = opened
        if outcome == "fetch_ok":
            if self.last_ok is not None:
                self.stats["two_successes"] += 1
            self.last_ok = self.now
            self._failed_after_success = False
        elif self.last_ok is not None:
            self.stats["failed_after_success"] += 1
            self._failed_after_success = True

    def _check_answer(self, run, body):
        t = self.testcase
        age = body["age_seconds"]
        if self.last_ok is None:
            t.assertIsNone(age, "age_seconds is set but no refresh fetch has succeeded")
            self.stats["null_after_failure" if run.harness.opens else "null_after_first_read"] += 1
            self.previous = None
            return
        t.assertIsNotNone(age, "age_seconds is none after a successful fetch")
        t.assertIs(type(age), int, "age_seconds is not an int: %r" % (age,))
        t.assertGreaterEqual(age, 0)
        t.assertEqual(age, int(max(0, self.now - self.last_ok)),
                      "age_seconds is not the whole seconds since the latest successful fetch")
        self.stats["non_null"] += 1
        if self._failed_after_success:
            self.stats["answer_after_failed_after_success"] += 1
        if self.previous is not None and self.previous[0] == self.last_ok:
            t.assertGreaterEqual(age, self.previous[1], "age_seconds decreased as the clock advanced")
            self.stats["monotone_pair"] += 1
        self.previous = (self.last_ok, age)


class PlanAgeProperty(unittest.TestCase):
    """Property 3: Age follows the last successful fetch.

    **Validates: Requirements 5.2, 5.4, 6.3, 6.4, 6.5**
    """

    def test_age_is_none_until_a_fetch_succeeds_and_then_counts_from_the_latest_one(self):
        totals = {}
        for seed in seeds(base=BASE_SEED + 200000):
            with self.subTest(seed=seed):
                model = AgeModel(self)
                run_seed(seed, model.observe)
                for key, count in model.stats.items():
                    totals[key] = totals.get(key, 0) + count
        # The generator must reach each case, or the property proves little.
        for key in ("null_after_first_read", "null_after_failure", "non_null", "failed_after_success",
                    "answer_after_failed_after_success", "monotone_pair", "two_successes"):
            self.assertGreater(totals.get(key, 0), 0, "the generator never reached %s: %r" % (key, totals))


if __name__ == "__main__":
    unittest.main()
