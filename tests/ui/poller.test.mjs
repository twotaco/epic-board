// Property 7: The poller keeps one request in flight and sleeps when hidden.
// Validates: Requirements 7.1, 7.2, 7.3, 7.4
import test from 'node:test'
import assert from 'node:assert/strict'

import { createPoller, classify, nextDelay } from '../../ui/index.mjs'
import { rng, baseSeed } from './support.mjs'

const ABORT_MS = 10000
const SOON_MS = 2000
const LATER_MS = 15000

// ---- Fakes ----

// A virtual clock and a timer list. `fire(id)` runs one timer; `advance(ms)` runs the due
// timers in order of time, then of creation, and leaves the clock at the target.
function makeScheduler() {
  let nextId = 1
  const scheduler = {
    now: 0,
    timers: [],
    setTimer(fn, ms) {
      const id = nextId
      nextId += 1
      scheduler.timers.push({ id, fn, ms, at: scheduler.now + ms })
      return id
    },
    clearTimer(id) {
      scheduler.timers = scheduler.timers.filter((timer) => timer.id !== id)
    },
    // The timer that is due first, or undefined.
    first() {
      return [...scheduler.timers].sort((a, b) => a.at - b.at || a.id - b.id)[0]
    },
    fire(id) {
      const timer = scheduler.timers.find((candidate) => candidate.id === id)
      assert.ok(timer, `timer ${id} is not pending`)
      scheduler.timers = scheduler.timers.filter((candidate) => candidate.id !== id)
      scheduler.now = Math.max(scheduler.now, timer.at)
      timer.fn()
    },
    advance(ms) {
      const target = scheduler.now + ms
      for (;;) {
        const timer = scheduler.first()
        if (timer === undefined || timer.at > target) break
        scheduler.fire(timer.id)
      }
      scheduler.now = target
    },
    // The timers that start the next request (every timer but the 10-second abort timer).
    nextTimers: () => scheduler.timers.filter((timer) => timer.ms !== ABORT_MS),
    abortTimers: () => scheduler.timers.filter((timer) => timer.ms === ABORT_MS),
  }
  return scheduler
}

// An abort controller whose signal records its listeners.
function makeController() {
  const signal = {
    aborted: false,
    onabort: [],
    addEventListener(type, listener) {
      if (type === 'abort') signal.onabort.push(listener)
    },
  }
  return {
    signal,
    abort() {
      if (signal.aborted) return
      signal.aborted = true
      for (const listener of signal.onabort) listener()
    },
  }
}

// A request the test settles by hand. `inFlight` counts the requests that are neither
// settled by the test nor aborted. With `rejectOnAbort` an abort also rejects the promise,
// as `fetch` does.
function makeRequest({ rejectOnAbort = false } = {}) {
  const fake = {
    calls: 0,
    inFlight: 0,
    maxInFlight: 0,
    entries: [],
    request(signal) {
      const entry = { signal, ended: false }
      entry.promise = new Promise((resolve, reject) => {
        entry.resolve = (value) => {
          fake.end(entry)
          resolve(value)
        }
        entry.reject = (reason) => {
          fake.end(entry)
          reject(reason)
        }
      })
      fake.calls += 1
      fake.inFlight += 1
      fake.maxInFlight = Math.max(fake.maxInFlight, fake.inFlight)
      fake.entries.push(entry)
      signal.addEventListener('abort', () => {
        fake.end(entry)
        if (rejectOnAbort) entry.reject(new Error('The operation was aborted.'))
      })
      return entry.promise
    },
    end(entry) {
      if (entry.ended) return
      entry.ended = true
      fake.inFlight -= 1
    },
    // The request still in flight, or undefined.
    current: () => fake.entries.find((entry) => !entry.ended),
    aborted: () => fake.entries.filter((entry) => entry.signal.aborted),
  }
  return fake
}

const flush = () => new Promise((resolve) => setImmediate(resolve))

