// Component wiring tests: createBoard run against a small fake React, a fake document,
// a fake fetch and a virtual clock. Also checks the default export and scans the page source.
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { h, findAll, textOf } from './support.mjs'
import { createBoard } from '../../ui/index.mjs'

const PLAN_URL = '/apps/epic-board/api/plan'
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PAGE_PATH = path.join(REPO_ROOT, 'ui', 'index.mjs')

// Lets promise callbacks run. Timers are fake, so a real setImmediate is safe.
const flush = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

// ---- Fakes ----

function makeClock() {
  let now = 0
  let nextId = 1
  let timers = []
  return {
    setTimeout(fn, ms) {
      const id = nextId
      nextId += 1
      timers.push({ id, at: now + ms, fn })
      return id
    },
    clearTimeout(id) {
      timers = timers.filter((timer) => timer.id !== id)
    },
    // Runs every timer that falls due within `ms`, in time order.
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = timers.filter((timer) => timer.at <= target)
        if (due.length === 0) break
        due.sort((a, b) => a.at - b.at || a.id - b.id)
        const timer = due[0]
        timers = timers.filter((other) => other !== timer)
        now = timer.at
        timer.fn()
      }
      now = target
    },
    pending: () => timers.length,
  }
}

function makeFetch() {
  const calls = []
  const controls = []
  const fetch = (url, options) => new Promise((resolve, reject) => {
    calls.push([url, options])
    controls.push({ resolve, reject })
    options?.signal?.addEventListener('abort', () => {
      const error = new Error('The operation was aborted')
      error.name = 'AbortError'
      reject(error)
    })
  })
  fetch.calls = calls
  fetch.answer = (index, status, body) => controls[index].resolve({ status, json: async () => body })
  fetch.badJson = (index) => controls[index].resolve({
    status: 200,
    json: async () => { throw new SyntaxError('Unexpected token < in JSON') },
  })
  fetch.fail = (index) => controls[index].reject(new TypeError('Failed to fetch'))
  return fetch
}

function makeDocument(hidden) {
  const listeners = []
  return {
    hidden,
    added: [],
    removed: [],
    addEventListener(type, fn) {
      this.added.push([type, fn])
      listeners.push({ type, fn })
    },
    removeEventListener(type, fn) {
      this.removed.push([type, fn])
      const index = listeners.findIndex((entry) => entry.type === type && entry.fn === fn)
      if (index >= 0) listeners.splice(index, 1)
    },
    fire(type) {
      for (const entry of [...listeners]) if (entry.type === type) entry.fn()
    },
    listenerCount: () => listeners.length,
  }
}

// A React that really runs the component: state per instance, re-render on dispatch,
// effects run after the first render, unmount runs the cleanup.
function mount({ hidden = false } = {}) {
  const clock = makeClock()
  const fetch = makeFetch()
  const document = makeDocument(hidden)

  let state
  let hasState = false
  let effect = null
  let effectRan = false
  let cleanup = null
  let unmounted = false
  let tree = null
  const instance = { renders: 0, dispatches: 0 }

  const dispatch = (action) => {
    instance.dispatches += 1
    if (unmounted) return
    state = reducerOf.current(state, action)
    render()
  }
  const reducerOf = { current: null }

  const React = {
    useReducer(reducer, initial) {
      reducerOf.current = reducer
      if (!hasState) {
        state = initial
        hasState = true
      }
      return [state, dispatch]
    },
    useEffect(fn) {
      if (!effectRan) effect = fn
    },
    createElement: h,
  }

  const Board = createBoard(React, {
    fetch,
    document,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  })

  function render() {
    instance.renders += 1
    tree = Board({})
    if (!effectRan && effect !== null) {
      effectRan = true
      const result = effect()
      cleanup = typeof result === 'function' ? result : null
    }
  }
  render()

  return {
    fetch,
    document,
    clock,
    instance,
    tree: () => tree,
    text: () => textOf(tree),
    unmount() {
      unmounted = true
      if (cleanup !== null) cleanup()
    },
  }
}

