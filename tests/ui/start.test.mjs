// Starting a story, sending its brief, resuming a chat and "Start again", against fakes of the backend and Crew.
// Property 7: A chat is saved before its brief is sent, and the brief is never sent twice.
// Validates: Requirements 4.3, 4.4, 4.5, 4.6, 4.7, 4.9
import test from 'node:test'
import assert from 'node:assert/strict'
import { SEND_WAIT_MS, StartError, resumeChat, retryBrief, sendBrief, startAgain, startStory } from '../../ui/index.mjs'
import { forSeedsAsync } from './support.mjs'

const httpError = (status, error) => Object.assign(new Error(`API ${status}`), { status, error })
const CARD = 'epic-board.md#Filter by epic'
const RESERVATION = { card_id: CARD, name: 'epic-board-3fa91c0e', brief: 'THE BRIEF', folder_id: 'f_8c1' }
const KEY = 'epic-board-3fa91c0e'
const flush = () => new Promise((resolve) => setImmediate(resolve))

// Virtual timers: nothing fires until the test advances the clock.
function makeTimers() {
  let now = 0
  let nextId = 1
  let timers = []
  const api = {
    setTimer(fn, ms) {
      const id = nextId
      nextId += 1
      timers.push({ id, at: now + ms, fn })
      return id
    },
    clearTimer(id) {
      timers = timers.filter((timer) => timer.id !== id)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = timers.filter((timer) => timer.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)
        if (due.length === 0) break
        const timer = due[0]
        timers = timers.filter((other) => other !== timer)
        now = timer.at
        timer.fn()
      }
      now = target
    },
    pending: () => timers.length,
  }
  return api
}

// Records every call, in order, in one shared log, and answers from `answers`: a function
// (path, ...rest) -> value, or an Error to throw, or a promise.
function recorder(answers, log = [], tag = '') {
  const calls = []
  const make = (verb) => (path, ...rest) => {
    calls.push([verb, path, ...rest])
    log.push(`${tag}${verb} ${path}`)
    const answer = typeof answers === 'function' ? answers(verb, path, ...rest) : undefined
    if (answer instanceof Error) return Promise.reject(answer)
    return Promise.resolve(answer)
  }
  return { calls, get: make('get'), post: make('post'), del: make('del') }
}

// A backend and a Crew that work, sharing one log so the order of their requests can be read.
function working({ messages = 0, send } = {}) {
  const log = []
  const backend = recorder((verb, path) => (path === '/chats' ? RESERVATION : { ok: true }), log, 'backend ')
  const gateway = recorder((verb, path) => {
    if (path === '/api/chat/slots') return { key: KEY, messages }
    if (path === '/api/chat' && send) return send()
    return {}
  }, log, 'crew ')
  return { backend, gateway, log }
}

// Lets a promise settle, advancing the virtual clock by `step` while it has not. Returns {value} or {error}.
async function settle(promise, timers, step = SEND_WAIT_MS) {
  let outcome = null
  promise.then((value) => { outcome = { value } }, (error) => { outcome = { error } })
  for (let i = 0; i < 40 && outcome === null; i += 1) {
    await flush()
    if (outcome === null) timers.advance(step)
  }
  assert.notEqual(outcome, null, 'the promise never settled')
  return outcome
}

// ---- the order of a start ----

test('the requests of a start, in order: reserve, create, save, then send, with exactly the bodies of the spec', async () => {
  const { backend, gateway, log } = working()
  const timers = makeTimers()
  const steps = []
  const saved = []
  const result = await startStory({ cardId: CARD, backend, gateway, onStep: (step) => steps.push(step), onSaved: (s) => { saved.push(s); log.push('onSaved') }, ...timers })
  assert.deepEqual(steps, ['reserve', 'create', 'save', 'send'])
  assert.deepEqual(log, ['backend post /chats', 'crew post /api/chat/slots', `backend post /chats/${KEY}/started`, 'onSaved', 'crew post /api/chat'])
  assert.deepEqual(backend.calls, [['post', '/chats', { card_id: CARD }], ['post', `/chats/${KEY}/started`, { key: KEY }]])
  assert.deepEqual(gateway.calls, [
    ['post', '/api/chat/slots', { name: KEY, agent: 'kirocrew-conductor', folder_id: 'f_8c1' }],
    ['post', '/api/chat', { slot: KEY, message: 'THE BRIEF' }],
  ])
  assert.deepEqual(Object.keys(gateway.calls[0][2]).sort(), ['agent', 'folder_id', 'name'])
  assert.deepEqual(saved, [{ cardId: CARD, name: KEY, key: KEY, brief: 'THE BRIEF' }])
  assert.deepEqual(result, saved[0])
  assert.equal(timers.pending(), 0, 'the send timer is cleared when the request answers')
})