function setup({ hidden = false, rejectOnAbort = false } = {}) {
  const scheduler = makeScheduler()
  const fake = makeRequest({ rejectOnAbort })
  const results = []
  const state = { hidden }
  const poller = createPoller({
    request: fake.request,
    hidden: () => state.hidden,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    onResult: (result) => results.push(result),
    createAbortController: makeController,
  })
  return { scheduler, fake, results, state, poller }
}

// ---- Answers ----

const PENDING = { status: 202, body: { pending: true } }
const PLAN_REFRESHING = { status: 200, body: { branch: 'main', commit: 'abcdef0123', groups: [], refreshing: true } }
const PLAN_IDLE = { status: 200, body: { branch: 'main', commit: 'abcdef0123', groups: [], refreshing: false } }
const PLAN_NO_FLAG = { status: 200, body: { branch: 'main', commit: 'abcdef0123', groups: [] } }
const ERROR_ANSWER = { status: 409, body: { error: { code: 'repository_not_configured', message: 'No repository.' } } }
const BAD_SHAPES = [
  { status: 200, body: 'x' },
  { status: 200, body: null },
  { status: 200, body: {} },
  { status: 200, body: [] },
  { status: 202, body: {} },
  { status: 202, body: { pending: false } },
  { status: 500, body: { message: 'no error object' } },
  undefined,
]

// What a random answer is, and what the poller must do with it.
const ANSWER_KINDS = {
  pending: { make: () => ({ resolve: PENDING }), kind: 'pending', delay: SOON_MS },
  planRefreshing: { make: () => ({ resolve: PLAN_REFRESHING }), kind: 'plan', delay: SOON_MS },
  planIdle: { make: () => ({ resolve: PLAN_IDLE }), kind: 'plan', delay: LATER_MS },
  planNoFlag: { make: () => ({ resolve: PLAN_NO_FLAG }), kind: 'plan', delay: LATER_MS },
  error: { make: () => ({ resolve: ERROR_ANSWER }), kind: 'error', delay: LATER_MS },
  badShape: { make: (r) => ({ resolve: r.pick(BAD_SHAPES) }), kind: 'failure', delay: LATER_MS },
  rejection: { make: () => ({ reject: new TypeError('Failed to fetch') }), kind: 'failure', delay: LATER_MS },
}
const ANSWER_NAMES = Object.keys(ANSWER_KINDS)

function settleEntry(entry, answer) {
  if ('reject' in answer) entry.reject(answer.reject)
  else entry.resolve(answer.resolve)
}

// ---- Property 7 ----

// Like `forSeeds` in support.mjs (same seeds, same message, replay with EB_SEED), for an async body.
async function forSeedsAsync(name, iterations, fn) {
  const start = baseSeed()
  for (let i = 0; i < iterations; i += 1) {
    const seed = start + i
    try {
      await fn(rng(seed), seed)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      const error = new Error(`property "${name}" failed with seed ${seed} (EB_SEED=${seed}): ${message}`)
      error.cause = failure
      throw error
    }
  }
}

const STEP_NAMES = [
  'answer', 'answer', 'answer', 'answer',
  'tick', 'tick', 'tick',
  'advance', 'advance',
  'timeout',
  'hide',
  'show', 'show',
  'late',
]
const ADVANCE_MS = [1, 500, 1999, 2000, 9999, 10000, 15000, 25000, 40000]