const PLAN = {
  branch: 'main',
  commit: 'abcdef0123456789',
  age_seconds: 5,
  refreshing: false,
  fetch: { ok: true },
  problems: [],
  groups: [
    {
      epic: { file: 'one.md', name: 'Epic One' },
      cards: [
        { name: 'Card Alpha', description: '', status: 'planned', spec: 'alpha', tasks: { done: 0, total: 2 } },
        { name: 'Card Beta', description: '', status: 'done', spec: 'beta', tasks: { done: 3, total: 3 } },
      ],
    },
  ],
}
const plan = (overrides = {}) => ({ ...PLAN, ...overrides })

const FAILURE_TEXT = 'Could not reach the backend.'
const NOTICE_TEXT = 'Could not reach the backend. Showing the plan from the last update.'

// ---- Requests ----

test('opening the page sends one GET of the plan route and nothing else across a run', async () => {
  const page = mount()
  assert.equal(page.fetch.calls.length, 1)
  const [url, options] = page.fetch.calls[0]
  assert.equal(url, PLAN_URL)
  assert.equal(options.method, 'GET')
  assert.equal(options.credentials, 'same-origin')
  assert.equal(options.cache, 'no-store')
  assert.equal(typeof options.signal?.aborted, 'boolean')
  assert.equal(options.signal.aborted, false)

  page.fetch.answer(0, 200, plan({ refreshing: true }))
  await flush()
  page.clock.advance(2000)
  assert.equal(page.fetch.calls.length, 2)
  page.fetch.answer(1, 200, plan())
  await flush()
  page.clock.advance(15000)
  assert.equal(page.fetch.calls.length, 3)
  page.fetch.fail(2)
  await flush()
  page.clock.advance(15000)
  assert.equal(page.fetch.calls.length, 4)

  for (const [callUrl, callOptions] of page.fetch.calls) {
    assert.equal(callUrl, PLAN_URL)
    assert.deepEqual(Object.keys(callOptions).sort(), ['cache', 'credentials', 'method', 'signal'])
    assert.equal(callOptions.method, 'GET')
  }
})

test('the first render shows Loading…, then the board with no second Loading…', async () => {
  const page = mount()
  assert.match(page.text(), /Loading…/)
  assert.doesNotMatch(page.text(), /Card Alpha/)

  page.fetch.answer(0, 200, plan())
  await flush()
  const text = page.text()
  assert.match(text, /Card Alpha/)
  assert.match(text, /Card Beta/)
  assert.doesNotMatch(text, /Loading…/)
  assert.equal(page.instance.renders, 2)
})

test('a 202 pending answer keeps Loading… and requests again after 2000 ms', async () => {
  const page = mount()
  page.fetch.answer(0, 202, { pending: true })
  await flush()
  assert.match(page.text(), /Loading…/)
  page.clock.advance(1999)
  assert.equal(page.fetch.calls.length, 1)
  page.clock.advance(1)
  assert.equal(page.fetch.calls.length, 2)
})

test('a plan with refreshing true requests again after 2000 ms', async () => {
  const page = mount()
  page.fetch.answer(0, 200, plan({ refreshing: true }))
  await flush()
  page.clock.advance(1999)
  assert.equal(page.fetch.calls.length, 1)
  page.clock.advance(1)
  assert.equal(page.fetch.calls.length, 2)
})

test('a plan with refreshing false requests again after 15000 ms', async () => {
  const page = mount()
  page.fetch.answer(0, 200, plan({ refreshing: false }))
  await flush()
  page.clock.advance(14999)
  assert.equal(page.fetch.calls.length, 1)
  page.clock.advance(1)
  assert.equal(page.fetch.calls.length, 2)
})

test('a rejected fetch shows the failure text and requests again after 15000 ms', async () => {
  const page = mount()
  page.fetch.fail(0)
  await flush()
  assert.match(page.text(), /Could not reach the backend\./)
  assert.equal(findAll(page.tree(), (node) => node.props.role === 'alert').length, 1)
  assert.doesNotMatch(page.text(), /Loading…/)
  page.clock.advance(14999)
  assert.equal(page.fetch.calls.length, 1)
  page.clock.advance(1)
  assert.equal(page.fetch.calls.length, 2)
})