test('onSaved runs before the brief is sent, and before anything is asked of the conductor', async () => {
  const { backend, gateway, log } = working()
  let sentWhenSaved = null
  await startStory({
    cardId: CARD, backend, gateway, ...makeTimers(),
    onSaved: () => { sentWhenSaved = gateway.calls.some(([, path]) => path === '/api/chat') },
  })
  assert.equal(sentWhenSaved, false)
  assert.ok(log.indexOf(`backend post /chats/${KEY}/started`) < log.indexOf('crew post /api/chat'))
})

test('the key Crew gives the chat is the one that is saved and sent, even when it differs from the name', async () => {
  const log = []
  const backend = recorder((verb, path) => (path === '/chats' ? RESERVATION : {}), log)
  const gateway = recorder((verb, path) => (path === '/api/chat/slots' ? { key: 'folded-key', messages: 0 } : {}), log)
  const result = await startStory({ cardId: CARD, backend, gateway, ...makeTimers() })
  assert.deepEqual(backend.calls[1], ['post', `/chats/${KEY}/started`, { key: 'folded-key' }])
  assert.deepEqual(gateway.calls[1], ['post', '/api/chat', { slot: 'folded-key', message: 'THE BRIEF' }])
  assert.equal(result.key, 'folded-key')
})

test('a chat that already holds a message is saved and not sent the brief again', async () => {
  const { backend, gateway } = working({ messages: 1 })
  const saved = []
  const steps = []
  await startStory({ cardId: CARD, backend, gateway, onStep: (step) => steps.push(step), onSaved: (s) => saved.push(s), ...makeTimers() })
  assert.deepEqual(gateway.calls.map(([, path]) => path), ['/api/chat/slots'])
  assert.equal(backend.calls.length, 2)
  assert.equal(saved.length, 1)
  assert.deepEqual(steps, ['reserve', 'create', 'save', 'send'])
})

// ---- a send that never answers ----

test('a send that never answers does not hold the start: the chat is saved at once, and the brief counts as sent after 10 seconds', async () => {
  const timers = makeTimers()
  let lateReject
  const { backend, gateway, log } = working({ send: () => new Promise((resolve, reject) => { lateReject = reject }) })
  const saved = []
  let done = null
  const promise = startStory({ cardId: CARD, backend, gateway, onSaved: (s) => saved.push(s), ...timers })
  promise.then((value) => { done = { value } }, (error) => { done = { error } })
  await flush()
  await flush()
  // The chat is saved and shown while the request is still open.
  assert.equal(saved.length, 1)
  assert.deepEqual(backend.calls[1], ['post', `/chats/${KEY}/started`, { key: KEY }])
  assert.ok(log.includes('crew post /api/chat'), 'the send has been made')
  assert.equal(done, null, 'and the start is still waiting')
  timers.advance(SEND_WAIT_MS - 1)
  await flush()
  assert.equal(done, null, 'not ended at 9999 ms')
  timers.advance(1)
  await flush()
  assert.deepEqual(done?.value, saved[0], 'ended at 10000 ms with no error: sent')
  assert.equal(done.error, undefined)
  assert.equal(timers.pending(), 0)
  // What the open request answers later, an error too, is ignored.
  lateReject(new TypeError('Failed to fetch'))
  await flush()
  await flush()
  assert.deepEqual(done?.value, saved[0])
})

test('the page does not abort a send it has stopped waiting for', async () => {
  const timers = makeTimers()
  const { backend, gateway } = working({ send: () => new Promise(() => {}) })
  await settle(startStory({ cardId: CARD, backend, gateway, ...timers }), timers)
  const sendCall = gateway.calls.find(([, path]) => path === '/api/chat')
  assert.equal(sendCall.length, 3, 'the call has a path and a body and nothing else, so no signal')
  assert.deepEqual(sendCall[2], { slot: KEY, message: 'THE BRIEF' })
})

