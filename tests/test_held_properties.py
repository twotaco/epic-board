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


def run_seed(seed, observe, interval=60):
    """Generate the steps for a seed and apply them. observe(run, step, answer) is called after each step.

    An AssertionError raised by observe, or any other error, is re-raised with the seed and the steps
    so far, so a failure can be run again.
    """
    steps = generate_steps(random.Random(seed))
    run = Run(interval=interval)
    try:
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


if __name__ == "__main__":
    unittest.main()