async function runSequence(r, stepCount) {
  const env = setup({ hidden: r.bool(0.3), rejectOnAbort: r.bool(0.3) })
  const { scheduler, fake, results, state, poller } = env
  const model = { asleep: false, log: [] }

  // Runs one event, then checks everything that must hold after any event.
  // `verify(before)` checks what is specific to the event.
  async function event(name, action, verify = () => {}) {
    model.log.push(name)
    const before = {
      calls: fake.calls,
      results: results.length,
      inFlight: fake.inFlight,
      timerIds: scheduler.timers.map((timer) => timer.id),
      nextIds: scheduler.nextTimers().map((timer) => timer.id),
      hidden: state.hidden,
    }
    action()
    await flush()
    const context = `after "${name}" (steps so far: ${model.log.join(', ')})`
    const started = fake.calls - before.calls
    const added = results.slice(before.results)

    // 7.1: never more than one request in flight, counted by the fake request itself.
    assert.ok(fake.maxInFlight <= 1, `more than one request was in flight ${context}`)
    assert.ok(fake.inFlight >= 0 && fake.inFlight <= 1, `in flight is ${fake.inFlight} ${context}`)
    assert.ok(started <= 1, `${started} requests started in one event ${context}`)
    assert.ok(added.length <= 1, `${added.length} results in one event ${context}`)

    // 7.2: a request starts only while visible (a `show` event sets hidden false before its visible() call).
    if (started === 1) {
      assert.equal(state.hidden, false, `a request started while hidden ${context}`)
      model.asleep = false
    }

    // Timers: at most one next-request timer; an abort timer exactly while a request is in flight.
    const next = scheduler.nextTimers()
    const abort = scheduler.abortTimers()
    assert.ok(next.length <= 1, `${next.length} next-request timers ${context}`)
    if (fake.inFlight === 1) {
      assert.equal(next.length, 0, `a next-request timer is pending while a request is in flight ${context}`)
      assert.equal(abort.length, 1, `expected one abort timer while in flight ${context}`)
      if (started === 1) assert.equal(abort[0].at, scheduler.now + ABORT_MS, `abort timer at the wrong time ${context}`)
    } else {
      assert.equal(abort.length, 0, `an abort timer is pending with nothing in flight ${context}`)
    }

    // 7.3, 7.4: after each settled request exactly one next-request timer, with the delay for its result.
    if (added.length === 1) {
      const expected = model.expectedResult
      assert.ok(expected, `a result arrived that the model did not expect ${context}: ${JSON.stringify(added[0])}`)
      assert.equal(added[0].kind, expected.kind, `result kind ${context}`)
      assert.equal(started, 0, `a request started in the event that settled one ${context}`)
      assert.equal(next.length, 1, `expected one next-request timer after a result ${context}`)
      assert.equal(next[0].ms, expected.delay, `delay after a ${expected.kind} result ${context}`)
      assert.equal(next[0].ms, nextDelay(added[0]), `delay differs from nextDelay ${context}`)
      assert.equal(next[0].at, scheduler.now + expected.delay, `next-request timer at the wrong time ${context}`)
    } else {
      assert.equal(model.expectedResult, null, `the model expected a result but none arrived ${context}`)
    }
    model.expectedResult = null

    verify({ before, started, added, next })

    // Nothing in flight and no timer is allowed only when the poller went to sleep while hidden.
    if (fake.inFlight === 0 && next.length === 0) {
      assert.ok(model.asleep, `no request, no timer, and the poller is not asleep ${context}`)
    }
  }

  model.expectedResult = null

  // start()
  await event('start', () => poller.start(), ({ started }) => {
    assert.equal(started, state.hidden ? 0 : 1, 'start() while visible sends one request, while hidden none')
    if (state.hidden) {
      model.asleep = true
      assert.equal(scheduler.timers.length, 0, 'start() while hidden sets no timer')
    }
  })

  for (let i = 0; i < stepCount; i += 1) {
    const name = r.pick(STEP_NAMES)

    if (name === 'answer') {
      const entry = fake.current()
      if (!entry) continue
      const kindName = r.pick(ANSWER_NAMES)
      const spec = ANSWER_KINDS[kindName]
      await event(`answer:${kindName}`, () => {
        model.expectedResult = { kind: spec.kind, delay: spec.delay }
        settleEntry(entry, spec.make(r))
      })
    } else if (name === 'late') {
      const entries = fake.aborted()
      if (entries.length === 0) continue
      const entry = r.pick(entries)
      const kindName = r.pick(ANSWER_NAMES)
      await event(`late:${kindName}`, () => settleEntry(entry, ANSWER_KINDS[kindName].make(r)), ({ before, started, added }) => {
        assert.equal(added.length, 0, 'a late answer after an abort produced a result')
        assert.equal(started, 0, 'a late answer after an abort started a request')
        assert.deepEqual(scheduler.timers.map((timer) => timer.id), before.timerIds, 'a late answer changed the timers')
      })
    } else if (name === 'tick' || name === 'timeout') {
      const timer = name === 'timeout' ? scheduler.abortTimers()[0] : scheduler.first()
      if (!timer) continue
      await event(`${name}:${timer.ms === ABORT_MS ? 'abort' : 'next'}`, () => {
        if (timer.ms === ABORT_MS) model.expectedResult = { kind: 'failure', delay: LATER_MS }
        scheduler.fire(timer.id)
      }, ({ started, before }) => {
        if (timer.ms === ABORT_MS) {
          assert.ok(fake.entries.at(-1).signal.aborted || fake.aborted().length > 0, 'the abort timer did not abort the signal')
          assert.equal(fake.inFlight, 0, 'the aborted request still counts as in flight')
        } else if (before.hidden) {
          assert.equal(started, 0, 'the timer fired while hidden and a request was sent')
          assert.equal(scheduler.timers.length, 0, 'the timer fired while hidden and a timer was set')
          model.asleep = true
        } else {
          assert.equal(started, 1, 'the timer fired while visible and no request was sent')
        }
      })
    } else if (name === 'advance') {
      const target = scheduler.now + r.pick(ADVANCE_MS)
      for (;;) {
        const timer = scheduler.first()
        if (timer === undefined || timer.at > target) break
        await event(`advance:${timer.ms === ABORT_MS ? 'abort' : 'next'}`, () => {
          if (timer.ms === ABORT_MS) model.expectedResult = { kind: 'failure', delay: LATER_MS }
          scheduler.fire(timer.id)
        }, ({ started, before }) => {
          if (timer.ms !== ABORT_MS) {
            assert.equal(started, before.hidden ? 0 : 1, 'a timer fired and the request did not follow the page visibility')
            if (before.hidden) model.asleep = true
          }
        })
      }
      scheduler.now = target
    } else if (name === 'hide') {
      state.hidden = true
      await event('hide', () => {}, ({ started, before }) => {
        assert.equal(started, 0, 'hiding sent a request')
        assert.deepEqual(scheduler.timers.map((timer) => timer.id), before.timerIds, 'hiding changed the timers')
      })
    } else if (name === 'show') {
      state.hidden = false
      await event('show', () => poller.visible(), ({ before, started }) => {
        assert.equal(started, before.inFlight === 1 ? 0 : 1, 'visible() sends at once unless a request is in flight')
        for (const id of before.nextIds) {
          assert.ok(!scheduler.timers.some((timer) => timer.id === id), 'visible() left the old next-request timer pending')
        }
      })
    }
  }

  // stop(): everything is cleaned up and nothing happens afterwards.
  const pendingEntry = fake.current()
  await event('stop', () => poller.stop(), ({ started }) => {
    model.asleep = true
    assert.equal(started, 0)
    assert.equal(scheduler.timers.length, 0, 'stop() left a timer pending')
    assert.equal(fake.inFlight, 0, 'stop() left a request in flight')
    if (pendingEntry) assert.ok(pendingEntry.signal.aborted, 'stop() did not abort the request in flight')
  })
  const afterStop = fake.calls
  for (const entry of fake.entries) {
    const answer = ANSWER_KINDS[r.pick(ANSWER_NAMES)].make(r)
    const count = results.length
    settleEntry(entry, answer)
    await flush()
    assert.equal(results.length, count, 'a result arrived after stop()')
    assert.equal(scheduler.timers.length, 0, 'a timer was set after stop()')
  }
  state.hidden = false
  poller.start()
  poller.visible()
  assert.equal(fake.calls, afterStop, 'start() or visible() sent a request after stop()')
  assert.equal(scheduler.timers.length, 0, 'start() or visible() set a timer after stop()')
}