test('a send that answers before 10 seconds ends the wait at once', async () => {
  const timers = makeTimers()
  let answer
  const { backend, gateway } = working({ send: () => new Promise((resolve) => { answer = resolve }) })
  let done = false
  startStory({ cardId: CARD, backend, gateway, ...timers }).then(() => { done = true })
  await flush()
  await flush()
  timers.advance(9999)
  assert.equal(done, false)
  answer({})
  await flush()
  assert.equal(done, true)
  assert.equal(timers.pending(), 0, 'the timer was cleared')
})

// ---- a send that fails ----

test('a send that fails before 10 seconds throws a send failure that carries what was saved, and the chat stays saved', async () => {
  const timers = makeTimers()
  const { backend, gateway } = working({ send: () => httpError(500, null) })
  const saved = []
  const failure = await startStory({ cardId: CARD, backend, gateway, onSaved: (s) => saved.push(s), ...timers }).catch((error) => error)
  assert.ok(failure instanceof StartError)
  assert.equal(failure.step, 'send')
  assert.equal(failure.reason, 'API 500')
  assert.deepEqual(failure.saved, { cardId: CARD, name: KEY, key: KEY, brief: 'THE BRIEF' })
  assert.equal(saved.length, 1)
  assert.equal(backend.calls.length, 2, 'the chat was saved before the send failed')
})

test('a send that fails after 5 seconds, still before 10, is a failure; one that fails after 10 is not', async () => {
  let reject
  const timers = makeTimers()
  const { backend, gateway } = working({ send: () => new Promise((resolve, r) => { reject = r }) })
  const promise = startStory({ cardId: CARD, backend, gateway, ...timers })
  await flush()
  await flush()
  timers.advance(5000)
  reject(new TypeError('Failed to fetch'))
  const failure = await promise.catch((error) => error)
  assert.equal(failure.step, 'send')
  assert.equal(failure.reason, 'Failed to fetch')
})

test('an error that only says Crew accepted the request counts as sent', async () => {
  const accepted = Object.assign(new Error('Crew accepted the request but the answer was not JSON'), { name: 'AcceptedBodyUnreadable' })
  const { backend, gateway } = working({ send: () => accepted })
  const result = await startStory({ cardId: CARD, backend, gateway, ...makeTimers() })
  assert.equal(result.key, KEY)
})

// ---- the steps before the save ----

test('each step before the send failing throws a StartError that names the step and keeps the reason; a failure before the save sends nothing', async () => {
  const cases = [
    ['reserve', () => ({ backend: recorder((v, path) => (path === '/chats' ? httpError(409, { code: 'card_done', message: 'That story is done.' }) : {})), gateway: recorder(() => ({})) }), 'That story is done.', 'card_done'],
    ['create', () => ({ ...working(), gateway: recorder((v, path) => (path === '/api/chat/slots' ? new Error('API 400: {"error":"folder not found"}') : {})) }), 'API 400: {"error":"folder not found"}', null],
    ['save', () => {
      const { gateway } = working()
      return { gateway, backend: recorder((v, path) => (path === '/chats' ? RESERVATION : httpError(500, { code: 'internal', message: 'The board\'s file of chats could not be written.' }))) }
    }, 'The board\'s file of chats could not be written.', 'internal'],
  ]
  for (const [step, build, reason, code] of cases) {
    const { backend, gateway } = build()
    const steps = []
    const saved = []
    await assert.rejects(startStory({ cardId: CARD, backend, gateway, onStep: (s) => steps.push(s), onSaved: (s) => saved.push(s), ...makeTimers() }), (error) => {
      assert.ok(error instanceof StartError, step)
      assert.equal(error.step, step)
      assert.equal(error.reason, reason)
      assert.equal(error.code, code)
      assert.equal(error.saved, undefined, 'nothing was saved')
      return true
    }, step)
    assert.equal(steps.at(-1), step, 'the last step named is the one that failed')
    assert.deepEqual(saved, [])
    assert.ok(!gateway.calls.some(([, path]) => path === '/api/chat'), `no brief after a failed ${step}`)
  }
})

