// Property 5: Progress text matches the counts.
// Validates: Requirements 3.4
import test from 'node:test'
import assert from 'node:assert/strict'

import { progressOf } from '../../ui/index.mjs'
import { forSeeds } from './support.mjs'

const card = (spec, tasks) => ({ name: 'A story', status: 'planned', spec, tasks, description: '', epic: null })

test('Property 5: the text and the fraction follow done and total', () => {
  forSeeds('progress text matches the counts', 200, (random) => {
    // Totals of 1 are common enough to be hit in every run.
    const total = random.bool(0.2) ? 1 : random.int(1, 500)
    const done = random.int(0, total)
    const result = progressOf(card(`spec-${random.int(0, 99)}`, { done, total }))

    assert.equal(result.text, `${done} of ${total} ${total === 1 ? 'task' : 'tasks'}`)
    assert.equal(result.fraction, done / total)
    assert.ok(result.fraction >= 0 && result.fraction <= 1, `fraction ${result.fraction} is outside 0..1`)
  })
})

test('no spec gives "No spec yet" and no fraction', () => {
  assert.deepEqual(progressOf(card(null, null)), { text: 'No spec yet', fraction: null })
  assert.deepEqual(progressOf(card(null, { done: 1, total: 2 })), { text: 'No spec yet', fraction: null })
})

test('a spec whose tasks are none gives "Tasks could not be read" and no fraction', () => {
  assert.deepEqual(progressOf(card('a-spec', null)), { text: 'Tasks could not be read', fraction: null })
})

test('total 0 gives "No tasks yet" and no fraction', () => {
  assert.deepEqual(progressOf(card('a-spec', { done: 0, total: 0 })), { text: 'No tasks yet', fraction: null })
})

test('total 1 reads "task" in the singular, whatever done is', () => {
  assert.deepEqual(progressOf(card('a-spec', { done: 1, total: 1 })), { text: '1 of 1 task', fraction: 1 })
  assert.deepEqual(progressOf(card('a-spec', { done: 0, total: 1 })), { text: '0 of 1 task', fraction: 0 })
})

test('totals other than 1 read "tasks"', () => {
  assert.equal(progressOf(card('a-spec', { done: 0, total: 2 })).text, '0 of 2 tasks')
  assert.equal(progressOf(card('a-spec', { done: 3, total: 10 })).text, '3 of 10 tasks')
})

test('done above total clamps the fraction to 1', () => {
  assert.equal(progressOf(card('a-spec', { done: 5, total: 3 })).fraction, 1)
})
