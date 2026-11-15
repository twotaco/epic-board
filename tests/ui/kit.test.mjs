// The lookup of Crew's components: isComponent, pickKit and hostKit.
// Validates: Requirements 1.1, 1.2
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  TITLE_LEVEL, classify, hostKit, hostSelect, initialChats, initialSetup, initialState, isComponent, pickKit, reduce, renderBoard, renderPanel,
  renderSetupView, viewOf,
} from '../../ui/index.mjs'
import { forSeeds, h } from './support.mjs'

const NAMES = ['Btn', 'Card', 'CardTitle', 'Badge', 'PageHeader', 'EmptyState', 'ErrorNotice', 'Select']

test('isComponent accepts a function and an object with $$typeof, and nothing else', () => {
  assert.equal(isComponent(() => null), true)
  assert.equal(isComponent({ $$typeof: Symbol.for('react.memo'), type: () => null }), true)
  for (const value of [null, undefined, 'Btn', 3, {}, { render: () => null }]) assert.equal(isComponent(value), false)
})

test('pickKit keeps the components of a module by name and leaves everything else out', () => {
  const Btn = () => null
  const Card = { $$typeof: Symbol.for('react.forward_ref'), render: () => null }
  assert.deepEqual(pickKit({ Btn, Card, Badge: 'x', CardTitle: null, Other: () => null }), { Btn, Card })
  for (const module of [undefined, null, 'ui', 3, true, {}]) assert.deepEqual(pickKit(module), {})
})

test('pickKit leaves out a component whose getter throws and keeps the rest', () => {
  const Btn = () => null
  const module = { Btn, get Card() { throw new Error('no') } }
  assert.deepEqual(pickKit(module), { Btn })
})

test('hostKit is empty with no window, no module or a module that is not an object', () => {
  assert.equal(typeof globalThis.window, 'undefined')
  assert.deepEqual(hostKit(), {})
  assert.equal(hostSelect(), null)
  const Btn = () => null
  try {
    globalThis.window = {}
    assert.deepEqual(hostKit(), {})
    globalThis.window = { __kirocrew_modules: { '@kirocrew/ui': 'ui' } }
    assert.deepEqual(hostKit(), {})
    globalThis.window = { __kirocrew_modules: { '@kirocrew/ui': { Btn, Select: () => null } } }
    assert.deepEqual(Object.keys(hostKit()), ['Btn', 'Select'])
    assert.equal(hostSelect(), hostKit().Select)
  } finally {
    delete globalThis.window
  }
})

test('hostKit does not throw when reading the module throws', () => {
  try {
    globalThis.window = { get __kirocrew_modules() { throw new Error('no') } }
    assert.deepEqual(hostKit(), {})
  } finally {
    delete globalThis.window
  }
})

// Property 2: A kit lookup never throws and keeps only components.
// Validates: Requirements 1.1, 1.2
function randomValue(rng) {
  switch (rng.int(0, 8)) {
    case 0: return undefined
    case 1: return null
    case 2: return 'text'
    case 3: return rng.int(0, 100)
    case 4: return {}
    case 5: return () => null
    case 6: return { $$typeof: Symbol.for('react.memo'), type: () => null }
    case 7: return { render: () => null }
    default: return { get $$typeof() { throw new Error('getter') } }
  }
}

test('Property 2: a kit lookup never throws and keeps only components', () => {
  forSeeds('kit lookup', 200, (rng) => {
    const module = {}
    for (const name of [...NAMES, 'Other']) {
      if (rng.bool(0.8)) module[name] = randomValue(rng)
      else if (rng.bool(0.3)) Object.defineProperty(module, name, { get() { throw new Error('getter') }, enumerable: true })
    }
    const whole = rng.int(0, 5) === 0 ? randomValue(rng) : module
    const kit = pickKit(whole)
    if (whole !== module) {
      assert.deepEqual(kit, {}) // a module that is no module of components has none
      return
    }
    const expected = {}
    for (const name of NAMES) {
      try {
        if (isComponent(module[name])) expected[name] = module[name]
      } catch { /* a throwing getter is a missing component */ }
    }
    assert.deepEqual(kit, expected)
    assert.ok(Object.keys(kit).every((name) => NAMES.includes(name) && isComponent(kit[name])))
  })
})