test('every refusal of a reservation is shown with the backend\'s own words, and nothing is sent to Crew', async () => {
  const refusals = [
    ['card_not_found', 'That story is not in the plan on the main branch.'], ['card_done', 'That story is done.'],
    ['chat_exists', 'This story already has a chat.'], ['folder_not_set', 'No Crew folder is set for this project.'],
    ['plan_not_ready', 'The plan has not been read yet.'], ['chats_unreadable', '/x/chats.json cannot be read.'],
  ]
  for (const [code, message] of refusals) {
    const backend = recorder((v, path) => httpError(path === '/chats' ? 409 : 500, { code, message }))
    const gateway = recorder(() => ({}))
    await assert.rejects(startStory({ cardId: CARD, backend, gateway, ...makeTimers() }), (error) => error.step === 'reserve' && error.reason === message && error.code === code, code)
    assert.deepEqual(gateway.calls, [])
  }
})

test('a create answer with no text key fails the create step, and a bad reservation fails the reserve step', async () => {
  for (const row of [{}, { key: '' }, { key: 5 }, null, undefined, 'x']) {
    const { backend } = working()
    const gateway = recorder((v, path) => (path === '/api/chat/slots' ? row : {}))
    await assert.rejects(startStory({ cardId: CARD, backend, gateway, ...makeTimers() }), (error) => error.step === 'create', JSON.stringify(row))
    assert.equal(gateway.calls.length, 1)
    assert.equal(backend.calls.length, 1, 'a chat with no key is not saved')
  }
  for (const reservation of [{}, { name: 'n' }, { name: 'n', brief: 'b' }, { name: 3, brief: 'b', folder_id: 'f' }, null, 'x']) {
    const backend = recorder((v, path) => (path === '/chats' ? reservation : {}))
    const gateway = recorder(() => ({}))
    await assert.rejects(startStory({ cardId: CARD, backend, gateway, ...makeTimers() }), (error) => error.step === 'reserve', JSON.stringify(reservation))
    assert.deepEqual(gateway.calls, [])
  }
})

test('a long reason is cut to 300 characters', async () => {
  const { gateway } = working()
  const backend = recorder(() => new Error('x'.repeat(1000)))
  await assert.rejects(startStory({ cardId: CARD, backend, gateway, ...makeTimers() }), (error) => error.reason.length === 300)
})

test('a name or key with unusual characters is percent-encoded in the path', async () => {
  const backend = recorder((v, path) => (path === '/chats' ? { ...RESERVATION, name: 'a b/c' } : {}))
  const gateway = recorder((v, path) => (path === '/api/chat/slots' ? { key: 'k', messages: 0 } : {}))
  await startStory({ cardId: CARD, backend, gateway, ...makeTimers() })
  assert.equal(backend.calls[1][1], '/chats/a%20b%2Fc/started')
})

// ---- sendBrief ----

test('sendBrief ends when the request answers, when Crew accepted it, and at 10 seconds, and rejects with any other error', async () => {
  const timers = makeTimers()
  const gatewayOf = (answer) => ({ post: () => answer })
  assert.equal(await sendBrief({ gateway: gatewayOf(Promise.resolve({})), key: 'k', brief: 'b', ...timers }), undefined)
  assert.equal(await sendBrief({ gateway: gatewayOf(Promise.reject(new Error('Crew accepted the request'))), key: 'k', brief: 'b', ...timers }), undefined)
  await assert.rejects(sendBrief({ gateway: gatewayOf(Promise.reject(httpError(500, null))), key: 'k', brief: 'b', ...timers }), (error) => error.status === 500)
  const never = sendBrief({ gateway: gatewayOf(new Promise(() => {})), key: 'k', brief: 'b', ...timers })
  assert.equal((await settle(never, timers)).error, undefined)
  assert.equal(timers.pending(), 0)
})

test('sendBrief posts the key and the brief to /api/chat and a throwing post is a rejection', async () => {
  const calls = []
  await sendBrief({ gateway: { post: (...args) => { calls.push(args); return Promise.resolve({}) } }, key: 'k1', brief: 'the text', ...makeTimers() })
  assert.deepEqual(calls, [['/api/chat', { slot: 'k1', message: 'the text' }]])
  await assert.rejects(sendBrief({ gateway: { post: () => { throw new TypeError('no client') } }, key: 'k', brief: 'b', ...makeTimers() }), TypeError)
})