test('Property 7: one request in flight, none while hidden, one next timer with the right delay', async () => {
  await forSeedsAsync('the poller keeps one request in flight and sleeps when hidden', 200, async (r) => {
    await runSequence(r, 60)
  })
})

// ---- Examples ----

test('start() sends one request at once', () => {
  const { scheduler, fake, results, poller } = setup()
  poller.start()
  assert.equal(fake.calls, 1)
  assert.equal(fake.inFlight, 1)
  assert.equal(fake.entries[0].signal.aborted, false)
  assert.equal(scheduler.nextTimers().length, 0)
  assert.equal(scheduler.abortTimers().length, 1)
  assert.equal(scheduler.abortTimers()[0].ms, 10000)
  assert.equal(results.length, 0)
})

test('start() while hidden sends none and sets no timer, then visible() sends at once', () => {
  const { scheduler, fake, state, poller } = setup({ hidden: true })
  poller.start()
  assert.equal(fake.calls, 0)
  assert.equal(scheduler.timers.length, 0)
  state.hidden = false
  poller.visible()
  assert.equal(fake.calls, 1)
  assert.equal(fake.inFlight, 1)
})

const DELAY_CASES = [
  ['a pending answer sets a 2000 ms timer', { resolve: PENDING }, 'pending', 2000],
  ['a plan with refreshing: true sets a 2000 ms timer', { resolve: PLAN_REFRESHING }, 'plan', 2000],
  ['a plan with refreshing: false sets a 15000 ms timer', { resolve: PLAN_IDLE }, 'plan', 15000],
  ['a plan without refreshing sets a 15000 ms timer', { resolve: PLAN_NO_FLAG }, 'plan', 15000],
  ['an error answer sets a 15000 ms timer', { resolve: ERROR_ANSWER }, 'error', 15000],
  ['a failure (rejection) sets a 15000 ms timer', { reject: new TypeError('Failed to fetch') }, 'failure', 15000],
]
for (const [name, answer, kind, delay] of DELAY_CASES) {
  test(name, async () => {
    const { scheduler, fake, results, poller } = setup()
    poller.start()
    settleEntry(fake.entries[0], answer)
    await flush()
    assert.equal(results.length, 1)
    assert.equal(results[0].kind, kind)
    const next = scheduler.nextTimers()
    assert.equal(next.length, 1)
    assert.equal(next[0].ms, delay)
    assert.equal(next[0].at, scheduler.now + delay)
    assert.equal(scheduler.abortTimers().length, 0, 'the abort timer was not cleared')
    assert.equal(fake.inFlight, 0)
  })
}

