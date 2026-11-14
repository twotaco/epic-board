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
    querySelectorAll(selector) {
      assert.equal(selector, '[data-card-id]')
      return this.nodes
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
function mount({ hidden = false, api } = {}) {
  const clock = makeClock()
  const planFetch = makeFetch()
  const chatFetch = makeFetch()
  const gateway = makeGateway()
  const document = makeDocument(hidden)
  const fetch = (url, options) => (url === PLAN_URL ? planFetch : chatFetch)(url, options)
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
    createElement: h,
  }
  const Board = createBoard(React, {
    fetch,
    document,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: () => clock.now(),
    useAppApi: () => (api === undefined ? gateway : api),
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
    gateway,
    document,
    clock,
    instance,
    tree: () => tree,
    text: () => textOf(tree),
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
  assert.equal(page.chatFetch.calls.length, 1)
  assert.equal(page.chatFetch.calls[0][0], `${BACKEND}/chats`)
  assert.equal(page.chatFetch.calls[0][1].method, 'GET')
  page.chatFetch.answer(0, 200, { folder_id: 'f_1', folder_reason: null, chats: [] })
  await flush()
  assert.deepEqual(page.gateway.calls, [], 'no started chats: nothing is sent to Crew')
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

test('unmounting removes the same listeners it added (one for the plan, one for the chats)', async () => {
  const page = mount()
  assert.equal(page.document.added.length, 2)
  assert.deepEqual(page.document.added.map(([type]) => type), ['visibilitychange', 'visibilitychange'])
  assert.equal(page.document.listenerCount(), 2)
  page.unmount()
  assert.equal(page.document.removed.length, 2)
  assert.deepEqual(page.document.removed.map(([, fn]) => fn).sort(), page.document.added.map(([, fn]) => fn).sort())
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

// ---- Chats and starting a story (start-a-story Requirements 2, 4, 6, 7, 8 and 9) ----
// Validates: Requirements 4.6, 4.7, 6.6, 6.7, 6.8, 6.9, 8.6, 9.4, 9.6
const ALPHA = 'one.md#Card Alpha'
const NAME = 'epic-board-aaaa1111'
const RECORD = { card_id: ALPHA, name: NAME, key: NAME, created: 't' }
const chatsAnswer = (chats = []) => ({ folder_id: 'f_1', folder_reason: null, chats })
const row = (key, extra = {}) => ({ key, running: false, pending_approval: false, needs_input: false, interrupted: false, last_ts: 't1', messages: 3, ...extra })
const detailPath = (key) => `/api/chat/slots/${encodeURIComponent(key)}?limit=1`
const buttonNamed = (page, label) => findAll(page.tree(), (node) => node.type === 'button' && textOf(node) === label)[0]
const click = (page, label) => {
  const button = buttonNamed(page, label)
  assert.ok(button, `no button "${label}"`)
  button.props.onClick()
}
const anchors = (page) => findAll(page.tree(), (node) => node.type === 'a')
// Opens the page with a plan on the board and the chats route answered.
async function ready(options = {}, chats = []) {
  const page = mount(options)
  page.fetch.answer(0, 200, plan())
  page.chatFetch.answer(0, 200, chatsAnswer(chats))
  await flush()
  return page
}
// One read of a started chat that Crew has not got: the records, an empty list, a 404 for the chat.
async function missingRead(page) {
  page.chatFetch.answer(page.chatFetch.calls.length - 1, 200, chatsAnswer([RECORD]))
  await flush()
  page.gateway.answer('/api/chat/slots', [])
  await flush()
  page.gateway.fail(detailPath(NAME), httpError(404))
  await flush()
}
const NOTICE = 'Could not read chat status. Showing the last known states.'

test('the chats route is read on open, and the list in Crew only when there are started chats', async () => {
  const page = mount()
  assert.equal(page.chatFetch.calls.length, 1)
  const [url, options] = page.chatFetch.calls[0]
  assert.equal(url, `${BACKEND}/chats`)
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
  assert.deepEqual(page.gateway.paths(), ['/api/chat/slots'])
  const init = page.gateway.calls[0][2]
  assert.equal(typeof init.signal.aborted, 'boolean')
  page.gateway.answer('/api/chat/slots', [row(NAME, { running: true }), row('someone-elses', { pending_approval: true })])
  await flush()
  const text = page.text()
  assert.match(text, /Working/)
  assert.doesNotMatch(text, /Needs you|someone-elses/)
  assert.equal(anchors(page)[0].props.href, `/chat?sid=${NAME}`)
  assert.deepEqual(page.gateway.paths(), ['/api/chat/slots'], 'a working chat needs no read of its rows')
  page.clock.advance(4999)
  assert.equal(page.chatFetch.calls.length, 1)
  page.clock.advance(1)
  assert.equal(page.chatFetch.calls.length, 2)
})

test('an idle chat has its newest row read once, and the next read is 15 s away', async () => {
  const page = await ready({}, [RECORD])
  page.gateway.answer('/api/chat/slots', [row(NAME)])
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
  page.gateway.answer('/api/chat/slots', [row(NAME)])
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
  assert.deepEqual([page.fetch.calls.length, page.chatFetch.calls.length], [1, 1])
})

test('a start: the question, then the requests in order, then the link at once and a read at once', async () => {
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
  assert.equal(reserveUrl, `${BACKEND}/chats`)
  assert.deepEqual([reserve.method, reserve.credentials, reserve.headers], ['POST', 'same-origin', { 'Content-Type': 'application/json' }])
  assert.deepEqual(JSON.parse(reserve.body), { card_id: ALPHA })

  page.chatFetch.answer(1, 200, { card_id: ALPHA, name: NAME, brief: 'THE BRIEF', folder_id: 'f_1' })
  await flush()
  assert.deepEqual(page.gateway.calls, [['post', '/api/chat/slots', { name: NAME, agent: 'kirocrew-conductor', folder_id: 'f_1' }]])
  page.gateway.answer('/api/chat/slots', { key: NAME, messages: 0 })
  await flush()
  assert.deepEqual(page.gateway.calls[1], ['post', '/api/chat', { slot: NAME, message: 'THE BRIEF' }])
  page.gateway.answer('/api/chat', {})
  await flush()
  const [savedUrl, saved] = page.chatFetch.calls[2]
  assert.equal(savedUrl, `${BACKEND}/chats/${NAME}/started`)
  assert.deepEqual(JSON.parse(saved.body), { key: NAME })
  assert.equal(anchors(page).length, 0, 'not before the save is answered')
  page.chatFetch.answer(2, 200, { card_id: ALPHA, name: NAME, key: NAME })
  await flush()

  assert.equal(anchors(page)[0].props.href, `/chat?sid=${NAME}`, 'the link shows at once')
  assert.doesNotMatch(page.text(), /Starting…|Start a conductor on this story\?/)
  assert.equal(page.chatFetch.calls.length, 4, 'and a read of the records follows at once')
  assert.equal(page.chatFetch.calls[3][1].method, 'GET')
  assert.equal(page.chatFetch.calls[3][0], `${BACKEND}/chats`)
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

test('the question is open on one card at a time, and a Done card with no chat has no button', async () => {
  const page = mount()
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
  page.gateway.answer('/api/chat/slots', [])
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
  page.gateway.answer('/api/chat/slots', [])
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
  assert.deepEqual([url, options.method], [`${BACKEND}/chats/${NAME}`, 'DELETE'])
  page.chatFetch.answer(page.chatFetch.calls.length - 1, 200, { removed: true })
  await flush()
  assert.equal(page.gateway.calls.length, callsToCrew, 'nothing was sent to Crew')
  assert.match(page.text(), /Start a conductor on this story\?/)
  assert.equal(anchors(page).length, 0)
})

test('a failed chat read keeps the shown states and adds the notice; a good read removes it; the plan is untouched', async () => {
  const page = await ready({}, [RECORD])
  page.gateway.answer('/api/chat/slots', [row(NAME, { running: true })])
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
  page.gateway.answer('/api/chat/slots', [row(NAME, { running: true })])
  await flush()
  assert.equal(page.text().includes(NOTICE), false)
})

test('a failing list in Crew is a failed read too', async () => {
  const page = await ready({}, [RECORD])
  page.gateway.fail('/api/chat/slots', httpError(500, null))
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
  page.gateway.answer('/api/chat/slots', rows)
  await flush()
}
test('a failed plan request keeps the chat states and shows only the plan notice', async () => {
  const page = await ready({}, [RECORD])
  const rows = [row(NAME, { pending_approval: true, running: true })]
  page.gateway.answer('/api/chat/slots', rows)
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
  // Two calls: the plan route, and the backend client's (the chats routes, under BACKEND_BASE).
  const calls = source.match(/\bfetchFn\s*\(/g) ?? []
  assert.equal(calls.length, 2)
  assert.equal(/\bfetchFn\s*\(\s*PLAN_URL\s*,/.test(source), true, 'one call is on PLAN_URL')
  assert.equal(/\bfetchFn\s*\(\s*BACKEND_BASE\s*\+\s*path\s*,/.test(source), true, 'the other is on BACKEND_BASE + path')

  // The paths the page may use: the plan route, the backend's chats route, and the chat paths of
  // start-a-story (Requirements 4, 6 and 8). Quoted paths first, then the ones built in a template.
  const allowed = new Set([PLAN_URL, BACKEND, '/chats', '/api/chat/slots', '/api/chat'])
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
  // The page never deletes, stops or closes a chat in Crew: the one `.del(` is the backend's (Start again).
  const dels = source.match(/[A-Za-z_.]+\.del\(/g) ?? []
  assert.deepEqual(dels, ['backend.del('], 'only the backend client deletes')
  assert.equal(/\.(del|delete|put|patch)\(\s*['"`]\/api\//.test(source), false, 'no write but post to Crew')
  assert.equal(/slots\/\$\{[^}]*\}\/(?!resume)/.test(source), false, 'the only per-chat route built in a template is resume')
})
