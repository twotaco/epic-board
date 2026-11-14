// Property 8: A shown plan is replaced only by an answer.
// Validates: Requirements 9.1, 9.5
//
// Also covers classify, the reducer, the view table of the design ("View state") and nextDelay.
import test from 'node:test'
import assert from 'node:assert/strict'

import { ageText, classify, columnsOf, initialState, nextDelay, reduce, viewOf } from '../../ui/index.mjs'
import { forSeeds } from './support.mjs'

const ITERATIONS = 200
const STATUSES = ['planned', 'in progress', 'done']

// ---- Generators ----

// A new plan object each call, so a test can tell one plan from another by identity.
function randomPlan(r) {
  const groups = []
  const groupCount = r.int(0, 3)
  for (let g = 0; g < groupCount; g += 1) {
    const cards = []
    const size = r.bool(0.3) ? 0 : r.int(1, 3)
    for (let i = 0; i < size; i += 1) {
      cards.push({ name: `Story ${g}-${i}`, status: r.pick(STATUSES), spec: `spec-${g}-${i}`, tasks: null, epic: null, description: '' })
    }
    groups.push({ epic: r.bool(0.7) ? { name: `Epic ${g}`, file: `epic-${g}.md` } : null, cards })
  }
  const fetch = r.pick([
    { ok: null },
    { ok: true },
    { ok: false, reason: `reason ${r.int(0, 99)}` },
  ])
  let commit = ''
  for (let i = r.int(7, 40); i > 0; i -= 1) commit += r.pick([...'0123456789abcdef'])
  return {
    repository: '/x',
    branch: r.pick(['main', 'master', 'trunk']),
    ref: 'origin/main',
    commit,
    fetch,
    groups,
    problems: r.bool(0.3) ? [{ file: 'a.md', reason: 'bad' }] : [],
    age_seconds: r.bool(0.3) ? null : r.int(0, 200000),
    refreshing: r.bool(),
  }
}

function randomError(r) {
  const error = { code: r.pick(['repository_not_configured', 'ref_unreadable', 'internal']), message: `message ${r.int(0, 99)}` }
  if (r.bool(0.4)) error.settings = ['EPIC_BOARD_REPOSITORY', 'config.json']
  return error
}

// One answer as the page receives it: {status, body, kind}, with the kind classify must give.
function randomAnswer(r) {
  switch (r.int(0, 3)) {
    case 0: return { kind: 'plan', status: 200, body: randomPlan(r) }
    case 1: return { kind: 'error', status: r.pick([409, 500, 502]), body: { error: randomError(r) } }
    case 2: return { kind: 'pending', status: 202, body: { pending: true } }
    default: {
      // A failure: a connection failure, a timeout or bad JSON (null body), or a body of an unknown shape.
      const shape = r.pick([
        [null, null],
        [200, null],
        [202, { pending: false }],
        [202, {}],
        [200, {}],
        [200, 'x'],
        [500, 'oops'],
      ])
      return { kind: 'failure', status: shape[0], body: shape[1] }
    }
  }
}

// ---- classify ----

test('classify: a 202 with {pending: true} is pending', () => {
  assert.deepEqual(classify(202, { pending: true }), { kind: 'pending' })
})

test('classify: other 202 answers are failures', () => {
  assert.deepEqual(classify(202, { pending: false }), { kind: 'failure' })
  assert.deepEqual(classify(202, {}), { kind: 'failure' })
})

test('classify: a body that is not an object or has neither groups nor error is a failure', () => {
  assert.deepEqual(classify(200, null), { kind: 'failure' })
  assert.deepEqual(classify(200, {}), { kind: 'failure' })
  assert.deepEqual(classify(200, 'x'), { kind: 'failure' })
  assert.deepEqual(classify(200, []), { kind: 'failure' })
  assert.deepEqual(classify(200, { groups: 'x' }), { kind: 'failure' })
})

test('classify: a body with a groups array is a plan', () => {
  const body = { groups: [] }
  const result = classify(200, body)
  assert.equal(result.kind, 'plan')
  assert.equal(result.plan, body)
})

test('classify: a body with an error object is an error, whatever the error status', () => {
  const conflict = { error: { code: 'repository_not_configured', message: 'Not set.' } }
  const result409 = classify(409, conflict)
  assert.equal(result409.kind, 'error')
  assert.equal(result409.error, conflict.error)
  const internal = { error: { code: 'internal', message: 'The plan could not be built.' } }
  const result500 = classify(500, internal)
  assert.equal(result500.kind, 'error')
  assert.equal(result500.error, internal.error)
})