test('a body that is not JSON shows the failure text and requests again after 15000 ms', async () => {
  const page = mount()
  page.fetch.badJson(0)
  await flush()
  assert.equal(textOf(page.tree()).includes(FAILURE_TEXT), true)
  assert.doesNotMatch(page.text(), /Loading…/)
  page.clock.advance(14999)
  assert.equal(page.fetch.calls.length, 1)
  page.clock.advance(1)
  assert.equal(page.fetch.calls.length, 2)
})

test('a failure after a plan keeps the board and adds the last-update notice', async () => {
  const page = mount()
  page.fetch.answer(0, 200, plan())
  await flush()
  assert.doesNotMatch(page.text(), /Could not reach the backend/)
  page.clock.advance(15000)
  page.fetch.fail(1)
  await flush()
  const text = page.text()
  assert.match(text, /Card Alpha/)
  assert.match(text, /Card Beta/)
  assert.equal(text.includes(NOTICE_TEXT), true)
  assert.equal(findAll(page.tree(), (node) => node.props.role === 'alert').length, 0)
  page.clock.advance(15000)
  assert.equal(page.fetch.calls.length, 3)
})

// ---- Visibility ----

test('a hidden page sends no request until it becomes visible, then requests at once', async () => {
  const page = mount({ hidden: true })
  assert.equal(page.fetch.calls.length, 0)
  assert.match(page.text(), /Loading…/)
  page.clock.advance(60000)
  assert.equal(page.fetch.calls.length, 0)

  page.document.fire('visibilitychange')
  assert.equal(page.fetch.calls.length, 0, 'a change event while still hidden requests nothing')

  page.document.hidden = false
  page.document.fire('visibilitychange')
  assert.equal(page.fetch.calls.length, 1)
  assert.equal(page.fetch.calls[0][0], PLAN_URL)
})

test('becoming visible after an answer requests at once without waiting for the timer', async () => {
  const page = mount()
  page.fetch.answer(0, 200, plan())
  await flush()
  page.document.hidden = true
  page.document.fire('visibilitychange')
  assert.equal(page.fetch.calls.length, 1)
  page.clock.advance(15000)
  assert.equal(page.fetch.calls.length, 1, 'no request while hidden')
  page.document.hidden = false
  page.document.fire('visibilitychange')
  assert.equal(page.fetch.calls.length, 2)
})

// ---- Unmount ----

test('unmounting removes the same listener it added', async () => {
  const page = mount()
  assert.equal(page.document.added.length, 1)
  assert.equal(page.document.added[0][0], 'visibilitychange')
  assert.equal(page.document.listenerCount(), 1)
  page.unmount()
  assert.equal(page.document.removed.length, 1)
  assert.equal(page.document.removed[0][0], 'visibilitychange')
  assert.equal(page.document.removed[0][1], page.document.added[0][1])
  assert.equal(page.document.listenerCount(), 0)
})

test('unmounting clears pending timers and sends no further request', async () => {
  const page = mount()
  page.fetch.answer(0, 200, plan())
  await flush()
  assert.ok(page.clock.pending() > 0)
  page.unmount()
  assert.equal(page.clock.pending(), 0)
  page.clock.advance(60000)
  page.document.hidden = false
  page.document.fire('visibilitychange')
  assert.equal(page.fetch.calls.length, 1)
})

test('unmounting aborts an in-flight fetch and a late answer causes no dispatch or render', async () => {
  const page = mount()
  const { signal } = page.fetch.calls[0][1]
  assert.equal(signal.aborted, false)
  const rendersBefore = page.instance.renders
  page.unmount()
  assert.equal(signal.aborted, true)
  assert.equal(page.clock.pending(), 0)

  page.fetch.answer(0, 200, plan())
  await flush()
  assert.equal(page.instance.dispatches, 0)
  assert.equal(page.instance.renders, rendersBefore)
  assert.equal(page.fetch.calls.length, 1)
})

