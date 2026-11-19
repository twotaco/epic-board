// Folded columns on a narrow screen (board-design, Requirement 7).
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  DEFAULT_FOLDS, FOLD_STORAGE_KEY, STYLE, classify, foldsFor, initialState, loadFolds, reduce, renderBoard, saveFolds, toggleFold, viewOf,
} from '../../ui/index.mjs'
import { findAll, h, textOf } from './support.mjs'

const card = (name, status) => ({ name, status, spec: null, tasks: null, epic: 'e.md', description: '' })
const plan = {
  repository: '/r', branch: 'main', ref: 'origin/main', commit: '9f2c1d4e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d', fetch: { ok: true },
  groups: [{ epic: { name: 'Epic', file: 'e.md' }, cards: [card('U', 'unplanned'), card('A', 'planned'), card('B', 'in progress'), card('C', 'done')] }],
  problems: [], age_seconds: 1, refreshing: false,
}
const planView = (folded) => ({ ...viewOf(reduce(initialState, classify(200, plan))), ...(folded ? { folded } : {}) })
const columnsIn = (tree) => findAll(tree, (node) => node.props['data-column'] !== undefined)
const foldOf = (column) => findAll(column, (node) => node.props.className === 'eb-fold')[0]
const bodyOf = (column) => findAll(column, (node) => node.props.className === 'eb-column-body')[0]

function memoryStorage(initial = {}) {
  const data = { ...initial }
  return { getItem: (key) => (key in data ? data[key] : null), setItem: (key, value) => { data[key] = String(value) }, data }
}

test('In progress starts open; Unplanned, Planned and Done start folded', () => {
  const defaults = { unplanned: true, planned: true, 'in progress': false, done: true }
  assert.deepEqual({ ...DEFAULT_FOLDS }, defaults)
  assert.deepEqual(foldsFor({}, 'p1'), defaults)
  assert.deepEqual(foldsFor(undefined, null), defaults)
})

test('folds are kept per project, and only true or false values count', () => {
  let folds = toggleFold({}, 'p1', 'planned')
  assert.deepEqual(foldsFor(folds, 'p1'), { unplanned: true, planned: false, 'in progress': false, done: true })
  assert.deepEqual(foldsFor(folds, 'p2'), { ...DEFAULT_FOLDS }, 'another project keeps the defaults')
  folds = toggleFold(folds, 'p1', 'planned')
  assert.equal(foldsFor(folds, 'p1').planned, true)
  assert.deepEqual(foldsFor({ p1: { planned: 'no', done: false, other: true } }, 'p1'), { unplanned: true, planned: true, 'in progress': false, done: false })
  // No project id (a single project) is kept under ''.
  assert.equal(foldsFor(toggleFold({}, null, 'done'), null).done, false)
})

test('toggleFold never changes the folds it was given', () => {
  const before = { p1: { planned: true } }
  const copy = JSON.parse(JSON.stringify(before))
  toggleFold(before, 'p1', 'planned')
  assert.deepEqual(before, copy)
})

test('the folds are saved and read back, and a missing or broken store gives {}', () => {
  const storage = memoryStorage()
  assert.equal(saveFolds(storage, { p1: { done: false } }), true)
  assert.deepEqual(JSON.parse(storage.data[FOLD_STORAGE_KEY]), { p1: { done: false } })
  assert.deepEqual(loadFolds(storage), { p1: { done: false } })
  assert.deepEqual(loadFolds(undefined), {})
  assert.deepEqual(loadFolds(memoryStorage({ [FOLD_STORAGE_KEY]: 'not json' })), {})
  assert.deepEqual(loadFolds(memoryStorage({ [FOLD_STORAGE_KEY]: '[1]' })), {})
  assert.deepEqual(loadFolds({ getItem: () => { throw new Error('blocked') } }), {})
  assert.equal(saveFolds(undefined, {}), false)
  assert.equal(saveFolds({ setItem: () => { throw new Error('full') } }, {}), false)
})

test('each column heading holds a fold button that says whether its cards show', () => {
  const tree = renderBoard(h, planView({ ...DEFAULT_FOLDS }))
  const columns = columnsIn(tree)
  assert.deepEqual(columns.map((column) => column.props['data-folded']), ['true', 'true', 'false', 'true'])
  columns.forEach((column, i) => {
    const fold = foldOf(column)
    const body = bodyOf(column)
    assert.equal(fold.type, 'button')
    assert.equal(fold.props.type, 'button')
    assert.equal(fold.props['aria-label'], ['Unplanned', 'Planned', 'In progress', 'Done'][i])
    assert.equal(fold.props['aria-expanded'], i === 2 ? 'true' : 'false')
    assert.equal(fold.props['aria-controls'], body.props.id)
    assert.equal(textOf(fold), '', 'the chevron is drawn by the style sheet, so the heading text is unchanged')
  })
  // A folded column still holds its cards; the style sheet hides them.
  assert.equal(findAll(columns[0], (node) => node.type === 'li').length, 1)
  assert.equal(new Set(columns.map((column) => bodyOf(column).props.id)).size, 4, 'the ids are distinct')
})

test('without folds every column shows, as before', () => {
  const tree = renderBoard(h, planView())
  assert.deepEqual(columnsIn(tree).map((column) => column.props['data-folded']), ['false', 'false', 'false', 'false'])
})

test('the fold button calls toggleColumn with its column', () => {
  const calls = []
  const tree = renderBoard(h, planView({ ...DEFAULT_FOLDS }), { toggleColumn: (key) => calls.push(key) })
  columnsIn(tree).forEach((column) => foldOf(column).props.onClick())
  assert.deepEqual(calls, ['unplanned', 'planned', 'in progress', 'done'])
})

test('the style sheet folds only in the one-column layout', () => {
  assert.match(STYLE, /\.eb-column\[data-folded='true'\] \.eb-column-body\s*\{\s*display:\s*none;\s*\}/)
  const wide = STYLE.slice(STYLE.indexOf('@container (min-width: 720px)'))
  assert.match(wide, /^@container \(min-width: 720px\) \{[^@]*\.eb-fold\s*\{\s*display:\s*none;\s*\}/)
  assert.match(wide, /^@container \(min-width: 720px\) \{[^@]*\.eb-column\[data-folded='true'\] \.eb-column-body\s*\{\s*display:\s*block;\s*\}/)
  assert.match(STYLE, /@media \(min-width: 720px\) \{[^@]*\.eb-fold\s*\{\s*display:\s*none;\s*\}/)
  assert.match(STYLE, /\.eb-fold:focus-visible\s*\{[^}]*outline:\s*2px solid currentColor/)
})