// ---- nextDelay ----

test('nextDelay: 2000 for pending and for a refreshing plan, 15000 otherwise', () => {
  assert.equal(nextDelay(classify(202, { pending: true })), 2000)
  assert.equal(nextDelay(classify(200, { groups: [], refreshing: true })), 2000)
  assert.equal(nextDelay(classify(200, { groups: [], refreshing: false })), 15000)
  assert.equal(nextDelay(classify(200, { groups: [] })), 15000)
  assert.equal(nextDelay(classify(409, { error: { code: 'c', message: 'm' } })), 15000)
  assert.equal(nextDelay(classify(500, { error: { code: 'c', message: 'm' } })), 15000)
  assert.equal(nextDelay(classify(200, null)), 15000)
  assert.equal(nextDelay(classify(202, { pending: false })), 15000)
  assert.equal(nextDelay({ kind: 'failure' }), 15000)
})

test('nextDelay follows the classify result of every generated answer', () => {
  forSeeds('nextDelay', ITERATIONS, (r) => {
    const answer = randomAnswer(r)
    const result = classify(answer.status, answer.body)
    assert.equal(result.kind, answer.kind)
    const expected = answer.kind === 'pending' || (answer.kind === 'plan' && answer.body.refreshing === true) ? 2000 : 15000
    assert.equal(nextDelay(result), expected)
  })
})

// ---- The view table ----

const noContent = initialState
const planOf = (overrides = {}) => ({
  repository: '/x', branch: 'main', ref: 'origin/main', commit: '9f2c1d4e5a6b7c8d',
  fetch: { ok: true },
  groups: [{ epic: null, cards: [{ name: 'A', status: 'planned', spec: null, tasks: null, epic: null, description: '' }] }],
  problems: [], age_seconds: 90, refreshing: false,
  ...overrides,
})
const apply = (state, ...answers) => answers.reduce((s, [status, body]) => reduce(s, classify(status, body)), state)

test('view: no content and not unreachable is loading', () => {
  assert.deepEqual(viewOf(noContent), { kind: 'loading' })
  assert.deepEqual(viewOf(apply(noContent, [202, { pending: true }])), { kind: 'loading' })
})

test('view: no content and unreachable is unreachable', () => {
  assert.deepEqual(viewOf(apply(noContent, [200, null])), { kind: 'unreachable' })
})

test('view: error content gives error with message, code and settings', () => {
  const error = { code: 'repository_not_configured', message: 'No repository is set.', settings: ['EPIC_BOARD_REPOSITORY', 'config.json'] }
  const view = viewOf(apply(noContent, [409, { error }]))
  assert.equal(view.kind, 'error')
  assert.equal(view.message, 'No repository is set.')
  assert.equal(view.code, 'repository_not_configured')
  assert.deepEqual(view.settings, ['EPIC_BOARD_REPOSITORY', 'config.json'])
})

test('view: an error without settings has an empty settings list', () => {
  const view = viewOf(apply(noContent, [500, { error: { code: 'internal', message: 'The plan could not be built.' } }]))
  assert.equal(view.kind, 'error')
  assert.deepEqual(view.settings, [])
})

test('view: error content with unreachable is unreachable', () => {
  const state = apply(noContent, [409, { error: { code: 'c', message: 'm' } }], [200, null])
  assert.deepEqual(viewOf(state), { kind: 'unreachable' })
})

test('view: plan content gives plan, with the header fields', () => {
  const plan = planOf()
  const view = viewOf(apply(noContent, [200, plan]))
  assert.equal(view.kind, 'plan')
  assert.equal(view.plan, plan)
  assert.equal(view.branch, 'main')
  assert.equal(view.commit7, '9f2c1d4')
  assert.equal(view.ageText, ageText(90))
  assert.equal(view.refreshing, false)
  assert.equal(view.unreachableNotice, false)
  assert.equal(view.failedFetch, null)
  assert.deepEqual(view.problems, [])
  assert.equal(view.empty, false)
  assert.deepEqual(view.columns, columnsOf(plan))
})

test('view: refreshing is true only when the plan says true', () => {
  assert.equal(viewOf(apply(noContent, [200, planOf({ refreshing: true })])).refreshing, true)
  assert.equal(viewOf(apply(noContent, [200, planOf({ refreshing: false })])).refreshing, false)
})