// Property 1: The kit changes the look, never the words or the structure.
// Validates: Requirements 1.2, 1.3, 1.6, 2.4, 3.1, 3.2, 3.7, 4.1, 4.4, 4.5, 6.1, 6.4, 6.6, 6.7, 6.8
const SEVEN = ['Btn', 'Card', 'CardTitle', 'Badge', 'PageHeader', 'EmptyState', 'ErrorNotice']
const STATES = ['needs-you', 'interrupted', 'working', 'stalled', 'review', 'your-turn', 'missing']

// A tree node, or the nodes a component holds in its props (a PageHeader's title and actions, an ErrorNotice's footer).
const isNode = (value) => value !== null && typeof value === 'object' && 'type' in value && 'props' in value
function walkDeep(tree, visit) {
  if (Array.isArray(tree)) return tree.forEach((item) => walkDeep(item, visit))
  if (!isNode(tree)) return
  visit(tree)
  for (const value of Object.values(tree.props)) if (isNode(value) || Array.isArray(value)) walkDeep(value, visit)
  for (const child of tree.children) walkDeep(child, visit)
}
const nodesOf = (tree) => {
  const found = []
  walkDeep(tree, (node) => found.push(node))
  return found
}
// Every text the person can read: string children, and the string props a component draws as text.
function textsOf(tree) {
  const texts = []
  walkDeep(tree, (node) => {
    for (const child of node.children) if (typeof child === 'string') texts.push(child)
    for (const name of ['title', 'subtitle', 'message']) if (typeof node.props[name] === 'string') texts.push(node.props[name])
  })
  return texts.map((text) => text.trim()).filter(Boolean)
}
const allText = (node) => (typeof node === 'string' ? node : textsOf({ type: 'x', props: {}, children: [node] }).join(' '))
const headings = (tree) => nodesOf(tree).filter((node) => /^h[1-6]$/.test(String(node.type)) && node.props.className !== 'eb-title').map((node) => `${node.type}:${allText(node)}`)
const rolesIn = (tree) => nodesOf(tree).filter((node) => node.props.role !== undefined && node.props.role !== 'presentation').map((node) => node.props.role).filter((role) => role !== 'alert')
const pressesIn = (tree) => nodesOf(tree).filter((node) => typeof node.props.onClick === 'function').map((node) => allText(node)).sort()

function randomView(rng) {
  const cards = []
  for (let i = 0; i < rng.int(0, 4); i += 1) {
    cards.push({
      id: `e.md#C${i}`, name: `Card ${i}`, status: rng.pick(['planned', 'in progress', 'done']), epic: 'E',
      description: rng.bool() ? `About ${i}` : '', spec: rng.bool(0.7) ? `spec-${i}` : null,
      tasks: rng.bool(0.7) ? { done: rng.int(0, 3), total: rng.int(0, 3) } : null,
    })
  }
  const plan = { branch: 'main', commit: 'abcdef0123', age_seconds: rng.int(0, 5000), refreshing: rng.bool(), fetch: { ok: rng.bool(0.8) }, problems: [], groups: [{ epic: { name: 'E', file: 'e.md' }, cards }] }
  const state = rng.pick(['plan', 'plan', 'plan', 'loading', 'unreachable', 'error'])
  const base = state === 'plan' ? reduce(initialState, classify(200, plan))
    : state === 'error' ? reduce(initialState, classify(409, { error: { code: 'x', message: 'bad', settings: ['A', 'B'] } }))
      : state === 'unreachable' ? reduce(initialState, classify(200, null)) : initialState
  const records = cards.filter(() => rng.bool(0.5)).map((card) => ({ card_id: card.id, name: `n-${card.name}`, key: `k-${card.name}`, created: 't' }))
  const byKey = Object.fromEntries(records.map((record) => {
    const state = rng.pick(STATES)
    return [record.key, state === 'review' ? { state, review: { number: 3, url: 'https://example.com/pr/3', failed: rng.bool() } } : { state }]
  }))
  const chats = { ...initialChats, records, byKey, folder: { id: rng.bool(0.8) ? 'f' : null, reason: null }, missingSince: Object.fromEntries(records.map((r) => [r.key, 0])), at: rng.pick([1000, 100000]), failed: rng.bool(0.2), loaded: true }
  const first = cards[0]
  const ui = {
    asking: first && rng.bool(0.4) ? first.id : null,
    open: records[0] && rng.bool(0.4) ? { cardId: records[0].card_id, key: records[0].key } : null,
    briefs: records[0] && rng.bool(0.3) ? { [records[0].key]: { kind: rng.pick(['sending', 'failed']), reason: 'r' } } : {},
    resumes: records[1] && rng.bool(0.3) ? { [records[1].key]: { kind: rng.pick(['resuming', 'failed']), reason: 'r' } } : {},
    flows: first && rng.bool(0.2) ? { [first.id]: { kind: 'starting', step: 'create' } } : {},
  }
  const projects = rng.bool(0.4) ? { options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }], currentId: 'a' } : null
  return {
    ...viewOf(base), chats, ui, panelAvailable: rng.bool(), projects, projectsNotice: rng.bool(0.2),
    unconfigured: rng.bool(0.1), setupState: { phase: rng.pick(['closed', 'opening']) },
  }
}

