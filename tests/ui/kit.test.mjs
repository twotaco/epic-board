// The lookup of Crew's components: isComponent, pickKit and hostKit.
// Validates: Requirements 1.1, 1.2
import test from 'node:test'
import assert from 'node:assert/strict'

import { hostKit, hostSelect, isComponent, pickKit } from '../../ui/index.mjs'
import { forSeeds } from './support.mjs'

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