test('view: unreachableNotice is true after a failure that follows a plan', () => {
  const view = viewOf(apply(noContent, [200, planOf()], [200, null]))
  assert.equal(view.kind, 'plan')
  assert.equal(view.unreachableNotice, true)
})

test('view: failedFetch is set only when fetch.ok is false, with the reason and the age text', () => {
  const failed = viewOf(apply(noContent, [200, planOf({ fetch: { ok: false, reason: 'no route to host' }, age_seconds: 7200 })]))
  assert.deepEqual(failed.failedFetch, { reason: 'no route to host', ageText: ageText(7200) })
  assert.equal(failed.failedFetch.ageText, 'Updated 2 hours ago')

  const noAge = viewOf(apply(noContent, [200, planOf({ fetch: { ok: false, reason: 'x' }, age_seconds: null })]))
  assert.equal(noAge.failedFetch.ageText, 'Not yet updated from origin')

  assert.equal(viewOf(apply(noContent, [200, planOf({ fetch: { ok: null } })])).failedFetch, null)
  assert.equal(viewOf(apply(noContent, [200, planOf({ fetch: { ok: true } })])).failedFetch, null)
})

test('view: commit7 is the first 7 characters of the commit', () => {
  assert.equal(viewOf(apply(noContent, [200, planOf({ commit: '0123456789abcdef0123456789abcdef01234567' })])).commit7, '0123456')
  assert.equal(viewOf(apply(noContent, [200, planOf({ commit: 'abcdefg' })])).commit7, 'abcdefg')
})

test('view: a plan with no cards is empty, with columns null', () => {
  for (const groups of [[], [{ epic: { name: 'E', file: 'e.md' }, cards: [] }, { epic: null, cards: [] }]]) {
    const view = viewOf(apply(noContent, [200, planOf({ groups })]))
    assert.equal(view.kind, 'plan')
    assert.equal(view.empty, true)
    assert.equal(view.columns, null)
  }
})

test('view: problems is the plan\'s problems array, in order', () => {
  const problems = [{ file: 'b.md', reason: 'second' }, { file: 'a.md', reason: 'first' }]
  const view = viewOf(apply(noContent, [200, planOf({ problems })]))
  assert.deepEqual(view.problems, problems)
})

// ---- One update replaces the old state ----

test('update: a plan after an error removes the error', () => {
  const state = apply(noContent, [409, { error: { code: 'c', message: 'm' } }], [200, planOf()])
  assert.equal(state.content.type, 'plan')
  const view = viewOf(state)
  assert.equal(view.kind, 'plan')
  assert.equal(view.message, undefined)
  assert.equal(view.code, undefined)
})

test('update: a plan after an unreachable plan clears unreachableNotice', () => {
  const before = apply(noContent, [200, planOf()], [200, null])
  assert.equal(viewOf(before).unreachableNotice, true)
  assert.equal(viewOf(reduce(before, classify(200, planOf()))).unreachableNotice, false)
})

test('update: a plan after a failed-fetch plan with fetch.ok true clears failedFetch', () => {
  const before = apply(noContent, [200, planOf({ fetch: { ok: false, reason: 'down' } })])
  assert.notEqual(viewOf(before).failedFetch, null)
  assert.equal(viewOf(reduce(before, classify(200, planOf({ fetch: { ok: true } })))).failedFetch, null)
  assert.equal(viewOf(reduce(before, classify(200, planOf({ fetch: { ok: null } })))).failedFetch, null)
})

test('update: a pending answer clears the unreachableNotice and keeps the plan', () => {
  const plan = planOf()
  const before = apply(noContent, [200, plan], [200, null])
  const view = viewOf(reduce(before, classify(202, { pending: true })))
  assert.equal(view.kind, 'plan')
  assert.equal(view.plan, plan)
  assert.equal(view.unreachableNotice, false)
})

test('update: an error after a plan replaces the plan view with the error view', () => {
  const state = apply(noContent, [200, planOf()], [500, { error: { code: 'internal', message: 'Broken.' } }])
  const view = viewOf(state)
  assert.equal(view.kind, 'error')
  assert.equal(view.message, 'Broken.')
  assert.equal(view.plan, undefined)
  assert.equal(view.columns, undefined)
})

test('update: a pending answer after the unreachable no-plan state gives loading again', () => {
  const unreachable = apply(noContent, [200, null])
  assert.equal(viewOf(unreachable).kind, 'unreachable')
  assert.equal(viewOf(reduce(unreachable, classify(202, { pending: true }))).kind, 'loading')
})