// ---- The default export ----

let freshCount = 0
const freshPage = () => import(`../../ui/index.mjs?fresh=${freshCount += 1}`)

test('the default export looks React up on first call and builds the component once', async () => {
  const page = await freshPage()
  const created = []
  let lookups = 0
  const React = {
    useReducer: (reducer, initial) => [initial, () => {}],
    useEffect: () => {},
    createElement: (...args) => { created.push(args); return { element: args } },
  }
  globalThis.window = {
    __kirocrew_modules: {
      get react() {
        lookups += 1
        return React
      },
    },
  }
  try {
    assert.equal(lookups, 0, 'nothing is looked up at import')
    const props = { a: 1 }
    const first = page.default(props)
    const second = page.default(props)
    assert.equal(lookups, 1)
    assert.equal(created.length, 2)
    assert.equal(typeof created[0][0], 'function')
    assert.equal(created[0][0], created[1][0], 'two calls give the same component type')
    assert.equal(created[0][1], props)
    assert.equal(first.element, created[0])
    assert.equal(second.element, created[1])
  } finally {
    delete globalThis.window
  }
})

test('importing the module in a clean process with no window does not throw', () => {
  const output = execFileSync(
    process.execPath,
    ['--input-type=module', '-e', "const m = await import('./ui/index.mjs'); if (typeof m.default !== 'function') process.exit(3)"],
    { cwd: REPO_ROOT, encoding: 'utf8' },
  )
  assert.equal(output, '')
})

// ---- Source scan ----

test('the page source has no innerHTML, script injection, other network paths or extra URLs', () => {
  const source = readFileSync(PAGE_PATH, 'utf8')
  for (const word of ['innerHTML', 'dangerouslySetInnerHTML', 'eval', 'XMLHttpRequest', 'sendBeacon', 'WebSocket', 'EventSource']) {
    assert.equal(new RegExp(`\\b${word}\\b`).test(source), false, `${word} is not used`)
  }
  assert.equal(/\bnew\s+Function\b/.test(source), false)

  assert.equal(/\bfetch\s*\(/.test(source), false, 'no direct fetch( call')
  const calls = source.match(/\bfetchFn\s*\(/g) ?? []
  assert.equal(calls.length, 1)
  assert.equal(/\bfetchFn\s*\(\s*PLAN_URL\s*,/.test(source), true, 'the one call is on PLAN_URL')

  // The paths the page may use: the plan route, the backend's chats route, and the chat paths of
  // start-a-story (Requirements 4, 6 and 8). Quoted paths first, then the ones built in a template.
  const allowed = new Set([PLAN_URL, '/chats', '/api/chat/slots', '/api/chat'])
  const urls = source.match(/['"`](?:https?:)?\/[A-Za-z0-9_\-./]*['"`]/g) ?? []
  assert.deepEqual([...new Set(urls.map((url) => url.slice(1, -1)))].sort(), [...allowed].sort())
  assert.equal(/https?:\/\//.test(source), false)
  // Requirement 6, criterion 6: the page never sends a request that approves, rejects or answers
  // anything for a chat, and never stops or closes one. Nothing in Crew stops it, so this scan does.
  const starts = [...source.matchAll(/[`'"](\/(?:api|chats)[^`'"$]*)/g)].map((match) => match[1])
  assert.ok(starts.length >= 4, 'the scan found the page\'s paths')
  for (const start of starts) {
    assert.ok(['/api/chat/slots', '/api/chat', '/chats', PLAN_URL].some((prefix) => start.startsWith(prefix)), `unexpected path ${start}`)
    assert.doesNotMatch(start, /approve|question|approvals|stop|close|steer|note|context|delete/i, `forbidden path ${start}`)
  }
  assert.equal(/\/api\/approvals/.test(source), false)
  assert.equal(/slots\/\$\{[^}]*\}\/(?!resume)/.test(source), false, 'the only per-chat route built in a template is resume')
})
