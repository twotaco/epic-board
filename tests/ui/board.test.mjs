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
const BACKEND = '/apps/epic-board/api'
const PROJECTS_URL = `${BACKEND}/projects`
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const PAGE_PATH = path.join(REPO_ROOT, 'ui', 'index.mjs')

// Default projects for awaitProjects: one project so unconfigured = false and pollers start.
const DEFAULT_PROJECTS = [{ id: 'p', name: 'Project' }]
// Strips query string from a URL for loose equality checks.
const normalizeUrl = (url) => url.split('?')[0]

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
    now: () => now,
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
  fetch.answer = (index, status, body) => controls[index].resolve({ status, ok: status >= 200 && status < 300, json: async () => body })
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
    // Elements the page can find by `[data-card-id]`; a test registers them in `nodes`.
    nodes: [],
    // The question's "Start" buttons, found by `[data-eb-start]`; a test registers them in `startNodes`.
    startNodes: [],
    querySelectorAll(selector) {
      if (selector === '[data-eb-start]') return this.startNodes
      assert.equal(selector, '[data-card-id]')
      return this.nodes
    },
    // The Panel's container (chat or setup), which a test registers in `panel`.
    panel: null,
    // The Projects button, which a test registers in `setupBtn`.
    setupBtn: null,
    querySelector(selector) {
      if (selector === '[data-eb-panel]') return this.panel
      if (selector === '[data-eb-setup-btn]') return this.setupBtn ?? null
      assert.fail(`unexpected querySelector: ${selector}`)
      return null
    },
  }
}
// Crew's client (what useAppApi returns): every call stays pending until the test answers or fails it.
function makeGateway() {
  const calls = []
  const controls = []
  const send = (verb) => (path, ...rest) => new Promise((resolve, reject) => {
    calls.push([verb, path, ...rest])
    controls.push({ path, resolve, reject, done: false })
    const init = verb === 'get' ? rest[0] : undefined
    init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })))
  })
  const gateway = {
    calls,
    get: send('get'),
    post: send('post'),
    patch: send('patch'),
    paths: () => calls.map(([, path]) => path),
    // Settles the oldest pending call on `path`.
    answer(path, value) {
      const control = controls.find((candidate) => !candidate.done && candidate.path === path)
      assert.ok(control, `no pending call on ${path}; pending: ${controls.filter((c) => !c.done).map((c) => c.path).join(', ')}`)
      control.done = true
      control.resolve(value)
    },
    fail(path, error) {
      const control = controls.find((candidate) => !candidate.done && candidate.path === path)
      assert.ok(control, `no pending call on ${path}`)
      control.done = true
      control.reject(error)
    },
    pending: () => controls.filter((candidate) => !candidate.done).length,
  }
  return gateway
}
const httpError = (status, error = null) => Object.assign(new Error(`API ${status}`), { status, error })

// A React that really runs the component: any number of reducers, refs and effects, kept by call
// order; a dispatch re-renders at once; an effect runs after a render when it is new or its
// dependencies changed; unmount runs every cleanup. `fetch` is routed by URL: the plan route to
// `page.fetch` (what the plan tests use), the backend's chats routes to `page.chatFetch`. Crew's client
// is `page.gateway`, or none with `api: null`.
function mount({ hidden = false, api, storage, ChatPanel, kit } = {}) {
  const clock = makeClock()
  const planFetch = makeFetch()
  const chatFetch = makeFetch()
  const projectsFetch = makeFetch()
  const gateway = makeGateway()
  const document = makeDocument(hidden)
  const fetch = (url, options) => url.startsWith(PLAN_URL) ? planFetch(url, options) : url.startsWith(PROJECTS_URL) ? projectsFetch(url, options) : chatFetch(url, options)
  const hooks = []
  let cursor = 0
  let pending = []
  let rendering = false
  let again = false
  let unmounted = false
  let tree = null
  const instance = { renders: 0, dispatches: 0 }
  const React = {
    useReducer(reducer, initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) {
        const slot = { state: initial, reducer }
        slot.dispatch = (action) => {
          instance.dispatches += 1
          if (unmounted) return
          slot.state = slot.reducer(slot.state, action)
          render()
        }
        hooks[index] = slot
      }
      hooks[index].reducer = reducer
      return [hooks[index].state, hooks[index].dispatch]
    },
    useState(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) {
        const slot = { state: typeof initial === 'function' ? initial() : initial }
        slot.set = (value) => {
          if (unmounted) return
          slot.state = value
          render()
        }
        hooks[index] = slot
      }
      return [hooks[index].state, hooks[index].set]
    },
    useRef(initial) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect(fn, deps) {
      const index = cursor
      cursor += 1
      if (hooks[index] === undefined) hooks[index] = { ran: false, cleanup: null, deps: undefined }
      const slot = hooks[index]
      const changed = !slot.ran || deps === undefined || deps.some((dep, i) => !Object.is(dep, slot.deps?.[i]))
      if (changed) pending.push({ slot, fn, deps })
    },
    // Enough of React.Component for the Panel's boundary; the tests below render a boundary by hand.
    Component: class Component {
      constructor(props) { this.props = props }
    },
    createElement: h,
  }
  const Board = createBoard(React, {
    ChatPanel,
    fetch,
    document,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: () => clock.now(),
    useAppApi: () => (api === undefined ? gateway : api),
    storage,
    kit,
    Select: null,
  })
  function render() {
    if (rendering) {
      again = true
      return
    }
    rendering = true
    do {
      again = false
      cursor = 0
      pending = []
      instance.renders += 1
      tree = Board({})
      for (const { slot, fn, deps } of pending) {
        if (typeof slot.cleanup === 'function') slot.cleanup()
        slot.ran = true
        slot.deps = deps
        const result = fn()
        slot.cleanup = typeof result === 'function' ? result : null
      }
    } while (again)
    rendering = false
  }
  render()
  return {
    fetch: planFetch,
    chatFetch,
    projectsFetch,
    gateway,
    document,
    clock,
    instance,
    tree: () => tree,
    text: () => textOf(tree),
    async awaitProjects(projects = DEFAULT_PROJECTS) {
      projectsFetch.answer(0, 200, projects)
      await flush()
    },
    unmount() {
      unmounted = true
      for (const slot of hooks) if (typeof slot.cleanup === 'function') slot.cleanup()
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
        { id: 'one.md#Card Alpha', name: 'Card Alpha', description: '', status: 'planned', spec: 'alpha', tasks: { done: 0, total: 2 } },
        { id: 'one.md#Card Beta', name: 'Card Beta', description: '', status: 'done', spec: 'beta', tasks: { done: 3, total: 3 } },
      ],
    },
  ],
}
const plan = (overrides = {}) => ({ ...PLAN, ...overrides })

const FAILURE_TEXT = 'Could not reach the backend.'
const NOTICE_TEXT = 'Could not reach the backend. Showing the plan from the last update.'

// ---- Requests ----

test('opening the page sends one GET of the plan route and one GET of the chats route, and no Crew request', async () => {
  const page = mount()
  await page.awaitProjects()
  assert.equal(page.chatFetch.calls.length, 1)
  assert.equal(normalizeUrl(page.chatFetch.calls[0][0]), `${BACKEND}/chats`)
  assert.equal(page.chatFetch.calls[0][1].method, 'GET')
  page.chatFetch.answer(0, 200, { folder_id: 'f_1', folder_reason: null, chats: [] })
  await flush()
  assert.deepEqual(page.gateway.calls, [], 'no started chats: nothing is sent to Crew')
  assert.equal(page.fetch.calls.length, 1)
  const [url, options] = page.fetch.calls[0]
  assert.ok(url.startsWith(PLAN_URL))
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
    assert.ok(callUrl.startsWith(PLAN_URL))
    assert.deepEqual(Object.keys(callOptions).sort(), ['cache', 'credentials', 'method', 'signal'])
    assert.equal(callOptions.method, 'GET')
  }
})

test('the first render shows Loading…, then the board with no second Loading…', async () => {
  const page = mount()
  assert.match(page.text(), /Loading…/)
  assert.doesNotMatch(page.text(), /Card Alpha/)

  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  await flush()
  const text = page.text()
  assert.match(text, /Card Alpha/)
  assert.match(text, /Card Beta/)
  assert.doesNotMatch(text, /Loading…/)
  assert.equal(page.instance.renders, 3)
})

test('a 202 pending answer keeps Loading… and requests again after 2000 ms', async () => {
  const page = mount()
  await page.awaitProjects()
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
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan({ refreshing: true }))
  await flush()
  page.clock.advance(1999)
  assert.equal(page.fetch.calls.length, 1)
  page.clock.advance(1)
  assert.equal(page.fetch.calls.length, 2)
})

test('a plan with refreshing false requests again after 15000 ms', async () => {
  const page = mount()
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan({ refreshing: false }))
  await flush()
  page.clock.advance(14999)
  assert.equal(page.fetch.calls.length, 1)
  page.clock.advance(1)
  assert.equal(page.fetch.calls.length, 2)
})

test('a rejected fetch shows the failure text and requests again after 15000 ms', async () => {
  const page = mount()
  await page.awaitProjects()
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
  await page.awaitProjects()
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
  await page.awaitProjects()
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
  assert.equal(page.fetch.calls.length, 0, 'plan waits for projects to load')
  await page.awaitProjects()
  assert.equal(page.fetch.calls.length, 1)
  assert.ok(page.fetch.calls[0][0].startsWith(PLAN_URL))
})