test('update: a pending answer after an error shown and then unreachable shows the error, not loading', () => {
  const error = { code: 'c', message: 'm' }
  const unreachable = apply(noContent, [409, { error }], [200, null])
  assert.equal(viewOf(unreachable).kind, 'unreachable')
  const view = viewOf(reduce(unreachable, classify(202, { pending: true })))
  assert.equal(view.kind, 'error')
  assert.equal(view.message, 'm')
})

test('update: a plan after the unreachable no-plan state shows the plan with no notice', () => {
  const view = viewOf(apply(noContent, [200, null], [200, planOf()]))
  assert.equal(view.kind, 'plan')
  assert.equal(view.unreachableNotice, false)
})

test('reduce does not change the state it is given', () => {
  const before = apply(noContent, [200, planOf()])
  const copy = structuredClone(before)
  reduce(before, classify(200, null))
  reduce(before, classify(202, { pending: true }))
  reduce(before, classify(409, { error: { code: 'c', message: 'm' } }))
  assert.deepEqual(before, copy)
  assert.deepEqual(initialState, { content: null, unreachable: false })
})

// ---- Property 8 ----

test('Property 8: a shown plan is replaced only by an answer', () => {
  forSeeds('a shown plan is replaced only by an answer', ITERATIONS, (r) => {
    let state = initialState
    // What the sequence of answers so far implies, kept apart from the reducer.
    let shown = null // null, {type: 'plan', plan} or {type: 'error', error}: the latest plan or error answer
    let failed = false // the latest answer was a failure
    let seenContent = false // a plan or a backend error has been shown

    const length = r.int(1, 30)
    for (let step = 0; step < length; step += 1) {
      const answer = randomAnswer(r)
      const result = classify(answer.status, answer.body)
      assert.equal(result.kind, answer.kind, `step ${step}: classify gave ${result.kind} for a ${answer.kind}`)

      const before = state
      const viewBefore = viewOf(before)
      state = reduce(before, result)
      const view = viewOf(state)

      // Only a plan or an error answer changes what is shown; pending and failure keep it.
      if (result.kind === 'plan') shown = { type: 'plan', plan: answer.body }
      if (result.kind === 'error') shown = { type: 'error', error: answer.body.error }
      failed = result.kind === 'failure'
      if (shown !== null) seenContent = true

      if (shown === null) assert.equal(state.content, null)
      else {
        assert.equal(state.content.type, shown.type, `step ${step}`)
        assert.equal(shown.type === 'plan' ? state.content.plan : state.content.error, shown.type === 'plan' ? shown.plan : shown.error, `step ${step}`)
      }
      assert.equal(state.unreachable, failed, `step ${step}`)

      // A plan that is shown stays shown through pending and failure, unchanged.
      if ((result.kind === 'pending' || result.kind === 'failure') && viewBefore.kind === 'plan') {
        assert.equal(view.kind, 'plan', `step ${step}: ${result.kind} removed the plan`)
        assert.equal(view.plan, viewBefore.plan, `step ${step}: ${result.kind} changed the plan`)
        assert.equal(view.unreachableNotice, result.kind === 'failure', `step ${step}`)
      }

      // After a plan or a backend error has been shown, the view is never loading.
      if (seenContent) assert.notEqual(view.kind, 'loading', `step ${step}: loading after content was shown`)
      // After a plan has been shown the view is never unreachable (a failure only adds the notice).
      if (shown?.type === 'plan') {
        assert.equal(view.kind, 'plan', `step ${step}`)
        assert.equal(view.plan, shown.plan, `step ${step}`)
        assert.equal(view.unreachableNotice, failed, `step ${step}`)
      }

      // Exactly the design's view table.
      if (shown === null) {
        assert.equal(view.kind, failed ? 'unreachable' : 'loading', `step ${step}`)
      } else if (shown.type === 'error') {
        assert.equal(view.kind, failed ? 'unreachable' : 'error', `step ${step}`)
        if (!failed) {
          assert.equal(view.message, shown.error.message)
          assert.equal(view.code, shown.error.code)
          assert.deepEqual(view.settings, shown.error.settings ?? [])
        }
      }
      // loading is shown only while nothing has been shown and the latest answer was not a failure.
      assert.equal(view.kind === 'loading', shown === null && !failed, `step ${step}`)
      // unreachable is shown only after a failure, and never over a plan.
      assert.equal(view.kind === 'unreachable', failed && shown?.type !== 'plan', `step ${step}`)
    }
  })
})