// ---- retryBrief ----

const rowOf = (key, messages) => ({ key, messages, running: false })

test('a retry sends the brief only when the chat\'s row says it holds no message', async () => {
  const timers = makeTimers()
  const log = []
  const gateway = recorder((v, path) => (path === '/api/chat/slots' ? [rowOf('other', 5), rowOf(KEY, 0)] : {}), log)
  const result = await retryBrief({ gateway, key: KEY, brief: 'THE BRIEF', ...timers })
  assert.deepEqual(result, { sent: true })
  assert.deepEqual(gateway.calls, [['get', '/api/chat/slots'], ['post', '/api/chat', { slot: KEY, message: 'THE BRIEF' }]])
})

test('a retry sends nothing when the chat holds a message, and the brief counts as sent', async () => {
  for (const messages of [1, 2, 40]) {
    const gateway = recorder((v, path) => (path === '/api/chat/slots' ? [rowOf(KEY, messages)] : {}))
    assert.deepEqual(await retryBrief({ gateway, key: KEY, brief: 'b', ...makeTimers() }), { sent: false })
    assert.deepEqual(gateway.calls.map(([verb]) => verb), ['get'])
  }
})

test('a retry sends nothing, and says why, when the list cannot be read, is not a list, has no row for the chat, or does not say how many messages it holds', async () => {
  const cases = [
    [() => httpError(500, null), /API 500/],
    [() => ({ not: 'a list' }), /could not be read/],
    [() => [rowOf('other', 0)], /does not have this chat open/],
    [() => [], /does not have this chat open/],
    [() => [{ key: KEY }], /did not say how many/],
    [() => [{ key: KEY, messages: '0' }], /did not say how many/],
  ]
  for (const [answer, reason] of cases) {
    const gateway = recorder((v, path) => (path === '/api/chat/slots' ? answer() : {}))
    await assert.rejects(retryBrief({ gateway, key: KEY, brief: 'b', ...makeTimers() }), (error) => error instanceof StartError && error.step === 'send' && reason.test(error.reason))
    assert.ok(!gateway.calls.some(([verb]) => verb === 'post'), 'nothing was sent')
  }
})

test('a retry whose send fails is a send failure, and one whose send never answers counts as sent after 10 seconds', async () => {
  const timers = makeTimers()
  let gateway = recorder((v, path) => (path === '/api/chat/slots' ? [rowOf(KEY, 0)] : httpError(500, null)))
  await assert.rejects(retryBrief({ gateway, key: KEY, brief: 'b', ...timers }), (error) => error.step === 'send' && error.reason === 'API 500')
  gateway = { get: async () => [rowOf(KEY, 0)], post: () => new Promise(() => {}) }
  const outcome = await settle(retryBrief({ gateway, key: KEY, brief: 'b', ...timers }), timers)
  assert.deepEqual(outcome.value, { sent: true })
})

// ---- resume and start again ----

test('resuming posts to the chat\'s resume route with no body', async () => {
  const gateway = recorder(() => ({ ok: true, messages: [] }))
  await resumeChat({ key: KEY, gateway })
  assert.deepEqual(gateway.calls, [['post', `/api/chat/slots/${KEY}/resume`]])
  assert.equal(gateway.calls[0].length, 2, 'no body argument')
  await resumeChat({ key: 'a b/c', gateway })
  assert.equal(gateway.calls[1][1], '/api/chat/slots/a%20b%2Fc/resume')
})

test('a refused or failed resume throws a StartError for the resume step with the reason', async () => {
  for (const [failure, reason] of [[httpError(404, { code: 'slot_not_found', message: 'No such chat.' }), 'No such chat.'], [new TypeError('Failed to fetch'), 'Failed to fetch']]) {
    const gateway = recorder(() => failure)
    await assert.rejects(resumeChat({ key: 'k', gateway }), (error) => error instanceof StartError && error.step === 'resume' && error.reason === reason)
  }
})