test('the next-request timer sends the next request when the page is visible', async () => {
  const { scheduler, fake, poller } = setup()
  poller.start()
  settleEntry(fake.entries[0], { resolve: PENDING })
  await flush()
  scheduler.advance(1999)
  assert.equal(fake.calls, 1)
  scheduler.advance(1)
  assert.equal(fake.calls, 2)
  assert.equal(fake.inFlight, 1)
  assert.equal(scheduler.nextTimers().length, 0)
})

test('the timer firing while hidden sends nothing and sets no timer; visible() then sends at once', async () => {
  const { scheduler, fake, state, poller } = setup()
  poller.start()
  settleEntry(fake.entries[0], { resolve: PLAN_IDLE })
  await flush()
  state.hidden = true
  scheduler.advance(15000)
  assert.equal(fake.calls, 1)
  assert.equal(scheduler.timers.length, 0)
  state.hidden = false
  poller.visible()
  assert.equal(fake.calls, 2)
  assert.equal(fake.inFlight, 1)
})

test('visible() clears the pending timer and sends at once', async () => {
  const { scheduler, fake, poller } = setup()
  poller.start()
  settleEntry(fake.entries[0], { resolve: PLAN_IDLE })
  await flush()
  const [old] = scheduler.nextTimers()
  assert.ok(old)
  poller.visible()
  assert.equal(fake.calls, 2)
  assert.ok(!scheduler.timers.some((timer) => timer.id === old.id), 'the old timer is still pending')
  assert.equal(scheduler.nextTimers().length, 0)
  scheduler.advance(15000 - 1)
  assert.equal(fake.calls, 2, 'the cleared timer still sent a request')
})

