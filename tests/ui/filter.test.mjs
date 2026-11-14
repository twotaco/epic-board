// The epic filter: options, filtering, the view's effective key, and saving the choice.
import test from 'node:test'
import assert from 'node:assert/strict'

import { forSeeds } from './support.mjs'
import {
  FILTER_STORAGE_KEY, columnsOf, filterOptions, filterPlan, loadChoice, saveChoice, viewOf,
} from '../../ui/index.mjs'

const card = (id, status, extra = {}) => ({ id, name: id, description: '', status, spec: id, tasks: { done: 0, total: 1 }, ...extra })
const PLAN = {
  branch: 'main',
  commit: 'abcdef0123456789',
  age_seconds: 5,
  refreshing: false,
  fetch: { ok: true },
  problems: [{ file: 'bad.md', reason: 'broken' }],
  groups: [
    { epic: { file: 'one.md', name: 'One' }, cards: [card('one#a', 'planned'), card('one#b', 'done'), card('shared', 'planned')] },
    { epic: { file: 'empty.md', name: 'Empty' }, cards: [] },
    { epic: { file: 'two.md', name: 'One' }, cards: [card('two#a', 'in progress'), card('shared', 'planned')] },
    { epic: null, cards: [card('loose', 'done')] },
  ],
}
const stateOf = (plan) => ({ content: { type: 'plan', plan }, unreachable: false })
const idsOf = (columns) => columns.map((column) => column.groups.flatMap((group) => group.cards.map((c) => c.id)))

// ---- filterOptions ----

test('options: All epics first, empty groups skipped, No epic last, same names kept apart', () => {
  assert.deepEqual(filterOptions(PLAN), [
    { key: 'all', label: 'All epics' },
    { key: 'one.md', label: 'One' },
    { key: 'two.md', label: 'One' },
    { key: 'no-epic', label: 'No epic' },
  ])
})

test('options: no groups gives only All epics', () => {
  assert.deepEqual(filterOptions({ groups: [] }), [{ key: 'all', label: 'All epics' }])
  assert.deepEqual(filterOptions({}), [{ key: 'all', label: 'All epics' }])
})

// ---- filterPlan ----

test('filterPlan: all and an unknown key give the plan itself', () => {
  assert.equal(filterPlan(PLAN, 'all'), PLAN)
  assert.equal(filterPlan(PLAN, 'gone.md'), PLAN)
})

test('filterPlan: one epic, and No epic', () => {
  assert.deepEqual(filterPlan(PLAN, 'two.md').groups.map((g) => g.epic.file), ['two.md'])
  assert.deepEqual(filterPlan(PLAN, 'no-epic').groups.map((g) => g.epic), [null])
})

test('filterPlan: does not mutate, keeps card ids and other plan fields', () => {
  const before = JSON.stringify(PLAN)
  const filtered = filterPlan(PLAN, 'one.md')
  assert.equal(JSON.stringify(PLAN), before)
  assert.equal(filtered.branch, 'main')
  assert.deepEqual(filtered.groups[0].cards.map((c) => c.id), ['one#a', 'one#b', 'shared'])
})

test('filterPlan: a spec under two epics appears once', () => {
  const ids = idsOf(columnsOf(filterPlan(PLAN, 'two.md'))).flat()
  assert.equal(ids.filter((id) => id === 'shared').length, 1)
})

// ---- columns and viewOf ----

test('columns under a filter keep three columns and count only shown cards', () => {
  const columns = columnsOf(filterPlan(PLAN, 'no-epic'))
  assert.deepEqual(columns.map((c) => [c.key, c.count]), [['planned', 0], ['in progress', 0], ['done', 1]])
})

test('viewOf: filter key and columns follow the choice', () => {
  const view = viewOf(stateOf(PLAN), 'two.md')
  assert.equal(view.filter.key, 'two.md')
  assert.deepEqual(view.filter.options.map((o) => o.key), ['all', 'one.md', 'two.md', 'no-epic'])
  assert.deepEqual(view.columns.map((c) => c.count), [1, 1, 0])
})