test('"Start again" removes only the board\'s record, by name, and calls nothing in Crew', async () => {
  const backend = recorder(() => ({ removed: true }))
  await startAgain({ name: KEY, backend })
  assert.deepEqual(backend.calls, [['del', `/chats/${KEY}`]])
  await assert.rejects(startAgain({ name: 'n', backend: recorder(() => httpError(404, { code: 'chat_not_found', message: 'There is no chat record with that name.' })) }),
    (error) => error.step === 'remove' && error.reason === 'There is no chat record with that name.' && error.code === 'chat_not_found')
})

// ---- Property 7 ----

// A world of one backend and one Crew. A call can fail before it takes effect, or take effect and then lose
// its answer. A send can answer at once, fail before Crew has it, fail after, say Crew accepted it, or never answer.
function world(r, failureRate) {
  const state = {
    records: new Map(), chats: new Map(), nextName: 0, messages: 0,
    sendWhileReserved: 0, sendWhileHoldingMessage: 0, savedNotStarted: 0, sends: [],
  }
  const fails = () => r.bool(failureRate)
  const answer = (effect) => {
    if (fails()) throw new TypeError('Failed to fetch')
    const value = effect()
    if (fails()) throw new TypeError('Failed to fetch')
    return value
  }
  const backend = {
    post: async (path, body) => answer(() => {
      if (path === '/chats') {
        const existing = state.records.get(body.card_id)
        if (existing?.state === 'started') throw httpError(409, { code: 'chat_exists', message: 'This story already has a chat.' })
        if (existing) return { card_id: body.card_id, name: existing.name, brief: 'BRIEF', folder_id: 'f' }
        state.nextName += 1
        const name = `epic-board-${state.nextName}`
        state.records.set(body.card_id, { name, state: 'reserved', key: null })
        return { card_id: body.card_id, name, brief: 'BRIEF', folder_id: 'f' }
      }
      const match = /^\/chats\/([^/]+)\/started$/.exec(path)
      const record = [...state.records.values()].find((candidate) => candidate.name === decodeURIComponent(match[1]))
      if (!record) throw httpError(404, { code: 'chat_not_found', message: 'x' })
      record.state = 'started'
      record.key = body.key
      return { ok: true }
    }),
  }
  const gateway = {
    get: async () => answer(() => (r.bool(0.1) ? [] : [...state.chats.values()].map((chat) => ({ key: chat.key, messages: chat.messages })))),
    post: async (path, body) => {
      if (path === '/api/chat/slots') {
        return answer(() => {
          if (!state.chats.has(body.name)) state.chats.set(body.name, { key: `key-${body.name}`, messages: 0 })
          const chat = state.chats.get(body.name)
          return { key: chat.key, messages: chat.messages }
        })
      }
      // POST /api/chat: the message lands in the chat, unless the request fails before Crew has it
      const mode = r.pick(['ok', 'ok', 'accepted', 'fail-before', 'fail-after', 'never'])
      state.sends.push(mode)
      if (mode === 'fail-before') throw new TypeError('Failed to fetch')
      const chat = [...state.chats.values()].find((candidate) => candidate.key === body.slot)
      const record = [...state.records.values()].find((candidate) => candidate.key === body.slot)
      if (!record || record.state !== 'started') state.sendWhileReserved += 1
      if (chat.messages > 0) state.sendWhileHoldingMessage += 1
      chat.messages += 1
      state.messages += 1
      if (mode === 'accepted') throw new Error('Crew accepted the request but the answer was not JSON')
      if (mode === 'fail-after') throw new TypeError('Failed to fetch')
      if (mode === 'never') return new Promise(() => {})
      return {}
    },
  }
  return { state, backend, gateway }
}