function randomSetup(rng) {
  const folders = [{ id: 'f1', name: 'Alpha', project_dir: '/a' }, { id: 'f2', name: 'Beta', project_dir: '/b' }]
  const phase = rng.pick(['opening', 'error', 'ready', 'ready', 'saving'])
  return {
    ...initialSetup, phase, folders: rng.bool(0.2) ? [] : folders, checks: { f1: rng.bool(), f2: rng.bool() }, names: { f1: rng.bool() ? 'A' : '', f2: 'B' },
    setupInfo: rng.bool() ? { source: 'saved', config_has_projects: rng.bool(), projects: [] } : null, saveError: rng.bool(0.4) ? 'Went wrong' : null,
  }
}

test('Property 1: the kit changes the look, never the words or the structure', () => {
  forSeeds('kit changes the look only', 150, (rng) => {
    const names = SEVEN.filter(() => rng.bool())
    const kit = Object.fromEntries(names.map((name) => [name, () => null]))
    const whole = rng.bool(0.3) ? Object.fromEntries(SEVEN.map((name) => [name, () => null])) : kit
    const setup = randomSetup(rng)
    const view = randomView(rng)
    const pairs = [
      [renderBoard(h, view, {}, {}), renderBoard(h, view, {}, whole)],
      [renderSetupView(h, setup, {}, {}), renderSetupView(h, setup, {}, whole)],
      [renderPanel(h, { title: 'T' }, h('div', null), {}, {}), renderPanel(h, { title: 'T' }, h('div', null), {}, whole)],
    ]
    for (const [plain, kitted] of pairs) {
      assert.deepEqual(headings(kitted), headings(plain), 'headings')
      assert.deepEqual(rolesIn(kitted), rolesIn(plain), 'roles')
      assert.deepEqual(pressesIn(kitted), pressesIn(plain), 'controls and labels')
      const have = textsOf(kitted)
      for (const text of textsOf(plain)) assert.ok(have.some((candidate) => candidate.includes(text)), `text "${text}"`)
      // The card has no heading.
      for (const li of nodesOf(kitted).filter((node) => node.type === 'li')) assert.deepEqual(headings(li), [])
    }
    // A component that is in the kit draws its fake, one for each card; one that is not draws the fallback.
    const tree = pairs[0][1]
    const cardCount = nodesOf(pairs[0][0]).filter((node) => node.type === 'li' && node.props.className === 'eb-card eb-fb').length
    const cardsDrawn = nodesOf(tree).filter((node) => node.type === 'li' && /^eb-(card|item)/.test(node.props.className ?? ''))
    assert.equal(cardsDrawn.length, cardCount)
    if (whole.Card) assert.equal(nodesOf(tree).filter((node) => node.type === whole.Card).length, cardCount)
    else assert.ok(cardsDrawn.every((li) => li.props.className === 'eb-card eb-fb'))
    if (!whole.Btn) assert.ok(nodesOf(tree).filter((node) => node.type === 'button' && node.props['data-card-id'] === undefined).every((b) => b.props.className === 'eb-fb'))
    // The title is the one h1 either way, as an element or inside PageHeader.
    assert.equal(nodesOf(tree).filter((node) => node.type === `h${TITLE_LEVEL}`).length, 1)
    // No alert except on the two error states.
    const alerts = nodesOf(tree).filter((node) => node.props.role === 'alert').length
    if (!whole.ErrorNotice) assert.equal(alerts, nodesOf(pairs[0][0]).filter((node) => node.props.role === 'alert').length)
  })
})