test('becoming visible after an answer requests at once without waiting for the timer', async () => {
  const page = mount()
  await page.awaitProjects()
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

test('unmounting removes the same listeners it added (one for projects, one for the plan, one for the chats)', async () => {
  const page = mount()
  await page.awaitProjects()
  assert.equal(page.document.added.length, 3)
  assert.deepEqual(page.document.added.map(([type]) => type), ['visibilitychange', 'visibilitychange', 'visibilitychange'])
  assert.equal(page.document.listenerCount(), 3)
  page.unmount()
  assert.equal(page.document.removed.length, 3)
  assert.deepEqual(page.document.removed.map(([, fn]) => fn).sort(), page.document.added.map(([, fn]) => fn).sort())
  assert.equal(page.document.listenerCount(), 0)
})
test('unmounting clears pending timers and sends no further request', async () => {
  const page = mount()
  await page.awaitProjects()
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
  await page.awaitProjects()
  const { signal } = page.fetch.calls[0][1]
  assert.equal(signal.aborted, false)
  const rendersBefore = page.instance.renders
  const dispatchesBefore = page.instance.dispatches
  page.unmount()
  assert.equal(signal.aborted, true)
  assert.equal(page.clock.pending(), 0)

  page.fetch.answer(0, 200, plan())
  await flush()
  assert.equal(page.instance.dispatches, dispatchesBefore)
  assert.equal(page.instance.renders, rendersBefore)
  assert.equal(page.fetch.calls.length, 1)
})

// ---- Chats and starting a story (start-a-story Requirements 2, 4, 6, 7, 8 and 9) ----
// Validates: Requirements 4.6, 4.7, 6.6, 6.7, 6.8, 6.9, 8.6, 9.4, 9.6
const ALPHA = 'one.md#Card Alpha'
const NAME = 'epic-board-aaaa1111'
const RECORD = { card_id: ALPHA, name: NAME, key: NAME, created: 't' }
const chatsAnswer = (chats = []) => ({ folder_id: 'f_1', folder_reason: null, chats })
const row = (key, extra = {}) => ({ key, running: false, pending_approval: false, needs_input: false, interrupted: false, last_ts: 't1', messages: 3, ...extra })
const detailPath = (key) => `/api/chat/slots/${encodeURIComponent(key)}?limit=1`
const buttonNamed = (page, label) => findAll(page.tree(), (node) => (node.type === 'button' || node.type === fakeBtn) && textOf(node) === label)[0]
const click = (page, label) => {
  const button = buttonNamed(page, label)
  assert.ok(button, `no button "${label}"`)
  button.props.onClick()
}
const anchors = (page) => findAll(page.tree(), (node) => node.type === 'a')
// Opens the page with a plan on the board and the chats route answered.
async function ready(options = {}, chats = []) {
  const page = mount(options)
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer(chats))
  await flush()
  return page
}
// One read of a started chat that Crew has not got: the records, an empty list, a 404 for the chat.
async function missingRead(page) {
  page.chatFetch.answer(page.chatFetch.calls.length - 1, 200, chatsAnswer([RECORD]))
  await flush()
  page.gateway.answer('/api/chat/slots?crew=all', [])
  await flush()
  page.gateway.fail(detailPath(NAME), httpError(404))
  await flush()
}
const NOTICE = 'Could not read chat status. Showing the last known states.'

test('the chats route is read on open, and the list in Crew only when there are started chats', async () => {
  const page = mount()
  await page.awaitProjects()
  assert.equal(page.chatFetch.calls.length, 1)
  const [url, options] = page.chatFetch.calls[0]
  assert.equal(normalizeUrl(url), `${BACKEND}/chats`)
  assert.deepEqual([options.method, options.credentials, options.cache], ['GET', 'same-origin', 'no-store'])
  assert.equal(options.body, undefined)
  assert.equal(typeof options.signal?.aborted, 'boolean')
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()
  assert.deepEqual(page.gateway.calls, [])
  page.clock.advance(15000)
  assert.equal(page.chatFetch.calls.length, 2, 'the records are read again after 15 seconds')
  assert.deepEqual(page.gateway.calls, [])
})

test('a started chat is read from the list: only its row counts, its state word shows, and the next read is 5 s away while it works', async () => {
  const page = await ready({}, [RECORD])
  assert.deepEqual(page.gateway.paths(), ['/api/chat/slots?crew=all'])
  const init = page.gateway.calls[0][2]
  assert.equal(typeof init.signal.aborted, 'boolean')
  page.gateway.answer('/api/chat/slots?crew=all', [row(NAME, { running: true }), row('someone-elses', { pending_approval: true })])
  await flush()
  const text = page.text()
  assert.match(text, /Working/)
  assert.doesNotMatch(text, /Needs you|someone-elses/)
  assert.equal(anchors(page)[0].props.href, `/chat?sid=${NAME}`)
  assert.deepEqual(page.gateway.paths(), ['/api/chat/slots?crew=all'], 'a working chat needs no read of its rows')
  page.clock.advance(4999)
  assert.equal(page.chatFetch.calls.length, 1)
  page.clock.advance(1)
  assert.equal(page.chatFetch.calls.length, 2)
})

const SECRET_WORKER_TEXT = 'WORKER-SECRET-TEXT-9f2c'

test('a worker of the conductor decides the state, and no text or preview of its row ever reaches the page', async () => {
  const page = await ready({}, [RECORD])
  const worker = row('worker-1', {
    crew_root: NAME, running: true, pending_approval: true,
    title: SECRET_WORKER_TEXT, last_message: SECRET_WORKER_TEXT, preview: SECRET_WORKER_TEXT, welcome_message: SECRET_WORKER_TEXT,
    source_links: [{ kind: 'change', number: 99, url: `https://example.com/${SECRET_WORKER_TEXT}`, state: 'open', label: SECRET_WORKER_TEXT }],
  })
  page.gateway.answer('/api/chat/slots?crew=all', [row(NAME), worker, row('other', { title: SECRET_WORKER_TEXT, running: true })])
  await flush()
  assert.match(page.text(), /Needs you/)
  const shown = JSON.stringify(page.tree(), (key, value) => (typeof value === 'function' ? undefined : value))
  assert.doesNotMatch(page.text() + shown, new RegExp(SECRET_WORKER_TEXT))
  assert.doesNotMatch(page.text() + shown, /worker-1|#99/)
  assert.deepEqual(page.gateway.paths(), ['/api/chat/slots?crew=all'], 'a worker needing you needs no read of the conductor\'s rows')
})

test('a conductor with an open pull request shows Review #N linked to it, and Checks failed #N when its checks failed', async () => {
  const page = await ready({}, [RECORD])
  const pr = { kind: 'change', number: 12, url: 'https://github.com/o/r/pull/12', state: 'open', ci: 'failed' }
  page.gateway.answer('/api/chat/slots?crew=all', [row(NAME, { source_links: [pr] })])
  await flush()
  page.gateway.answer(detailPath(NAME), { messages: [{ role: 'assistant' }] })
  await flush()
  assert.match(page.text(), /Checks failed #12/)
  assert.ok(anchors(page).some((a) => a.props.href === 'https://github.com/o/r/pull/12'))
  assert.doesNotMatch(page.text(), /Your turn/)
})

test('an idle chat has its newest row read once, and the next read is 15 s away', async () => {
  const page = await ready({}, [RECORD])
  page.gateway.answer('/api/chat/slots?crew=all', [row(NAME)])
  await flush()
  page.gateway.answer(detailPath(NAME), { messages: [{ role: 'user' }, { role: 'error' }] })
  await flush()
  assert.match(page.text(), /Interrupted/)
  page.clock.advance(14999)
  assert.equal(page.chatFetch.calls.length, 1)
  page.clock.advance(1)
  assert.equal(page.chatFetch.calls.length, 2)
  page.chatFetch.answer(1, 200, chatsAnswer([RECORD]))
  await flush()
  page.gateway.answer('/api/chat/slots?crew=all', [row(NAME)])
  await flush()
  assert.equal(page.gateway.paths().filter((path) => path === detailPath(NAME)).length, 1, 'unchanged last_ts and messages: no second read')
  assert.match(page.text(), /Interrupted/)
})

test('a hidden page sends no chat request until it is visible, then reads at once', async () => {
  const page = mount({ hidden: true })
  assert.deepEqual([page.fetch.calls.length, page.chatFetch.calls.length], [0, 0])
  page.clock.advance(60000)
  assert.deepEqual([page.fetch.calls.length, page.chatFetch.calls.length], [0, 0])
  page.document.hidden = false
  page.document.fire('visibilitychange')
  assert.deepEqual([page.fetch.calls.length, page.chatFetch.calls.length], [0, 0], 'plan and chat wait for projects')
  await page.awaitProjects()
  assert.deepEqual([page.fetch.calls.length, page.chatFetch.calls.length], [1, 1])
})

test('a start: the question, then reserve, create and save, then the link at once and a read at once, and the brief last', async () => {
  const page = await ready()
  assert.doesNotMatch(page.text(), /Start a conductor on this story\?/)
  click(page, 'Card Alpha')
  assert.match(page.text(), /Start a conductor on this story\?/)
  const start = buttonNamed(page, 'Start')
  start.props.onClick()
  start.props.onClick() // a second activation while the start runs is ignored
  await flush()
  assert.match(page.text(), /Starting…/)
  assert.equal(buttonNamed(page, 'Start'), undefined)
  assert.equal(page.chatFetch.calls.length, 2, 'one reservation only')
  const [reserveUrl, reserve] = page.chatFetch.calls[1]
  assert.equal(normalizeUrl(reserveUrl), `${BACKEND}/chats`)
  assert.deepEqual([reserve.method, reserve.credentials, reserve.headers], ['POST', 'same-origin', { 'Content-Type': 'application/json' }])
  assert.deepEqual(JSON.parse(reserve.body), { card_id: ALPHA })

  page.chatFetch.answer(1, 200, { card_id: ALPHA, name: NAME, brief: 'THE BRIEF', folder_id: 'f_1' })
  await flush()
  assert.deepEqual(page.gateway.calls, [['post', '/api/chat/slots', { name: NAME, agent: 'kirocrew-conductor', folder_id: 'f_1' }]])
  page.gateway.answer('/api/chat/slots', { key: NAME, messages: 0 })
  await flush()
  // The chat is saved before the brief is sent.
  const [savedUrl, saved] = page.chatFetch.calls[2]
  assert.equal(normalizeUrl(savedUrl), `${BACKEND}/chats/${NAME}/started`)
  assert.deepEqual(JSON.parse(saved.body), { key: NAME })
  assert.deepEqual(page.gateway.paths(), ['/api/chat/slots'], 'no brief before the save is answered')
  assert.equal(anchors(page).length, 0, 'and no link before the save is answered')
  page.chatFetch.answer(2, 200, { card_id: ALPHA, name: NAME, key: NAME })
  await flush()

  // The link shows, a read of the chats starts, and the brief is on its way.
  assert.equal(anchors(page)[0].props.href, `/chat?sid=${NAME}`, 'the link shows as soon as the chat is saved')
  assert.doesNotMatch(page.text(), /Starting…|Start a conductor on this story\?/)
  assert.deepEqual(page.gateway.calls[1], ['post', '/api/chat', { slot: NAME, message: 'THE BRIEF' }])
  assert.match(page.text(), /Sending the brief…/)
  assert.equal(page.chatFetch.calls.length, 4, 'and a read of the records follows at once')
  assert.deepEqual([normalizeUrl(page.chatFetch.calls[3][0]), page.chatFetch.calls[3][1].method], [`${BACKEND}/chats`, 'GET'])
  page.gateway.answer('/api/chat', {})
  await flush()
  assert.doesNotMatch(page.text(), /Sending the brief…|The brief was not sent/)
})

test('a conductor whose turn waits for an approval: the send never answers, and the card still has its link and shows Needs you', async () => {
  const page = await ready()
  click(page, 'Card Alpha')
  click(page, 'Start')
  page.chatFetch.answer(1, 200, { card_id: ALPHA, name: NAME, brief: 'THE BRIEF', folder_id: 'f_1' })
  await flush()
  page.gateway.answer('/api/chat/slots', { key: NAME, messages: 0 })
  await flush()
  page.chatFetch.answer(2, 200, { card_id: ALPHA, name: NAME, key: NAME })
  await flush()
  // POST /api/chat is open and will stay open: the turn is waiting for a tool approval.
  assert.equal(page.gateway.pending(), 1)
  assert.equal(anchors(page)[0].props.href, `/chat?sid=${NAME}`)
  assert.doesNotMatch(page.text(), /Starting…/)
  // The chat read that follows the save shows the state.
  page.chatFetch.answer(3, 200, chatsAnswer([RECORD]))
  await flush()
  page.gateway.answer('/api/chat/slots?crew=all', [row(NAME, { running: true, pending_approval: true })])
  await flush()
  assert.match(page.text(), /Needs you/)
  assert.match(page.text(), /Sending the brief…/)
  // Ten seconds on, the brief counts as sent; the request is still open and nothing is shown for it.
  page.clock.advance(10000)
  await flush()
  assert.doesNotMatch(page.text(), /Sending the brief…|The brief was not sent/)
  assert.equal(anchors(page)[0].props.href, `/chat?sid=${NAME}`)
  assert.match(page.text(), /Needs you/)
  assert.equal(findAll(page.tree(), (n) => n.props.role === 'alert').length, 0)
  // The request is not aborted, and what it later answers, an error too, changes nothing.
  const sendCall = page.gateway.calls.find(([, path]) => path === '/api/chat')
  assert.equal(sendCall.length, 3)
  page.gateway.fail('/api/chat', new TypeError('Failed to fetch'))
  await flush()
  assert.doesNotMatch(page.text(), /The brief was not sent/)
})

test('a brief that fails to send leaves the link, says so with the reason, and Send the brief again sends it only when the chat holds no message', async () => {
  const page = await ready()
  click(page, 'Card Alpha')
  click(page, 'Start')
  page.chatFetch.answer(1, 200, { card_id: ALPHA, name: NAME, brief: 'THE BRIEF', folder_id: 'f_1' })
  await flush()
  page.gateway.answer('/api/chat/slots', { key: NAME, messages: 0 })
  await flush()
  page.chatFetch.answer(2, 200, { card_id: ALPHA, name: NAME, key: NAME })
  await flush()
  page.gateway.fail('/api/chat', httpError(500, null))
  await flush()
  assert.equal(anchors(page)[0].props.href, `/chat?sid=${NAME}`, 'the card keeps its link')
  assert.match(page.text(), /The brief was not sent/)
  assert.match(page.text(), /API 500/)
  assert.doesNotMatch(page.text(), /Starting…|Could not send the brief/)
  assert.equal(findAll(page.tree(), (n) => n.props.role === 'alert').length, 0)
  assert.ok(buttonNamed(page, 'Send the brief again'))
  assert.equal(buttonNamed(page, 'Start'), undefined, 'the question is not offered again: the chat exists')

  // First retry: the list says the chat holds no message, so the brief is sent again.
  const sendsBefore = page.gateway.calls.filter(([, path]) => path === '/api/chat').length
  click(page, 'Send the brief again')
  await flush()
  assert.match(page.text(), /Sending the brief…/)
  page.gateway.answer('/api/chat/slots', [row(NAME, { messages: 0 })])
  await flush()
  assert.equal(page.gateway.calls.filter(([, path]) => path === '/api/chat').length, sendsBefore + 1)
  assert.deepEqual(page.gateway.calls.at(-1), ['post', '/api/chat', { slot: NAME, message: 'THE BRIEF' }])
  page.gateway.fail('/api/chat', httpError(502, null))
  await flush()
  assert.match(page.text(), /The brief was not sent/)

  // Second retry: the chat now holds a message (the first send got through after all): nothing is sent.
  click(page, 'Send the brief again')
  await flush()
  page.gateway.answer('/api/chat/slots', [row(NAME, { messages: 1 })])
  await flush()
  assert.equal(page.gateway.calls.filter(([, path]) => path === '/api/chat').length, sendsBefore + 1, 'no second send')
  assert.doesNotMatch(page.text(), /The brief was not sent|Sending the brief…/)
  assert.equal(buttonNamed(page, 'Send the brief again'), undefined)
  assert.equal(anchors(page)[0].props.href, `/chat?sid=${NAME}`)
})

test('a retry that cannot read the list sends nothing and shows the failure again', async () => {
  const page = await ready()
  click(page, 'Card Alpha')
  click(page, 'Start')
  page.chatFetch.answer(1, 200, { card_id: ALPHA, name: NAME, brief: 'THE BRIEF', folder_id: 'f_1' })
  await flush()
  page.gateway.answer('/api/chat/slots', { key: NAME, messages: 0 })
  await flush()
  page.chatFetch.answer(2, 200, { card_id: ALPHA, name: NAME, key: NAME })
  await flush()
  page.gateway.fail('/api/chat', httpError(500, null))
  await flush()
  const sends = () => page.gateway.calls.filter(([, path]) => path === '/api/chat').length
  const before = sends()
  click(page, 'Send the brief again')
  await flush()
  page.gateway.fail('/api/chat/slots', httpError(500, null))
  await flush()
  assert.equal(sends(), before)
  assert.match(page.text(), /The brief was not sent/)
  assert.ok(buttonNamed(page, 'Send the brief again'))
  click(page, 'Send the brief again')
  await flush()
  page.gateway.answer('/api/chat/slots', [row('someone-elses', { messages: 0 })])
  await flush()
  assert.equal(sends(), before, 'no row for the chat: nothing is sent')
  assert.match(page.text(), /Crew does not have this chat open/)
})

test('a second press of Send the brief again while it runs sends nothing more', async () => {
  const page = await ready()
  click(page, 'Card Alpha')
  click(page, 'Start')
  page.chatFetch.answer(1, 200, { card_id: ALPHA, name: NAME, brief: 'THE BRIEF', folder_id: 'f_1' })
  await flush()
  page.gateway.answer('/api/chat/slots', { key: NAME, messages: 0 })
  await flush()
  page.chatFetch.answer(2, 200, { card_id: ALPHA, name: NAME, key: NAME })
  await flush()
  page.gateway.fail('/api/chat', httpError(500, null))
  await flush()
  const lists = () => page.gateway.calls.filter(([verb, path]) => verb === 'get' && path === '/api/chat/slots').length
  const sends = () => page.gateway.calls.filter(([, path]) => path === '/api/chat').length
  const [listsBefore, sendsBefore] = [lists(), sends()]
  const button = buttonNamed(page, 'Send the brief again')
  button.props.onClick()
  button.props.onClick()
  await flush()
  assert.equal(lists(), listsBefore + 1, 'the second press started nothing')
  page.gateway.answer('/api/chat/slots', [row(NAME, { messages: 0 })])
  await flush()
  assert.equal(sends(), sendsBefore + 1, 'one retry, sent once')
})

test('unmounting clears the send timer, and a send that finishes after the page is gone changes nothing', async () => {
  const page = await ready()
  click(page, 'Card Alpha')
  click(page, 'Start')
  page.chatFetch.answer(1, 200, { card_id: ALPHA, name: NAME, brief: 'THE BRIEF', folder_id: 'f_1' })
  await flush()
  page.gateway.answer('/api/chat/slots', { key: NAME, messages: 0 })
  await flush()
  page.chatFetch.answer(2, 200, { card_id: ALPHA, name: NAME, key: NAME })
  await flush()
  assert.ok(page.clock.pending() > 0)
  const rendersBefore = page.instance.renders
  page.unmount()
  assert.equal(page.clock.pending(), 0, 'no timer is left, the send timer included')
  page.gateway.fail('/api/chat', httpError(500, null))
  await flush()
  assert.equal(page.instance.renders, rendersBefore)
})

test('every request of a start goes to the paths of the spec and nothing else', async () => {
  const page = await ready()
  click(page, 'Card Alpha')
  click(page, 'Start')
  page.chatFetch.answer(1, 200, { card_id: ALPHA, name: NAME, brief: 'B', folder_id: 'f_1' })
  await flush()
  page.gateway.answer('/api/chat/slots', { key: NAME, messages: 1 })
  await flush()
  page.chatFetch.answer(2, 200, { card_id: ALPHA, name: NAME, key: NAME })
  await flush()
  assert.deepEqual(page.gateway.paths(), ['/api/chat/slots'], 'a chat that already holds a message is not sent the brief again')
  for (const [, path] of page.gateway.calls) assert.doesNotMatch(path, /approve|question|approvals|stop|close|steer|note|context/)
})

test('a failed start says which step and why, offers the question again, and a retry is allowed', async () => {
  const page = await ready()
  click(page, 'Card Alpha')
  click(page, 'Start')
  page.chatFetch.answer(1, 409, { error: { code: 'card_done', message: 'That story is done.' } })
  await flush()
  assert.match(page.text(), /Could not reserve the chat: That story is done\./)
  assert.ok(buttonNamed(page, 'Start') && buttonNamed(page, 'Cancel'))
  assert.equal(findAll(page.tree(), (node) => node.props.role === 'alert').length, 0)
  click(page, 'Start')
  page.chatFetch.answer(2, 200, { card_id: ALPHA, name: NAME, brief: 'B', folder_id: 'f_1' })
  await flush()
  page.gateway.fail('/api/chat/slots', new Error('API 400: {"error": "folder not found"}'))
  await flush()
  assert.match(page.text(), /Could not create the chat: API 400/)
  assert.equal(page.chatFetch.calls.length, 3, 'no save after a failed create')
})

test('Cancel closes the question and puts focus back on the card\'s button; so does Escape', async () => {
  const page = await ready()
  const focused = []
  const node = (id) => ({ getAttribute: (name) => (name === 'data-card-id' ? id : null), focus: () => focused.push(id) })
  page.document.nodes.push(node('one.md#Card Beta'), node(ALPHA))
  click(page, 'Card Alpha')
  assert.match(page.text(), /Start a conductor on this story\?/)
  click(page, 'Cancel')
  assert.doesNotMatch(page.text(), /Start a conductor on this story\?/)
  assert.deepEqual(focused, [ALPHA])
  click(page, 'Card Alpha')
  findAll(page.tree(), (n) => n.props.role === 'group')[0].props.onKeyDown({ key: 'Escape' })
  assert.doesNotMatch(page.text(), /Start a conductor on this story\?/)
  assert.deepEqual(focused, [ALPHA, ALPHA])
})

test('opening the question puts focus on its Start button, so Escape works straight after a click', async () => {
  const page = await ready()
  const focused = []
  const start = (id) => ({ getAttribute: (name) => (name === 'data-eb-start' ? id : null), focus: () => focused.push(`start:${id}`) })
  const card = (id) => ({ getAttribute: (name) => (name === 'data-card-id' ? id : null), focus: () => focused.push(`card:${id}`) })
  page.document.startNodes.push(start('one.md#Card Beta'), start(ALPHA))
  page.document.nodes.push(card(ALPHA))
  click(page, 'Card Alpha')
  assert.deepEqual(focused, [`start:${ALPHA}`], 'focus moves to this card\'s Start, not another card\'s')
  const startButton = findAll(page.tree(), (n) => n.type === 'button' && n.props['data-eb-start'] === ALPHA)
  assert.equal(startButton.length, 1, 'the Start button carries its card id')
  findAll(page.tree(), (n) => n.props.role === 'group')[0].props.onKeyDown({ key: 'Escape' })
  assert.doesNotMatch(page.text(), /Start a conductor on this story\?/)
  assert.deepEqual(focused, [`start:${ALPHA}`, `card:${ALPHA}`], 'Escape closes it and focus returns to the card')
})

test('the question is open on one card at a time, and a Done card with no chat has no button', async () => {
  const page = mount()
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan({ groups: [{ epic: { file: 'one.md', name: 'Epic One' }, cards: [
    { id: 'one.md#A', name: 'A', description: '', status: 'planned', spec: null, tasks: null },
    { id: 'one.md#B', name: 'B', description: '', status: 'in progress', spec: 'b', tasks: { done: 1, total: 2 } },
    { id: 'one.md#C', name: 'C', description: '', status: 'done', spec: 'c', tasks: { done: 1, total: 1 } },
  ] }] }))
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()
  assert.equal(buttonNamed(page, 'C'), undefined)
  click(page, 'A')
  click(page, 'B')
  assert.equal(findAll(page.tree(), (n) => n.props.role === 'group').length, 1)
  assert.equal(findAll(page.tree(), (n) => n.props['data-mode'] === 'question')[0].props['data-mode'], 'question')
  const open = findAll(page.tree(), (n) => n.type === 'li' && n.props['data-mode'] === 'question')
  assert.equal(open.length, 1)
  assert.match(textOf(open[0]), /^B/)
})

test('a chat that Crew does not have is restoring, then not open after a minute, then resumes', async () => {
  const page = await ready({}, [RECORD])
  page.gateway.answer('/api/chat/slots?crew=all', [])
  await flush()
  page.gateway.fail(detailPath(NAME), httpError(404))
  await flush()
  assert.match(page.text(), /Restoring chat…/)
  assert.equal(anchors(page).length, 0)
  for (let step = 0; step < 12; step += 1) {
    page.clock.advance(5000)
    await missingRead(page)
  }
  assert.match(page.text(), /This chat is not open\./)
  assert.ok(buttonNamed(page, 'Resume chat'))
  const before = page.chatFetch.calls.length
  click(page, 'Resume chat')
  await flush()
  assert.deepEqual(page.gateway.calls.at(-1), ['post', `/api/chat/slots/${NAME}/resume`])
  assert.match(page.text(), /Resuming…/)
  page.gateway.answer(`/api/chat/slots/${NAME}/resume`, { ok: true })
  await flush()
  assert.equal(page.chatFetch.calls.length, before + 1, 'a read follows at once')
})

test('a failed resume shows the reason, and Start again removes only the board\'s record and shows the question', async () => {
  const page = await ready({}, [RECORD])
  page.gateway.answer('/api/chat/slots?crew=all', [])
  await flush()
  page.gateway.fail(detailPath(NAME), httpError(404))
  await flush()
  for (let step = 0; step < 12; step += 1) {
    page.clock.advance(5000)
    await missingRead(page)
  }
  click(page, 'Resume chat')
  page.gateway.fail(`/api/chat/slots/${NAME}/resume`, httpError(404, null))
  await flush()
  assert.match(page.text(), /The chat could not be resumed\./)
  const callsToCrew = page.gateway.calls.length
  click(page, 'Start again')
  await flush()
  const [url, options] = page.chatFetch.calls.at(-1)
  assert.deepEqual([normalizeUrl(url), options.method], [`${BACKEND}/chats/${NAME}`, 'DELETE'])
  page.chatFetch.answer(page.chatFetch.calls.length - 1, 200, { removed: true })
  await flush()
  assert.equal(page.gateway.calls.length, callsToCrew, 'nothing was sent to Crew')
  assert.match(page.text(), /Start a conductor on this story\?/)
  assert.equal(anchors(page).length, 0)
})

test('a failed chat read keeps the shown states and adds the notice; a good read removes it; the plan is untouched', async () => {
  const page = await ready({}, [RECORD])
  page.gateway.answer('/api/chat/slots?crew=all', [row(NAME, { running: true })])
  await flush()
  assert.match(page.text(), /Working/)
  page.clock.advance(5000)
  page.chatFetch.fail(1)
  await flush()
  const text = page.text()
  assert.equal(text.includes(NOTICE), true)
  assert.match(text, /Working/)
  assert.match(text, /Card Alpha/)
  assert.equal(page.fetch.calls.length, 1, 'no plan request was caused')
  assert.equal(findAll(page.tree(), (node) => node.props.role === 'alert').length, 0)
  page.clock.advance(15000)
  page.chatFetch.answer(2, 200, chatsAnswer([RECORD]))
  await flush()
  page.gateway.answer('/api/chat/slots?crew=all', [row(NAME, { running: true })])
  await flush()
  assert.equal(page.text().includes(NOTICE), false)
})

test('a failing list in Crew is a failed read too', async () => {
  const page = await ready({}, [RECORD])
  page.gateway.fail('/api/chat/slots?crew=all', httpError(500, null))
  await flush()
  assert.equal(page.text().includes(NOTICE), true)
  assert.match(page.text(), /Card Alpha/)
  page.clock.advance(14999)
  assert.equal(page.chatFetch.calls.length, 1)
  page.clock.advance(1)
  assert.equal(page.chatFetch.calls.length, 2, 'tried again after 15 seconds')
})

// One whole read of the started chat, answered by the test: the records, then the list.
async function chatCycle(page, rows) {
  page.chatFetch.answer(page.chatFetch.calls.length - 1, 200, chatsAnswer([RECORD]))
  await flush()
  page.gateway.answer('/api/chat/slots?crew=all', rows)
  await flush()
}
test('a failed plan request keeps the chat states and shows only the plan notice', async () => {
  const page = await ready({}, [RECORD])
  const rows = [row(NAME, { pending_approval: true, running: true })]
  page.gateway.answer('/api/chat/slots?crew=all', rows)
  await flush()
  for (let second = 5; second <= 10; second += 5) {
    page.clock.advance(5000)
    await chatCycle(page, rows)
  }
  page.clock.advance(5000) // 15 seconds: the plan is due, and so is a chat read
  assert.equal(page.fetch.calls.length, 2)
  await chatCycle(page, rows)
  page.fetch.fail(1)
  await flush()
  const text = page.text()
  assert.equal(text.includes(NOTICE_TEXT), true)
  assert.equal(text.includes(NOTICE), false)
  assert.match(text, /Needs you/)
})

test('a host with no app client cannot reach Crew: the read fails, the board stays, and nothing throws', async () => {
  const page = await ready({ api: null }, [RECORD])
  await flush()
  assert.equal(page.text().includes(NOTICE), true)
  assert.match(page.text(), /Card Alpha/)
  assert.deepEqual(page.gateway.calls, [])
  assert.equal(anchors(page)[0].props.href, `/chat?sid=${NAME}`, 'the started chat still has its link')
})

test('a backend that cannot read its file of chats shows the message when a card asks to start', async () => {
  const page = mount()
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 500, { error: { code: 'chats_unreadable', message: '/x/chats.json cannot be read as the board\'s file of chats.' } })
  await flush()
  assert.equal(page.text().includes(NOTICE), false, 'an unreadable file is an answer, not a failed read')
  click(page, 'Card Alpha')
  assert.match(page.text(), /chats\.json cannot be read/)
  assert.ok(buttonNamed(page, 'Close'))
  assert.equal(buttonNamed(page, 'Start'), undefined)
  assert.deepEqual(page.gateway.calls, [])
})

test('unmounting stops both pollers, aborts the reads in flight, and a late answer does nothing', async () => {
  const page = mount()
  await page.awaitProjects()
  const { signal } = page.chatFetch.calls[0][1]
  assert.equal(signal.aborted, false)
  const before = page.instance.renders
  page.unmount()
  assert.equal(signal.aborted, true)
  assert.equal(page.clock.pending(), 0)
  page.chatFetch.answer(0, 200, chatsAnswer([RECORD]))
  await flush()
  assert.equal(page.instance.renders, before)
  assert.deepEqual(page.gateway.calls, [])
  page.document.hidden = false
  page.document.fire('visibilitychange')
  assert.equal(page.chatFetch.calls.length, 1)
})

test('a start that finishes after the page is gone changes nothing', async () => {
  const page = await ready()
  click(page, 'Card Alpha')
  click(page, 'Start')
  const rendersBefore = page.instance.renders
  page.unmount()
  page.chatFetch.answer(1, 200, { card_id: ALPHA, name: NAME, brief: 'B', folder_id: 'f_1' })
  await flush()
  assert.equal(page.instance.renders, rendersBefore)
  assert.equal(page.chatFetch.calls.length, 2)
})

// ---- The epic filter ----

const TWO = plan({
  groups: [
    PLAN.groups[0],
    { epic: { file: 'two.md', name: 'Epic Two' }, cards: [{ id: 'two.md#Card Gamma', name: 'Card Gamma', description: '', status: 'planned', spec: 'gamma', tasks: { done: 0, total: 1 } }] },
  ],
})
const ONLY_TWO = plan({ groups: [TWO.groups[1]] })
const memoryStorage = (initial) => {
  const map = new Map(initial ? [['epic-board.filter', initial]] : [])
  const writes = []
  return { map, writes, getItem: (k) => (map.has(k) ? map.get(k) : null), setItem: (k, v) => { writes.push(v); map.set(k, v) } }
}
const selectOf = (page) => findAll(page.tree(), (n) => n.type === 'select' && n.props['aria-label'] === 'Epic')[0]
const choose = (page, key) => selectOf(page).props.onChange({ target: { value: key } })
const pageWith = async (storage, body = TWO) => {
  const page = mount({ storage })
  await page.awaitProjects()
  page.fetch.answer(0, 200, body)
  await flush()
  return page
}

test('board: choosing an epic saves it', async () => {
  const storage = memoryStorage()
  const page = await pageWith(storage)
  assert.match(page.text(), /Card Alpha/)
  assert.match(page.text(), /Card Gamma/)
  choose(page, 'two.md')
  assert.doesNotMatch(page.text(), /Card Alpha/)
  assert.match(page.text(), /Card Gamma/)
  assert.equal(selectOf(page).props.value, 'two.md')
  assert.deepEqual(storage.writes, ['two.md'])
  choose(page, 'all')
  assert.match(page.text(), /Card Alpha/)
  assert.equal(storage.map.get('epic-board.filter'), 'all')
})

test('board: a saved epic is restored on load', async () => {
  const storage = memoryStorage('two.md')
  const page = await pageWith(storage)
  assert.doesNotMatch(page.text(), /Card Alpha/)
  assert.match(page.text(), /Card Gamma/)
  assert.deepEqual(storage.writes, [], 'restoring writes nothing')
})

test('board: a missing saved epic falls back to all epics', async () => {
  const storage = memoryStorage('gone.md')
  const page = await pageWith(storage)
  assert.match(page.text(), /Card Alpha/)
  assert.equal(selectOf(page).props.value, 'all')
  assert.deepEqual(storage.writes, ['all'])
})

test('board: nothing is drawn or reset before the first plan', async () => {
  const storage = memoryStorage('two.md')
  const page = mount({ storage })
  assert.equal(selectOf(page), undefined)
  assert.deepEqual(storage.writes, [])
  await page.awaitProjects()
  page.fetch.answer(0, 200, TWO)
  await flush()
  assert.equal(selectOf(page).props.value, 'two.md')
})

test('board: a new plan keeps the choice; one without the epic goes to all and stays there', async () => {
  const storage = memoryStorage()
  const page = await pageWith(storage)
  choose(page, 'two.md')
  page.clock.advance(15000)
  page.fetch.answer(1, 200, TWO)
  await flush()
  assert.equal(selectOf(page).props.value, 'two.md')
  page.clock.advance(15000)
  page.fetch.answer(2, 200, plan())
  await flush()
  assert.equal(selectOf(page).props.value, 'all')
  assert.equal(storage.map.get('epic-board.filter'), 'all')
  page.clock.advance(15000)
  page.fetch.answer(3, 200, TWO)
  await flush()
  assert.equal(selectOf(page).props.value, 'all', 'the epic coming back does not reselect itself')
})

test('board: a failed plan poll keeps the filter working', async () => {
  const page = await pageWith(memoryStorage())
  page.clock.advance(15000)
  page.fetch.fail(1)
  await flush()
  assert.match(page.text(), /Showing the plan from the last update/)
  choose(page, 'two.md')
  assert.doesNotMatch(page.text(), /Card Alpha/)
  assert.match(page.text(), /Card Gamma/)
})

test('board: a chat poll leaves the choice alone and makes no write', async () => {
  const storage = memoryStorage()
  const page = await pageWith(storage)
  choose(page, 'two.md')
  const writes = storage.writes.length
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()
  assert.equal(selectOf(page).props.value, 'two.md')
  assert.equal(storage.writes.length, writes)
})

test('board: a storage that throws still filters in memory', async () => {
  const storage = { getItem() { throw new Error('blocked') }, setItem() { throw new Error('full') } }
  const page = await pageWith(storage)
  assert.equal(selectOf(page).props.value, 'all')
  choose(page, 'two.md')
  assert.doesNotMatch(page.text(), /Card Alpha/)
  assert.equal(selectOf(page).props.value, 'two.md')
})

test('board: a plan with only epic two is shown with no reset when the saved epic is there', async () => {
  const storage = memoryStorage('two.md')
  const page = await pageWith(storage, ONLY_TWO)
  assert.equal(selectOf(page).props.value, 'two.md')
  assert.deepEqual(storage.writes, [])
})

// ---- Setup view: Projects button, unconfigured, and integration ----

test('setup: Projects button is in the board when plan is showing', async () => {
  const page = mount()
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()
  assert.ok(buttonNamed(page, 'Projects'), 'Projects button present in plan view')
})

test('setup: Projects button present when there is exactly one project', async () => {
  const page = mount()
  await page.awaitProjects([{ id: 'solo', name: 'Solo' }])
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()
  assert.ok(buttonNamed(page, 'Projects'))
})

test('setup: unconfigured notice and Projects button when projects list is empty', async () => {
  const page = mount()
  await page.awaitProjects([])
  assert.match(page.text(), /Choose your projects/)
  assert.ok(buttonNamed(page, 'Set up projects'))
  assert.equal(page.fetch.calls.length, 0, 'plan poller not started when unconfigured')
  assert.equal(page.chatFetch.calls.length, 0, 'chat poller not started when unconfigured')
})

test('setup: unconfigured state has no columns', async () => {
  const page = mount()
  await page.awaitProjects([])
  const columns = findAll(page.tree(), (n) => n.props?.className === 'eb-columns')
  assert.equal(columns.length, 0)
})

test('setup: clicking Projects shows loading then ready with folder list', async () => {
  const page = mount()
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()

  click(page, 'Projects')
  await flush()
  assert.match(page.text(), /Loading/)

  page.gateway.answer('/api/chat/folders', [{ id: 'f1', name: 'Alpha Folder', project_dir: '/home/x/proj' }])
  page.chatFetch.answer(1, 200, { source: 'config', config_has_projects: false, projects: [] })
  await flush()

  assert.match(page.text(), /Alpha Folder/)
  assert.ok(buttonNamed(page, 'Save'))
})

test('setup: after saveSetup succeeds, setup view closes', async () => {
  const page = mount()
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()

  click(page, 'Projects')
  await flush()
  page.gateway.answer('/api/chat/folders', [{ id: 'f1', name: 'Folder', project_dir: '/home/x' }])
  page.chatFetch.answer(1, 200, { source: 'config', config_has_projects: false, projects: [] })
  await flush()

  // Check the folder and name it
  findAll(page.tree(), (n) => n.type === 'input' && n.props.type === 'checkbox')[0]
    .props.onChange({ target: { checked: true } })
  await flush()
  findAll(page.tree(), (n) => n.type === 'input' && n.props.type === 'text')[0]
    .props.onChange({ target: { value: 'My P' } })
  await flush()

  click(page, 'Save')
  await flush()

  // Answer POST /setup
  page.chatFetch.answer(page.chatFetch.calls.length - 1, 200, { projects: [{ id: 'q', name: 'My P' }], source: 'saved' })
  await flush()

  // Answer re-read projects
  page.projectsFetch.answer(1, 200, [{ id: 'q', name: 'My P' }])
  await flush()

  // Setup view closed: no Save or Cancel button
  assert.equal(buttonNamed(page, 'Save'), undefined, 'Save button gone after close')
  assert.equal(buttonNamed(page, 'Cancel'), undefined, 'Cancel button gone after close')
})

test('setup: view is drawn in the panel aside, not appended after the board', async () => {
  const page = mount()
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()

  click(page, 'Projects')
  await flush()

  // The setup content must be inside the panel aside, not in the eb-root div.
  const root = findAll(page.tree(), (n) => n.props?.className === 'eb-root')[0]
  assert.equal(findAll(root, (n) => n.props?.className === 'eb-setup').length, 0,
    'eb-setup not inside eb-root')
  const panel = asideOf(page)
  assert.ok(panel, 'panel aside is present')
  assert.equal(panel.props['aria-label'], 'Projects')
  assert.ok(findAll(panel, (n) => n.props?.className === 'eb-setup').length > 0,
    'eb-setup inside the panel aside')
})

test('setup: opening focuses the panel, closing returns focus to the Projects button', async () => {
  const page = mount()
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()

  const focused = []
  page.document.panel = { focus: () => focused.push('panel') }
  page.document.setupBtn = { focus: () => focused.push('setup-btn') }

  click(page, 'Projects')
  await flush()
  assert.deepEqual(focused, ['panel'], 'panel focused on open')

  page.gateway.answer('/api/chat/folders', [])
  page.chatFetch.answer(1, 200, { source: 'config', config_has_projects: false, projects: [] })
  await flush()

  click(page, 'Close')
  assert.deepEqual(focused, ['panel', 'setup-btn'], 'Projects button focused on close')
})

// ---- Board design: the header's Projects button and the first-run notice with a kit ----

const fakeBtn = () => null
const fakePageHeader = () => null
const kitOf = () => ({ Btn: fakeBtn, PageHeader: fakePageHeader })
// The fake PageHeader draws nothing, so its `actions` prop is where its buttons are.
const setupButtons = (page) => [
  ...findAll(page.tree(), (node) => node.type === fakePageHeader).flatMap((node) => node.props.actions ?? []),
  ...findAll(page.tree(), (node) => true),
].filter((node) => node.props?.['data-eb-setup-btn'] !== undefined)

test('kit: the Projects button is a plain Btn in the PageHeader actions, after the checking text', async () => {
  const page = mount({ kit: kitOf() })
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()
  const [header] = findAll(page.tree(), (node) => node.type === fakePageHeader)
  const [checking, projects] = header.props.actions
  assert.equal(checking.props.className, 'eb-checking')
  assert.equal(projects.type, fakeBtn)
  assert.equal(projects.props.primary, undefined)
  assert.equal(projects.props['aria-expanded'], 'false')
  assert.deepEqual(setupButtons(page), [projects])
})

test('kit: the Projects button opens the view and focus goes back to it when the view closes', async () => {
  const page = mount({ kit: kitOf() })
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()
  const focused = []
  page.document.panel = { focus: () => focused.push('panel') }
  page.document.setupBtn = { focus: () => focused.push('setup-btn') }

  setupButtons(page)[0].props.onClick()
  await flush()
  assert.deepEqual(focused, ['panel'])
  assert.equal(setupButtons(page)[0].props['aria-expanded'], 'true')
  page.gateway.answer('/api/chat/folders', [])
  page.chatFetch.answer(1, 200, { source: 'config', config_has_projects: false, projects: [] })
  await flush()
  click(page, 'Close')
  assert.deepEqual(focused, ['panel', 'setup-btn'])
})

test('kit: the first-run notice has a primary "Set up projects" that opens the view, and still no alert', async () => {
  const page = mount({ kit: kitOf() })
  await page.awaitProjects([])
  const [notice] = findAll(page.tree(), (node) => node.props?.className === 'eb-notice')
  assert.equal(notice.props.role, 'status')
  const button = notice.children.find((node) => node.type === fakeBtn)
  assert.equal(button.type, fakeBtn)
  assert.equal(button.props.primary, true)
  assert.equal(button.props['aria-label'], 'Set up projects')
  assert.equal(findAll(page.tree(), (node) => node.props?.role === 'alert').length, 0)
  button.props.onClick()
  await flush()
  assert.match(page.text(), /Loading/)
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
    useRef: (initial) => ({ current: initial }),
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
  // Two calls: the plan route (via planUrl), and the backend client's (chats and projects, under BACKEND_BASE).
  const calls = source.match(/\bfetchFn\s*\(/g) ?? []
  assert.equal(calls.length, 2)
  assert.equal(/\bfetchFn\s*\(\s*planUrl\s*,/.test(source), true, 'one call is on planUrl')
  assert.equal(/\bfetchFn\s*\(\s*BACKEND_BASE\s*\+\s*path\s*\+\s*query\s*,/.test(source), true, 'the other is on BACKEND_BASE + path + query')

  // The paths the page may use: the plan route, the backend's chats and projects routes, and the chat
  // paths of start-a-story (Requirements 4, 6 and 8). Quoted paths first, then the ones built in a template.
  const allowed = new Set([PLAN_URL, BACKEND, '/chats', '/api/chat/slots', '/api/chat', '/projects', '/setup', '/api/chat/folders'])
  const urls = source.match(/['"`](?:https?:)?\/[A-Za-z0-9_\-./]*['"`]/g) ?? []
  assert.deepEqual([...new Set(urls.map((url) => url.slice(1, -1)))].sort(), [...allowed].sort())
  assert.equal(/https?:\/\//.test(source), false)
  // Requirement 6, criterion 6: the page never sends a request that approves, rejects or answers
  // anything for a chat, and never stops or closes one. Nothing in Crew stops it, so this scan does.
  const starts = [...source.matchAll(/[`'"](\/(?:api|chats)[^`'"$]*)/g)].map((match) => match[1])
  assert.ok(starts.length >= 4, 'the scan found the page\'s paths')
  for (const start of starts) {
    assert.ok(['/api/chat/slots', '/api/chat', '/chats', BACKEND].some((prefix) => start.startsWith(prefix)), `unexpected path ${start}`)
    assert.doesNotMatch(start, /approve|question|approvals|stop|close|steer|note|context|delete/i, `forbidden path ${start}`)
  }
  assert.equal(/\/api\/approvals/.test(source), false)
  // The page never deletes anything in Crew: all `.del(` calls go to the app's own backend.
  const dels = source.match(/[A-Za-z_.]+\.del\(/g) ?? []
  assert.ok(dels.length >= 1 && dels.every((d) => d === 'backend.del('), 'only the backend client deletes')
  // PATCH /api/chat/folders/<id> is intentional (cleanup clears project_dir); del/delete/put are still forbidden on Crew paths.
  assert.equal(/\.(del|delete|put)\(\s*['"`]\/api\//.test(source), false, 'no delete or put to Crew')
  assert.equal(/slots\/\$\{[^}]*\}\/(?!resume)/.test(source), false, 'the only per-chat route built in a template is resume')
})

// ---- The chat panel (work-in-the-chat, Requirements 1, 2, 4, 5 and 6.5) ----
// Validates: Requirements 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.1, 2.2, 2.3, 2.6, 2.7, 3.3, 3.4, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 6.5
const BETA = 'one.md#Card Beta'
const NAME_B = 'epic-board-bbbb2222'
const RECORD_B = { card_id: BETA, name: NAME_B, key: NAME_B, created: 't' }
// A fake ChatPanel: one function, so one element type. The fake React draws no components, so the tests read its props from the tree.
function makeChat() {
  return () => null
}
const asideOf = (page) => findAll(page.tree(), (node) => node.type === 'aside')[0]
const chatsOf = (page, Chat) => findAll(page.tree(), (node) => node.type === Chat)
const linkNamed = (page, name) => anchors(page).find((node) => textOf(node) === name)
const clickEvent = (over = {}) => ({ button: 0, prevented: 0, preventDefault() { this.prevented += 1 }, ...over })
const openByClick = (page, name) => {
  const event = clickEvent()
  linkNamed(page, name).props.onClick(event)
  return event
}
// The page with both cards started and working, and the fake ChatPanel mounted by the host.
async function readyChats(Chat, records = [RECORD, RECORD_B], rows = records.map((record) => row(record.key, { running: true }))) {
  const page = mount({ ChatPanel: Chat })
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer(records))
  await flush()
  if (records.length > 0) {
    page.gateway.answer('/api/chat/slots?crew=all', rows)
    await flush()
  }
  return page
}
// Registers the Panel's container and the cards' links as nodes that record focus.
function watchFocus(page) {
  const focused = []
  const node = (id) => ({ getAttribute: (name) => (name === 'data-card-id' ? id : null), focus: () => focused.push(id) })
  page.document.nodes.push(node(ALPHA), node(BETA))
  page.document.panel = { focus: () => focused.push('panel') }
  return focused
}

test('panel: a plain click on a started card opens the Panel with exactly slotKey and conversationOnly', async () => {
  const Chat = makeChat()
  const page = await readyChats(Chat)
  assert.equal(asideOf(page), undefined, 'closed at first')
  assert.equal(page.tree().props.className, 'eb-shell')
  assert.equal(page.tree().children[0].props.className, 'eb-split')
  assert.equal(page.tree().children[0].children[0].props.className, 'eb-root')
  const event = openByClick(page, 'Card Alpha')
  assert.equal(event.prevented, 1)
  assert.equal(asideOf(page).props['aria-label'], 'Chat: Card Alpha')
  assert.equal(page.tree().props['data-panel'], 'open')
  const [element] = chatsOf(page, Chat)
  assert.deepEqual(element.props, { slotKey: NAME, conversationOnly: true })
  assert.equal(element.props.key, undefined)
  assert.match(page.text(), /Chat open/)
})

test('panel: a second started card switches the same instance, and the Open_Card again changes nothing', async () => {
  const Chat = makeChat()
  const page = await readyChats(Chat)
  const focused = watchFocus(page)
  openByClick(page, 'Card Alpha')
  const body = () => findAll(asideOf(page), (node) => node.props.className === 'eb-panel-body')[0]
  const first = body().children[0]
  assert.equal(chatsOf(page, Chat)[0].props.slotKey, NAME)
  openByClick(page, 'Card Beta')
  const second = body().children[0]
  // One element of one type at the same place with no React key: React keeps one instance and gives it a new slotKey.
  assert.equal(second.type, first.type)
  assert.equal(second.props.key, undefined)
  assert.equal(chatsOf(page, Chat).length, 1, 'never two mounted')
  assert.deepEqual(chatsOf(page, Chat)[0].props, { slotKey: NAME_B, conversationOnly: true })
  assert.equal(findAll(page.tree(), (node) => node.props['data-open'] === 'true').length, 1, 'one card is marked')
  assert.equal(findAll(page.tree(), (node) => node.props['data-open'] === 'true')[0].children[0].children[0].children[0], 'Card Beta')
  // The same card again: nothing changes, and focus is not moved again.
  const focusedBefore = focused.length
  openByClick(page, 'Card Beta')
  assert.equal(chatsOf(page, Chat)[0].props.slotKey, NAME_B)
  assert.equal(focused.length, focusedBefore)
})

test('panel: a modifier click, a secondary click and a host with no ChatPanel leave the click to the browser', async () => {
  const Chat = makeChat()
  const page = await readyChats(Chat)
  for (const over of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }]) {
    const event = clickEvent(over)
    linkNamed(page, 'Card Alpha').props.onClick(event)
    assert.equal(event.prevented, 0, JSON.stringify(over))
  }
  assert.equal(asideOf(page), undefined)

  for (const ChatPanel of [undefined, null, 'ChatPanel', {}]) {
    const bare = await readyChats(ChatPanel)
    const event = openByClick(bare, 'Card Alpha')
    assert.equal(event.prevented, 0, 'the link is followed')
    assert.equal(asideOf(bare), undefined)
    assert.equal(findAll(bare.tree(), (node) => node.props['data-open'] === 'true').length, 0)
    assert.equal(linkNamed(bare, 'Card Alpha').props.href, `/chat?sid=${NAME}`)
  }
})

test('panel: openChat opens only a key the page holds a record for', async () => {
  const Chat = makeChat()
  const page = await readyChats(Chat)
  const stale = linkNamed(page, 'Card Alpha').props.onClick // the handler of a card whose record is about to go
  page.clock.advance(5000)
  page.chatFetch.answer(page.chatFetch.calls.length - 1, 200, chatsAnswer([RECORD_B]))
  await flush()
  stale(clickEvent())
  assert.equal(asideOf(page), undefined)
  assert.equal(chatsOf(page, Chat).length, 0)
})

test('panel: a start opens the Panel when the chat is saved, while the send is still open, and replaces another chat', async () => {
  const Chat = makeChat()
  const page = await readyChats(Chat, [RECORD_B])
  openByClick(page, 'Card Beta')
  assert.equal(chatsOf(page, Chat)[0].props.slotKey, NAME_B)
  click(page, 'Card Alpha')
  click(page, 'Start')
  page.chatFetch.answer(1, 200, { card_id: ALPHA, name: NAME, brief: 'THE BRIEF', folder_id: 'f_1' })
  await flush()
  page.gateway.answer('/api/chat/slots', { key: NAME, messages: 0 })
  await flush()
  assert.equal(chatsOf(page, Chat)[0].props.slotKey, NAME_B, 'not before the chat is saved')
  page.chatFetch.answer(2, 200, { card_id: ALPHA, name: NAME, key: NAME })
  await flush()
  assert.equal(page.gateway.pending(), 1, 'the send never answered')
  assert.deepEqual(chatsOf(page, Chat).map((element) => element.props), [{ slotKey: NAME, conversationOnly: true }])
  assert.match(page.text(), /Sending the brief…/, 'the card keeps its note')
  assert.equal(asideOf(page).props['aria-label'], 'Chat: Card Alpha')
})

test('panel: a start that fails before the save leaves the Panel as it was', async () => {
  const Chat = makeChat()
  const page = await readyChats(Chat, [RECORD_B])
  openByClick(page, 'Card Beta')
  click(page, 'Card Alpha')
  click(page, 'Start')
  page.chatFetch.answer(1, 500, { error: { code: 'x', message: 'no' } })
  await flush()
  assert.match(page.text(), /Could not reserve the chat/)
  assert.deepEqual(chatsOf(page, Chat).map((element) => element.props.slotKey), [NAME_B])
})

test('panel: with no ChatPanel a start ends with the link and no Panel', async () => {
  const page = await readyChats(undefined, [])
  click(page, 'Card Alpha')
  click(page, 'Start')
  page.chatFetch.answer(1, 200, { card_id: ALPHA, name: NAME, brief: 'THE BRIEF', folder_id: 'f_1' })
  await flush()
  page.gateway.answer('/api/chat/slots', { key: NAME, messages: 0 })
  await flush()
  page.chatFetch.answer(2, 200, { card_id: ALPHA, name: NAME, key: NAME })
  await flush()
  assert.equal(asideOf(page), undefined)
  assert.equal(linkNamed(page, 'Card Alpha').props.href, `/chat?sid=${NAME}`)
})

test('panel: opening focuses the Panel, Close focuses the card\'s link, and the Open_Card again moves nothing', async () => {
  const Chat = makeChat()
  const page = await readyChats(Chat)
  const focused = watchFocus(page)
  openByClick(page, 'Card Alpha')
  assert.deepEqual(focused, ['panel'])
  openByClick(page, 'Card Alpha')
  assert.deepEqual(focused, ['panel'])
  openByClick(page, 'Card Beta')
  assert.deepEqual(focused, ['panel', 'panel'], 'a new chat in the Panel takes focus too')
  click(page, 'Close')
  assert.equal(asideOf(page), undefined)
  assert.equal(page.tree().props['data-panel'], 'closed')
  assert.equal(findAll(page.tree(), (node) => node.props['data-open'] === 'true').length, 0)
  assert.deepEqual(focused, ['panel', 'panel', BETA])
})

test('panel: Start again closes the Panel without moving focus; a failed read and a missing chat do not close it', async () => {
  const Chat = makeChat()
  const page = await readyChats(Chat, [RECORD])
  const focused = watchFocus(page)
  openByClick(page, 'Card Alpha')
  assert.deepEqual(focused, ['panel'])
  // A failed list in Crew is a failed read: the Panel stays.
  page.clock.advance(5000)
  page.chatFetch.answer(page.chatFetch.calls.length - 1, 200, chatsAnswer([RECORD]))
  await flush()
  page.gateway.fail('/api/chat/slots?crew=all', httpError(500))
  await flush()
  assert.match(page.text(), /Could not read chat status/)
  assert.equal(chatsOf(page, Chat).length, 1)
  // The chat goes missing for over a minute: the card says so, and the Panel stays.
  for (let step = 0; step < 13; step += 1) {
    page.clock.advance(step === 0 ? 15000 : 5000) // a failed read waits 15 s; a chat that is restoring, 5 s
    await missingRead(page)
  }
  assert.match(page.text(), /This chat is not open\./)
  assert.equal(chatsOf(page, Chat).length, 1)
  click(page, 'Resume chat')
  page.gateway.fail(`/api/chat/slots/${NAME}/resume`, httpError(404, null))
  await flush()
  assert.equal(chatsOf(page, Chat).length, 1)
  click(page, 'Start again')
  await flush()
  page.chatFetch.answer(page.chatFetch.calls.length - 1, 200, { removed: true })
  await flush()
  assert.equal(asideOf(page), undefined)
  assert.deepEqual(focused, ['panel'], 'no focus moved')
})

test('panel: the boundary shows the text and the link when the ChatPanel throws, and tries again for another chat', async () => {
  const Chat = (props) => { if (props.slotKey === NAME) throw new Error('boom'); return null }
  const page = await readyChats(Chat)
  openByClick(page, 'Card Alpha')
  const wrapper = findAll(asideOf(page), (node) => node.props.className === 'eb-panel-body')[0].children[0]
  const Boundary = wrapper.type
  assert.equal(typeof Boundary, 'function')
  assert.equal(wrapper.props.slotKey, NAME)
  // Draw the way React does: the child throws, the boundary takes the error into its state and draws its own text.
  const instance = new Boundary(wrapper.props)
  instance.setState = (next) => { instance.state = { ...instance.state, ...next } }
  assert.deepEqual(instance.render(), wrapper.props.children, 'no failure: the children')
  try {
    for (const child of wrapper.children) child.type(child.props)
    assert.fail('the ChatPanel should have thrown')
  } catch (error) {
    assert.equal(error.message, 'boom')
    instance.state = { ...instance.state, ...Boundary.getDerivedStateFromError(error) }
  }
  const shown = h('div', null, instance.render())
  assert.equal(findAll(shown, (node) => node.type === 'p' && node.props.role === 'status').map(textOf).join(), 'The chat could not be shown here.')
  assert.equal(findAll(shown, (node) => node.type === 'a')[0].props.href, `/chat?sid=${NAME}`)
  assert.equal(findAll(shown, (node) => node.props.role === 'alert').length, 0)
  // The Panel's header and Close stay outside the boundary and work.
  assert.ok(buttonNamed(page, 'Close'))
  // Another chat clears the failure; the same key does not.
  const previous = instance.props
  instance.componentDidUpdate(previous)
  assert.equal(instance.state.failed, true)
  instance.props = { slotKey: NAME_B }
  instance.componentDidUpdate(previous)
  assert.equal(instance.state.failed, false)
})

test('panel: unmounting with the Panel open leaves no listener or timer', async () => {
  const Chat = makeChat()
  const page = await readyChats(Chat)
  openByClick(page, 'Card Alpha')
  page.unmount()
  assert.equal(page.document.listenerCount(), 0)
  assert.equal(page.clock.pending(), 0)
})

test('panel: opening and closing the Panel sends no request', async () => {
  const Chat = makeChat()
  const page = await readyChats(Chat)
  const counts = () => [page.fetch.calls.length, page.chatFetch.calls.length, page.gateway.paths().join()]
  const before = counts()
  openByClick(page, 'Card Alpha')
  openByClick(page, 'Card Beta')
  click(page, 'Close')
  await flush()
  assert.deepEqual(counts(), before)
})

test('panel: a read of the records that does not list the chat does not close the Panel', async () => {
  const Chat = makeChat()
  const page = await readyChats(Chat, [RECORD])
  openByClick(page, 'Card Alpha')
  page.clock.advance(5000)
  page.chatFetch.answer(page.chatFetch.calls.length - 1, 200, chatsAnswer([]))
  await flush()
  assert.equal(anchors(page).length, 0, 'the card has no chat now')
  assert.deepEqual(chatsOf(page, Chat).map((element) => element.props.slotKey), [NAME])
  assert.equal(asideOf(page).props['aria-label'], 'Chat: Card Alpha')
})

// ---- Board design, group 3: the cards and the Projects panel with a kit ----

const cardKit = () => ({ Btn: fakeBtn, Card: () => null, CardTitle: () => null, Badge: () => null })
const pressable = (page, label) => findAll(page.tree(), (node) => (node.type === 'button' || node.type === fakeBtn) && textOf(node) === label)[0]

test('kit: the kit is read on every render, so a component that arrives later is drawn from then on', async () => {
  const kit = {}
  const page = mount({ kit })
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()
  const cardClasses = () => findAll(page.tree(), (node) => node.type === 'li').map((li) => li.props.className)
  assert.ok(cardClasses().every((name) => name === 'eb-card eb-fb'))
  kit.Card = () => null
  findAll(page.tree(), (node) => node.props['data-card-id'] === ALPHA)[0].props.onClick() // any change renders again
  await flush()
  assert.ok(cardClasses().every((name) => name === 'eb-item'))
})

test('kit: a card behaves the same with and without the kit, Start is primary and the others are plain', async () => {
  for (const kit of [undefined, cardKit()]) {
    const page = mount({ kit })
    await page.awaitProjects()
    page.fetch.answer(0, 200, plan())
    page.chatFetch.answer(0, 200, chatsAnswer([]))
    await flush()
    const [main] = findAll(page.tree(), (node) => node.props['data-card-id'] === ALPHA)
    assert.equal(main.type, 'button')
    main.props.onClick()
    await flush()
    const start = pressable(page, 'Start')
    const cancel = pressable(page, 'Cancel')
    if (kit) {
      assert.deepEqual([start.type === fakeBtn, start.props.primary, cancel.type === fakeBtn, cancel.props.primary], [true, true, true, undefined])
    } else {
      assert.deepEqual([start.type, cancel.type], ['button', 'button'])
    }
    assert.equal(start.props['data-eb-start'], ALPHA)
    cancel.props.onClick()
    await flush()
    assert.equal(pressable(page, 'Start'), undefined)
    assert.deepEqual(findAll(page.tree(), (node) => node.props['data-card-id'] === ALPHA).map((node) => node.type), ['button'])
  }
})

test('kit: a start, with the buttons as Btn, sends the brief as before', async () => {
  const page = mount({ kit: cardKit() })
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()
  findAll(page.tree(), (node) => node.props['data-card-id'] === ALPHA)[0].props.onClick()
  await flush()
  pressable(page, 'Start').props.onClick()
  await flush()
  assert.equal(page.chatFetch.calls.some(([url, options]) => /\/chats/.test(url) && options.method === 'POST'), true)
})

test('kit: the panel opens from the Projects button, Close and Cancel close it and focus returns to the button', async () => {
  for (const label of ['Close', 'Cancel']) {
    const page = mount({ kit: cardKit() })
    await page.awaitProjects()
    page.fetch.answer(0, 200, plan())
    page.chatFetch.answer(0, 200, chatsAnswer([]))
    await flush()
    const focused = []
    page.document.panel = { focus: () => focused.push('panel') }
    page.document.setupBtn = { focus: () => focused.push('setup-btn') }
    setupButtons(page)[0].props.onClick()
    await flush()
    assert.equal(findAll(page.tree(), (node) => node.type === 'aside').length, 1)
    page.gateway.answer('/api/chat/folders', [{ id: 'f1', name: 'Alpha', project_dir: '/a' }])
    page.chatFetch.answer(1, 200, { source: 'config', config_has_projects: false, projects: [] })
    await flush()
    const aside = findAll(page.tree(), (node) => node.type === 'aside')[0]
    assert.equal(aside.props['aria-label'], 'Projects')
    assert.equal(findAll(aside, (node) => /^h[1-6]$/.test(String(node.type))).length, 0, 'no heading in the panel')
    assert.equal(pressable(page, 'Close').type, fakeBtn, 'the panel Close is a Btn')
    pressable(page, label).props.onClick()
    await flush()
    assert.equal(findAll(page.tree(), (node) => node.type === 'aside').length, 0)
    assert.deepEqual(focused, ['panel', 'setup-btn'])
  }
})

test('kit: the folder-read failure shows an error notice with status, and Try again is a plain Btn', async () => {
  const page = mount({ kit: cardKit() })
  await page.awaitProjects()
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer([]))
  await flush()
  setupButtons(page)[0].props.onClick()
  await flush()
  page.gateway.fail('/api/chat/folders', new Error('no folders'))
  page.chatFetch.answer(1, 200, { source: 'config', config_has_projects: false, projects: [] })
  await flush()
  const notice = findAll(page.tree(), (node) => String(node.props.className ?? '').includes('eb-notice-error'))[0]
  assert.deepEqual([notice.props.role, textOf(notice)], ['status', 'no folders'])
  const retry = pressable(page, 'Try again')
  assert.deepEqual([retry.type === fakeBtn, retry.props.primary], [true, undefined])
  retry.props.onClick()
  await flush()
  assert.match(page.text(), /Loading/)
})

// ---- Cleanup flow (a-worktree-per-card Requirements 5.1-5.5, 7.2) ----

const WT_PATH = '/home/alice/my-project--epic-board-aaaa1111'
const WT_FOLDER_ID = 'wf_123'
const WRECORD = { card_id: ALPHA, name: NAME, key: NAME, created: 't', worktree_path: WT_PATH, worktree_folder_id: WT_FOLDER_ID }
const openPr = { kind: 'change', number: 1, url: 'https://github.com/o/r/pull/1', state: 'open' }
const mergedPr = { kind: 'change', number: 1, url: 'https://github.com/o/r/pull/1', state: 'merged' }

// One read cycle: answer the records fetch then the Crew list, return the index after.
async function chatCycleWith(page, records, crewRows) {
  const idx = page.chatFetch.calls.length - 1
  page.chatFetch.answer(idx, 200, chatsAnswer(records))
  await flush()
  page.gateway.answer('/api/chat/slots?crew=all', crewRows)
  await flush()
}

// Drive a chat into review state (open PR, needs detail read), return the index used.
async function reviewCycle(page, records, extraRow = {}) {
  await chatCycleWith(page, records, [row(NAME, { source_links: [openPr], ...extraRow })])
  page.gateway.answer(detailPath(NAME), { messages: [{ role: 'assistant' }] })
  await flush()
}

test('cleanup: PR merged → worktree route called, subfolder PATCHed, record deleted, card resets', async () => {
  const page = await ready({}, [WRECORD])
  // Cycle 1: open PR → review state (caches roleRead)
  await reviewCycle(page, [WRECORD])
  assert.match(page.text(), /Review #1/)

  // Advance to trigger the next read (review state uses 15 s delay)
  page.clock.advance(15000)
  // Cycle 2: same records, merged PR → prTerminated detected
  await chatCycleWith(page, [WRECORD], [row(NAME, { source_links: [mergedPr] })])

  // cleanupRecord starts: DELETE /chats/name/worktree
  const worktreeIdx = page.chatFetch.calls.length - 1
  page.chatFetch.answer(worktreeIdx, 200, { ok: true })
  await flush()

  // Then PATCH /api/chat/folders/wf_123
  assert.ok(page.gateway.calls.some(([verb, path]) => verb === 'patch' && path === `/api/chat/folders/${WT_FOLDER_ID}`), 'PATCH called on worktree folder')
  page.gateway.answer(`/api/chat/folders/${WT_FOLDER_ID}`, {})
  await flush()

  // Then DELETE /chats/name
  const deleteIdx = page.chatFetch.calls.length - 1
  page.chatFetch.answer(deleteIdx, 200, { removed: true })
  await flush()

  // Card resets: no link, Start button available (after clicking the card)
  assert.equal(anchors(page).filter((a) => a.props.href === `/chat?sid=${NAME}`).length, 0, 'link gone after cleanup')
  click(page, 'Card Alpha')
  assert.match(page.text(), /Start a conductor on this story\?/)
})

test('cleanup: worktree_has_changes → "Worktree kept" shown with role=status, "Remove anyway" button present', async () => {
  const page = await ready({}, [WRECORD])
  await reviewCycle(page, [WRECORD])

  page.clock.advance(15000)
  await chatCycleWith(page, [WRECORD], [row(NAME, { source_links: [mergedPr] })])

  // DELETE /chats/name/worktree → 409 worktree_has_changes
  const worktreeIdx = page.chatFetch.calls.length - 1
  page.chatFetch.answer(worktreeIdx, 409, { error: { code: 'worktree_has_changes', message: 'has changes', path: WT_PATH } })
  await flush()

  assert.match(page.text(), /Worktree kept/)
  assert.match(page.text(), new RegExp(WT_PATH.replace(/\//g, '\\/')))
  const statusEls = findAll(page.tree(), (n) => n.props?.role === 'status')
  assert.ok(statusEls.some((el) => textOf(el).includes('Worktree kept')), 'Worktree kept text has role=status')
  const removeAnyway = buttonNamed(page, 'Remove anyway')
  assert.ok(removeAnyway, '"Remove anyway" button present')
  assert.equal(removeAnyway.type, 'button', '"Remove anyway" is a native button when no Btn kit')
})

test('cleanup: "Remove anyway" force-removes the worktree and resets the card', async () => {
  const page = await ready({}, [WRECORD])
  await reviewCycle(page, [WRECORD])

  page.clock.advance(15000)
  await chatCycleWith(page, [WRECORD], [row(NAME, { source_links: [mergedPr] })])

  // 409 → "Worktree kept" state
  page.chatFetch.answer(page.chatFetch.calls.length - 1, 409, { error: { code: 'worktree_has_changes', message: 'has changes', path: WT_PATH } })
  await flush()
  assert.ok(buttonNamed(page, 'Remove anyway'))

  // Click "Remove anyway"
  click(page, 'Remove anyway')
  await flush()

  // DELETE /chats/name/worktree?force=true
  const forceCall = page.chatFetch.calls.find(([url]) => url.includes('/worktree?force=true'))
  assert.ok(forceCall, 'force-remove route called')
  const forceIdx = page.chatFetch.calls.indexOf(forceCall)
  page.chatFetch.answer(forceIdx, 200, { ok: true })
  await flush()

  // PATCH folder
  page.gateway.answer(`/api/chat/folders/${WT_FOLDER_ID}`, {})
  await flush()

  // DELETE record
  page.chatFetch.answer(page.chatFetch.calls.length - 1, 200, { removed: true })
  await flush()

  // Card resets
  assert.doesNotMatch(page.text(), /Worktree kept/)
  assert.equal(anchors(page).filter((a) => a.props.href === `/chat?sid=${NAME}`).length, 0)
})

test('cleanup: non-worktree record (worktree_path null) skips worktree route, deletes record directly', async () => {
  const nullRecord = { card_id: ALPHA, name: NAME, key: NAME, created: 't', worktree_path: null, worktree_folder_id: null }
  const page = await ready({}, [nullRecord])
  await reviewCycle(page, [nullRecord])

  page.clock.advance(15000)
  await chatCycleWith(page, [nullRecord], [row(NAME, { source_links: [mergedPr] })])

  const callsBefore = page.chatFetch.calls.length
  // No worktree DELETE, no PATCH; only the record DELETE
  const deleteIdx = page.chatFetch.calls.length - 1
  page.chatFetch.answer(deleteIdx, 200, { removed: true })
  await flush()

  assert.ok(!page.chatFetch.calls.some(([url]) => url.includes('/worktree')), 'no worktree route called')
  assert.ok(!page.gateway.calls.some(([verb]) => verb === 'patch'), 'no PATCH to Crew')
  assert.equal(anchors(page).filter((a) => a.props.href === `/chat?sid=${NAME}`).length, 0, 'card reset after record delete')
})