test('Property 7: a chat is saved before its brief is sent, and the brief is never sent twice', async () => {
  await forSeedsAsync('saved before sent, never sent twice', 300, async (r) => {
    const { state, backend, gateway } = world(r, r.pick([0, 0.15, 0.3, 0.5]))
    const timers = makeTimers()
    let saved = null
    let savedChecks = 0
    for (let attempt = 0; attempt < r.int(1, 10); attempt += 1) {
      const outcome = await settle(startStory({
        cardId: CARD, backend, gateway, ...timers,
        onSaved: (s) => {
          saved = s
          savedChecks += 1
          const record = state.records.get(CARD)
          assert.equal(record.state, 'started', 'the record is started when the chat is saved')
          assert.equal(record.key, s.key)
          assert.equal(state.messages, 0, 'nothing was sent before the chat was saved')
        },
      }), timers)
      if (outcome.error) {
        assert.ok(outcome.error instanceof StartError, `attempt ${attempt} threw ${outcome.error}`)
        if (outcome.error.saved) break // the chat is saved and only the send failed: retries below
        if (outcome.error.code === 'chat_exists') break // an earlier save's answer was lost: the card has its chat
        continue
      }
      break
    }
    // retries of a failed send, from a page that still holds the brief
    if (saved) {
      for (let retry = 0; retry < r.int(0, 6); retry += 1) {
        const outcome = await settle(retryBrief({ gateway, key: saved.key, brief: saved.brief, ...timers }), timers)
        if (outcome.error) assert.ok(outcome.error instanceof StartError)
        else if (outcome.value.sent === false) break
      }
    }
    assert.ok(state.chats.size <= 1, 'at most one chat exists for the card')
    assert.ok(state.records.size <= 1)
    assert.ok(state.messages <= 1, 'the brief is sent at most once')
    assert.equal(state.sendWhileReserved, 0, 'no brief is sent while the record is reserved')
    assert.equal(state.sendWhileHoldingMessage, 0, 'no brief is sent to a chat that holds a message')
    if (saved) {
      const record = state.records.get(CARD)
      assert.equal(record.state, 'started')
      assert.equal(record.key, saved.key)
      assert.equal(state.chats.size, 1)
      assert.ok(savedChecks >= 1)
    }
  })
})

test('Property 7 with no failures: one start gives one chat, one message and a started record, whatever the send does', async () => {
  await forSeedsAsync('no failures', 60, async (r) => {
    const { state, backend, gateway } = world(r, 0)
    const timers = makeTimers()
    const outcome = await settle(startStory({ cardId: CARD, backend, gateway, ...timers }), timers)
    if (outcome.error) {
      assert.equal(outcome.error.step, 'send', 'the only thing that can fail is the send')
      assert.deepEqual([outcome.error.saved.key, state.records.get(CARD).state], [state.records.get(CARD).key, 'started'])
    } else {
      assert.equal(outcome.value.key, state.records.get(CARD).key)
    }
    assert.deepEqual([state.chats.size, state.records.get(CARD).state], [1, 'started'])
    assert.ok(state.messages <= 1)
    const again = await settle(startStory({ cardId: CARD, backend, gateway, ...timers }), timers)
    assert.ok(again.error?.step === 'reserve' && again.error.code === 'chat_exists')
    assert.ok(state.messages <= 1 && state.chats.size === 1)
  })
})

test('Property 7: the saving never waits for the send', async () => {
  await forSeedsAsync('the saving never waits for the send', 40, async (r) => {
    const { state, backend, gateway } = world(r, 0)
    const send = gateway.post
    gateway.post = (path, body) => (path === '/api/chat' ? (state.messages += 0, new Promise(() => {})) : send(path, body))
    const timers = makeTimers()
    let savedAt = null
    const promise = startStory({ cardId: CARD, backend, gateway, ...timers, onSaved: () => { savedAt = timers.pending() } })
    await flush()
    await flush()
    assert.notEqual(savedAt, null, 'saved while the send was still open')
    assert.equal(state.records.get(CARD).state, 'started')
    const outcome = await settle(promise, timers)
    assert.equal(outcome.error, undefined)
  })
})

// ---- Worktree start flow: group 2 ----

const WORKTREE_PATH = '/home/alice/my-project--epic-board-3fa91c0e'
const WORKTREE_RESERVATION = { ...RESERVATION, worktree_path: WORKTREE_PATH }

