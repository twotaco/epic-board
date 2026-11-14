// Smoke tests for the helpers in support.mjs and for importing the page under Node.
import test from 'node:test'
import assert from 'node:assert/strict'

import { rng, forSeeds, h, findAll, textOf } from './support.mjs'

test('rng is repeatable and stays in range', () => {
  const a = rng(7)
  const b = rng(7)
  for (let i = 0; i < 20; i += 1) {
    const value = a.int(3, 5)
    assert.equal(value, b.int(3, 5))
    assert.ok(value >= 3 && value <= 5)
  }
  assert.ok(['x', 'y'].includes(rng(1).pick(['x', 'y'])))
  assert.equal(rng(1).bool(0), false)
  assert.equal(rng(1).bool(1), true)
})

test('forSeeds names the property and the seed when a run throws', () => {
  assert.throws(
    () => forSeeds('always fails', 3, () => { throw new Error('boom') }),
    /always fails.*seed \d+.*boom/,
  )
  let runs = 0
  forSeeds('passes', 4, () => { runs += 1 })
  assert.equal(runs, 4)
})

test('h builds inspectable trees', () => {
  const tree = h('div', null, h('p', { id: 'a' }, 'one', null, false), [h('p', null, 'two')], 3)
  assert.deepEqual(tree.props, {})
  assert.equal(tree.children.length, 3)
  assert.equal(findAll(tree, (node) => node.type === 'p').length, 2)
  assert.equal(findAll(tree, (node) => node.props.id === 'a').length, 1)
  assert.equal(textOf(tree), 'onetwo3')
})

test('the page module imports under Node with no window', async () => {
  assert.equal(typeof globalThis.window, 'undefined')
  const page = await import('../../ui/index.mjs')
  assert.equal(typeof page.default, 'function')
})

test('the default export looks React up on first call and returns createElement(Component, props)', async () => {
  const calls = []
  globalThis.window = {
    __kirocrew_modules: {
      react: {
        useReducer: (reducer, initial) => [initial, () => {}],
        useEffect: () => {},
        createElement: (...args) => { calls.push(args); return { element: args } },
      },
    },
  }
  try {
    const page = await import('../../ui/index.mjs')
    const props = { a: 1 }
    const element = page.default(props)
    assert.equal(calls.length, 1)
    assert.equal(typeof calls[0][0], 'function')
    assert.equal(calls[0][1], props)
    assert.equal(element.element, calls[0])
    page.default(props)
    assert.equal(calls[1][0], calls[0][0], 'the component is built once')
  } finally {
    delete globalThis.window
  }
})