test('visible() while a request is in flight sends nothing', async () => {
  const { scheduler, fake, results, poller } = setup()
  poller.start()
  poller.visible()
  poller.visible()
  assert.equal(fake.calls, 1)
  assert.equal(fake.maxInFlight, 1)
  assert.equal(scheduler.nextTimers().length, 0)
  settleEntry(fake.entries[0], { resolve: PENDING })
  await flush()
  assert.equal(results.length, 1)
  assert.equal(scheduler.nextTimers().length, 1, 'the settling request sets the next timer as usual')
  assert.equal(scheduler.nextTimers()[0].ms, 2000)
})

test('the 10-second timer aborts the signal, reports one failure, then waits 15000 ms', () => {
  const { scheduler, fake, results, poller } = setup()
  poller.start()
  scheduler.advance(9999)
  assert.equal(fake.entries[0].signal.aborted, false)
  assert.equal(results.length, 0)
  scheduler.advance(1)
  assert.equal(fake.entries[0].signal.aborted, true)
  assert.deepEqual(results, [{ kind: 'failure' }])
  assert.equal(fake.inFlight, 0)
  const next = scheduler.nextTimers()
  assert.equal(next.length, 1)
  assert.equal(next[0].ms, 15000)
  assert.equal(next[0].at, 10000 + 15000)
  scheduler.advance(14999)
  assert.equal(fake.calls, 1)
  scheduler.advance(1)
  assert.equal(fake.calls, 2)
  assert.equal(fake.entries[1].signal.aborted, false)
})

test('a late resolve after an abort is ignored', async () => {
  const { scheduler, fake, results, poller } = setup()
  poller.start()
  scheduler.advance(10000)
  assert.equal(results.length, 1)
  const [timer] = scheduler.nextTimers()
  fake.entries[0].resolve(PLAN_REFRESHING)
  await flush()
  assert.equal(results.length, 1, 'a second result was reported')
  assert.deepEqual(scheduler.nextTimers().map((t) => t.id), [timer.id], 'the late answer changed the next timer')
})

test('a rejection caused by the abort is ignored too', async () => {
  const { scheduler, fake, results, poller } = setup({ rejectOnAbort: true })
  poller.start()
  scheduler.advance(10000)
  await flush()
  assert.equal(results.length, 1)
  assert.equal(scheduler.nextTimers().length, 1)
  assert.equal(fake.inFlight, 0)
})

test('stop() clears the timer, and later timers and results do nothing', async () => {
  const { scheduler, fake, results, poller } = setup()
  poller.start()
  settleEntry(fake.entries[0], { resolve: PLAN_IDLE })
  await flush()
  assert.equal(scheduler.nextTimers().length, 1)
  poller.stop()
  assert.equal(scheduler.timers.length, 0)
  scheduler.advance(60000)
  assert.equal(fake.calls, 1)
  assert.equal(results.length, 1)
})

test('stop() aborts a request in flight; its late answer calls neither onResult nor setTimer', async () => {
  const { scheduler, fake, results, poller } = setup()
  poller.start()
  poller.stop()
  assert.equal(fake.entries[0].signal.aborted, true)
  assert.equal(fake.inFlight, 0)
  assert.equal(scheduler.timers.length, 0, 'the abort timer was not cleared')
  fake.entries[0].resolve(PLAN_REFRESHING)
  await flush()
  assert.equal(results.length, 0)
  assert.equal(scheduler.timers.length, 0)
  scheduler.advance(60000)
  assert.equal(fake.calls, 1)
})