test('worktree start: creates Worktree_Folder, uses subfolder id for slots, includes worktree_folder_id in started', async () => {
  const log = []
  const backend = recorder((verb, path) => (path === '/chats' ? WORKTREE_RESERVATION : {}), log, 'backend ')
  const gateway = recorder((verb, path) => {
    if (path === '/api/chat/folders') return { id: 'wf_sub1' }
    if (path === '/api/chat/slots') return { key: KEY }
    return {}
  }, log, 'crew ')
  const timers = makeTimers()
  await settle(startStory({ cardId: CARD, cardName: 'Filter by epic', backend, gateway, ...timers }), timers)
  assert.deepEqual(log.filter((l) => l.startsWith('crew ')), [
    'crew post /api/chat/folders',
    'crew post /api/chat/slots',
    'crew post /api/chat',
  ])
  assert.deepEqual(gateway.calls[0], ['post', '/api/chat/folders', { name: 'Filter by epic', project_dir: WORKTREE_PATH, parent_id: RESERVATION.folder_id }])
  assert.deepEqual(gateway.calls[1][2].folder_id, 'wf_sub1', 'slots call uses the subfolder id')
  const startedCall = backend.calls.find(([, path]) => path.endsWith('/started'))
  assert.deepEqual(startedCall[2], { key: KEY, worktree_folder_id: 'wf_sub1' })
})

test('worktree start: steps in order include "folder" between "reserve" and "create"', async () => {
  const backend = recorder((verb, path) => (path === '/chats' ? WORKTREE_RESERVATION : {}), [], 'backend ')
  const gateway = recorder((verb, path) => {
    if (path === '/api/chat/folders') return { id: 'wf_sub1' }
    if (path === '/api/chat/slots') return { key: KEY }
    return {}
  }, [], 'crew ')
  const timers = makeTimers()
  const steps = []
  await settle(startStory({ cardId: CARD, cardName: 'x', backend, gateway, onStep: (s) => steps.push(s), ...timers }), timers)
  assert.deepEqual(steps, ['reserve', 'folder', 'create', 'save', 'send'])
})

test('non-worktree start: reservation without worktree_path skips folder step', async () => {
  const { backend, gateway, log } = working()  // RESERVATION has no worktree_path
  const timers = makeTimers()
  const steps = []
  await settle(startStory({ cardId: CARD, cardName: 'x', backend, gateway, onStep: (s) => steps.push(s), ...timers }), timers)
  assert.deepEqual(steps, ['reserve', 'create', 'save', 'send'])
  assert.ok(!log.some((l) => l.includes('/api/chat/folders')), 'no folder call when no worktree_path')
  const startedCall = backend.calls.find(([, path]) => path.endsWith('/started'))
  assert.deepEqual(startedCall[2], { key: KEY }, 'started body has no worktree_folder_id')
})

test('worktree folder creation failure: calls worktree cleanup route and re-throws', async () => {
  const log = []
  const backend = recorder((verb, path) => (path === '/chats' ? WORKTREE_RESERVATION : {}), log, 'backend ')
  const folderError = Object.assign(new Error('Crew 503'), { status: 503 })
  const gateway = recorder((verb, path) => {
    if (path === '/api/chat/folders') throw folderError
    return {}
  }, log, 'crew ')
  const timers = makeTimers()
  const outcome = await settle(startStory({ cardId: CARD, cardName: 'x', backend, gateway, ...timers }), timers)
  assert.ok(outcome.error, 'start should fail')
  const cleanupCall = backend.calls.find(([verb, path]) => verb === 'del' && path.includes('/worktree'))
  assert.ok(cleanupCall, 'backend DELETE worktree route called')
  assert.ok(!log.some((l) => l.includes('/api/chat/slots')), 'slots not called after folder failure')
})

test('worktree folder creation: Crew answers without an id, cleanup called and start fails', async () => {
  const log = []
  const backend = recorder((verb, path) => (path === '/chats' ? WORKTREE_RESERVATION : {}), log, 'backend ')
  const gateway = recorder((verb, path) => {
    if (path === '/api/chat/folders') return {}  // no id field
    return {}
  }, log, 'crew ')
  const timers = makeTimers()
  const outcome = await settle(startStory({ cardId: CARD, cardName: 'x', backend, gateway, ...timers }), timers)
  assert.ok(outcome.error, 'start should fail when folder has no id')
  const cleanupCall = backend.calls.find(([verb, path]) => verb === 'del' && path.includes('/worktree'))
  assert.ok(cleanupCall, 'backend DELETE worktree route called after bad folder response')
})