test('viewOf: default and all show everything, same as before', () => {
  assert.deepEqual(viewOf(stateOf(PLAN)).columns, columnsOf(PLAN))
  assert.deepEqual(viewOf(stateOf(PLAN), 'all').columns, columnsOf(PLAN))
})

test('viewOf: a key not in the options falls back to all', () => {
  const view = viewOf(stateOf(PLAN), 'empty.md')
  assert.equal(view.filter.key, 'all')
  assert.deepEqual(view.columns, columnsOf(PLAN))
})

test('viewOf: empty, problems and notices ignore the filter', () => {
  const empty = viewOf(stateOf({ ...PLAN, groups: [{ epic: null, cards: [] }] }), 'one.md')
  assert.equal(empty.empty, true)
  const view = viewOf({ content: { type: 'plan', plan: { ...PLAN, fetch: { ok: false, reason: 'x' } } }, unreachable: true }, 'one.md')
  assert.deepEqual(view.problems, PLAN.problems)
  assert.ok(view.failedFetch)
  assert.equal(view.unreachableNotice, true)
})

test('property: filtered cards are the chosen group\'s cards, and all equals the unfiltered columns', () => {
  forSeeds('filter', 100, (rng) => {
    const groups = []
    const count = rng.int(0, 5)
    for (let g = 0; g < count; g += 1) {
      const cards = []
      for (let c = rng.int(0, 4); c > 0; c -= 1) cards.push(card(`g${g}c${c}`, rng.pick(['planned', 'in progress', 'done'])))
      groups.push({ epic: g === count - 1 && rng.bool() ? null : { file: `e${g}.md`, name: `E${g}` }, cards })
    }
    const plan = { ...PLAN, groups }
    assert.deepEqual(columnsOf(filterPlan(plan, 'all')), columnsOf(plan))
    const options = filterOptions(plan)
    const choice = rng.pick(options)
    const group = groups.find((g) => (g.epic ? g.epic.file : 'no-epic') === choice.key)
    const shown = idsOf(columnsOf(filterPlan(plan, choice.key))).flat().sort()
    const expected = choice.key === 'all' ? idsOf(columnsOf(plan)).flat().sort() : group.cards.map((c) => c.id).sort()
    assert.deepEqual(shown, expected)
  })
})

// ---- storage ----

const fakeStorage = () => {
  const map = new Map()
  return { map, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { map.set(k, v) } }
}
const throwing = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('full') } }

test('save: saveChoice writes the key under epic-board.filter', () => {
  const storage = fakeStorage()
  assert.equal(saveChoice(storage, 'one.md'), true)
  assert.equal(FILTER_STORAGE_KEY, 'epic-board.filter')
  assert.equal(storage.map.get('epic-board.filter'), 'one.md')
})

test('save: all is saved too', () => {
  const storage = fakeStorage()
  saveChoice(storage, 'all')
  assert.equal(storage.map.get('epic-board.filter'), 'all')
})

test('save: a throwing setItem does not throw', () => {
  assert.equal(saveChoice(throwing, 'one.md'), false)
  assert.equal(saveChoice(undefined, 'one.md'), false)
})

test('restore: loadChoice returns the saved key', () => {
  const storage = fakeStorage()
  storage.map.set('epic-board.filter', 'two.md')
  assert.equal(loadChoice(storage), 'two.md')
})

test('restore: nothing saved gives all', () => {
  assert.equal(loadChoice(fakeStorage()), 'all')
})

test('restore: no storage gives all', () => {
  assert.equal(loadChoice(undefined), 'all')
})

test('restore: a throwing getItem gives all', () => {
  assert.equal(loadChoice(throwing), 'all')
})

test('restore: a non-text value gives all', () => {
  for (const value of [5, {}, true, '']) assert.equal(loadChoice({ getItem: () => value }), 'all')
})

test('fallback: a saved epic missing from the plan shows all epics and resets the Saved_Choice', () => {
  const storage = fakeStorage()
  storage.map.set('epic-board.filter', 'gone.md')
  const view = viewOf(stateOf(PLAN), loadChoice(storage))
  assert.equal(view.filter.key, 'all')
  if (view.filter.key !== loadChoice(storage)) saveChoice(storage, view.filter.key)
  assert.equal(storage.map.get('epic-board.filter'), 'all')
})