test('stop() ignores a rejection of the request in flight too', async () => {
  const { scheduler, fake, results, poller } = setup({ rejectOnAbort: true })
  poller.start()
  poller.stop()
  await flush()
  assert.equal(results.length, 0)
  assert.equal(scheduler.timers.length, 0)
})

test('start() and visible() after stop() send nothing', () => {
  const { scheduler, fake, poller } = setup()
  poller.start()
  poller.stop()
  const calls = fake.calls
  poller.start()
  poller.visible()
  assert.equal(fake.calls, calls)
  assert.equal(scheduler.timers.length, 0)
})

test('an answer of an invalid shape is reported as a failure', async () => {
  const { scheduler, fake, results, poller } = setup()
  poller.start()
  fake.entries[0].resolve({ status: 200, body: 'x' })
  await flush()
  assert.deepEqual(results, [{ kind: 'failure' }])
  assert.equal(scheduler.nextTimers()[0].ms, 15000)
})

test('a request that throws at once is reported as a failure', async () => {
  const scheduler = makeScheduler()
  const results = []
  const poller = createPoller({
    request: () => { throw new Error('no network') },
    hidden: () => false,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    onResult: (result) => results.push(result),
    createAbortController: makeController,
  })
  poller.start()
  await flush()
  assert.deepEqual(results, [{ kind: 'failure' }])
  assert.equal(scheduler.nextTimers()[0].ms, 15000)
})

test('onResult receives the objects classify returns', async () => {
  const answers = [PENDING, PLAN_REFRESHING, PLAN_IDLE, ERROR_ANSWER, { status: 200, body: 'x' }]
  for (const answer of answers) {
    const { fake, results, poller } = setup()
    poller.start()
    fake.entries[0].resolve(answer)
    await flush()
    assert.equal(results.length, 1)
    assert.deepEqual(results[0], classify(answer.status, answer.body))
  }
})
// ---- The optional answer reader and delay (the chat poller passes its own) ----
// Validates: Requirements 6.7
test('classifyAnswer turns the answer into the result onResult receives, in place of classify', async () => {
  const scheduler = makeScheduler()
  const fake = makeRequest()
  const results = []
  const seen = []
  const poller = createPoller({
    request: fake.request,
    hidden: () => false,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    onResult: (result) => results.push(result),
    createAbortController: makeController,
    classifyAnswer: (status, body) => {
      seen.push([status, body])
      return { kind: 'custom', status }
    },
  })
  poller.start()
  fake.entries[0].resolve({ status: 200, body: { any: 'thing' } })
  await flush()
  assert.deepEqual(seen, [[200, { any: 'thing' }]])
  assert.deepEqual(results, [{ kind: 'custom', status: 200 }])
})
test('delay sets the next timer in place of nextDelay, for answers and for failures', async () => {
  const scheduler = makeScheduler()
  const fake = makeRequest()
  const delays = []
  const poller = createPoller({
    request: fake.request,
    hidden: () => false,
    setTimer: scheduler.setTimer,
    clearTimer: scheduler.clearTimer,
    onResult: () => {},
    createAbortController: makeController,
    classifyAnswer: (status) => (status === 200 ? { kind: 'custom' } : { kind: 'failure' }),
    delay: (result) => {
      delays.push(result.kind)
      return result.kind === 'custom' ? 5000 : 7000
    },
  })
  poller.start()
  fake.entries[0].resolve({ status: 200, body: {} })
  await flush()
  assert.equal(scheduler.nextTimers()[0].ms, 5000)
  scheduler.fire(scheduler.nextTimers()[0].id)
  fake.entries[1].reject(new Error('down'))
  await flush()
  assert.equal(scheduler.nextTimers()[0].ms, 7000)
  assert.deepEqual(delays, ['custom', 'failure'])
})
test('without the two options the plan behaviour is unchanged', async () => {
  const { scheduler, fake, results, poller } = setup()
  poller.start()
  fake.entries[0].resolve(PENDING)
  await flush()
  assert.deepEqual(results, [{ kind: 'pending' }])
  assert.equal(scheduler.nextTimers()[0].ms, 2000)
})
