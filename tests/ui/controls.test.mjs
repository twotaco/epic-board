// The page's own controls state (uiReduce), the backend client (makeBackend), and the records-first read.
// Validates: Requirements 2.2, 2.3, 4.6, 6.9, 8.4, 8.5
import test from 'node:test'
import assert from 'node:assert/strict'
import { chatsReduce, initialChats, initialUi, makeBackend, readChats, uiReduce } from '../../ui/index.mjs'

const A = 'e.md#A'
const B = 'e.md#B'

// ---- uiReduce ----

test('the question is open on one card at a time', () => {
  let state = uiReduce(initialUi, { kind: 'ask', cardId: A })
  assert.equal(state.asking, A)
  state = uiReduce(state, { kind: 'ask', cardId: B })
  assert.equal(state.asking, B)
})

test('cancel closes the question there, asks for focus on that card, and forgets a failed start only', () => {
  let state = uiReduce(initialUi, { kind: 'ask', cardId: A })
  state = uiReduce(state, { kind: 'failed', cardId: A, step: 'send', reason: 'x' })
  assert.equal(state.flows[A].kind, 'failed')
  const cancelled = uiReduce(state, { kind: 'cancel', cardId: A })
  assert.equal(cancelled.asking, null)
  assert.deepEqual(cancelled.flows, {})
  assert.deepEqual(cancelled.focus, { cardId: A })
  assert.notEqual(uiReduce(cancelled, { kind: 'cancel', cardId: A }).focus, cancelled.focus, 'each cancel is a new request for focus')
  // a cancel on another card leaves this question open
  const other = uiReduce(uiReduce(initialUi, { kind: 'ask', cardId: A }), { kind: 'cancel', cardId: B })
  assert.equal(other.asking, A)
  // a start that is running is not forgotten by a cancel
  const running = uiReduce(uiReduce(initialUi, { kind: 'step', cardId: A, step: 'create' }), { kind: 'cancel', cardId: A })
  assert.deepEqual(running.flows[A], { kind: 'starting', step: 'create' })
})

test('a start goes step by step, fails with the question open, and ends by closing it', () => {
  let state = uiReduce(initialUi, { kind: 'ask', cardId: A })
  state = uiReduce(state, { kind: 'step', cardId: A, step: 'reserve' })
  assert.deepEqual(state.flows[A], { kind: 'starting', step: 'reserve' })
  state = uiReduce(state, { kind: 'step', cardId: A, step: 'send' })
  assert.deepEqual(state.flows[A], { kind: 'starting', step: 'send' })
  const failed = uiReduce(state, { kind: 'failed', cardId: A, step: 'send', reason: 'boom' })
  assert.deepEqual([failed.asking, failed.flows[A]], [A, { kind: 'failed', step: 'send', reason: 'boom' }])
  const done = uiReduce(state, { kind: 'started', cardId: A })
  assert.deepEqual([done.asking, done.flows], [null, {}])
  // finishing a start leaves a question open on another card alone
  const elsewhere = uiReduce(uiReduce(initialUi, { kind: 'ask', cardId: B }), { kind: 'started', cardId: A })
  assert.equal(elsewhere.asking, B)
})

test('a resume is resuming, then failed with its reason, then forgotten', () => {
  let state = uiReduce(initialUi, { kind: 'resuming', key: 'k1' })
  assert.deepEqual(state.resumes.k1, { kind: 'resuming' })
  state = uiReduce(state, { kind: 'resume-failed', key: 'k1', reason: 'gone' })
  assert.deepEqual(state.resumes.k1, { kind: 'failed', reason: 'gone' })
  state = uiReduce(state, { kind: 'resumed', key: 'k1' })
  assert.deepEqual(state.resumes, {})
})

test('the brief of a started chat is sending, then failed with its reason, then forgotten, and only for its own chat', () => {
  let state = uiReduce(initialUi, { kind: 'brief-sending', key: 'k1' })
  assert.deepEqual(state.briefs.k1, { kind: 'sending' })
  state = uiReduce(state, { kind: 'brief-failed', key: 'k1', reason: 'boom' })
  assert.deepEqual(state.briefs.k1, { kind: 'failed', reason: 'boom' })
  state = uiReduce(state, { kind: 'brief-sending', key: 'k2' })
  assert.deepEqual(Object.keys(state.briefs).sort(), ['k1', 'k2'])
  state = uiReduce(state, { kind: 'brief-sent', key: 'k1' })
  assert.deepEqual(Object.keys(state.briefs), ['k2'])
  assert.deepEqual(initialUi.briefs, {})
})

test('a start that saves the chat clears the question and keeps the brief note', () => {
  let state = uiReduce(initialUi, { kind: 'ask', cardId: A })
  state = uiReduce(state, { kind: 'step', cardId: A, step: 'save' })
  state = uiReduce(state, { kind: 'started', cardId: A })
  state = uiReduce(state, { kind: 'brief-sending', key: 'k1' })
  assert.deepEqual([state.asking, state.flows, state.briefs.k1], [null, {}, { kind: 'sending' }])
})

test('uiReduce never changes a state in place, and an unknown action changes nothing', () => {
  const before = uiReduce(uiReduce(initialUi, { kind: 'ask', cardId: A }), { kind: 'step', cardId: A, step: 'create' })
  const snapshot = JSON.stringify(before)
  for (const action of [{ kind: 'ask', cardId: B }, { kind: 'cancel', cardId: A }, { kind: 'failed', cardId: A, step: 'x', reason: 'y' },
    { kind: 'started', cardId: A }, { kind: 'resuming', key: 'k' }, { kind: 'resumed', key: 'k' },
    { kind: 'brief-sending', key: 'k' }, { kind: 'brief-failed', key: 'k', reason: 'r' }, { kind: 'brief-sent', key: 'k' }]) {
    uiReduce(before, action)
  }
  assert.equal(JSON.stringify(before), snapshot)
  assert.equal(uiReduce(before, { kind: 'nothing' }), before)
  assert.equal(uiReduce(before, undefined), before)
  assert.ok(Object.isFrozen(initialUi))
})

// ---- makeBackend ----

function fakeFetch(answer) {
  const calls = []
  const fetchFn = async (url, options) => {
    calls.push([url, options])
    return answer
  }
  fetchFn.calls = calls
  return fetchFn
}
const response = (status, body, { jsonFails = false } = {}) => ({
  status, ok: status >= 200 && status < 300,
  json: async () => { if (jsonFails) throw new SyntaxError('not json'); return body },
})

test('the backend client sends the paths under the app route, signed in the host, with a JSON body only when it has one', async () => {
  const fetchFn = fakeFetch(response(200, { ok: true }))
  const backend = makeBackend(fetchFn)
  const controller = new AbortController()
  assert.deepEqual(await backend.get('/chats', { signal: controller.signal }), { ok: true })
  await backend.post('/chats', { card_id: A })
  await backend.post('/chats/n/started', { key: 'k' })
  await backend.del('/chats/n')
  assert.deepEqual(fetchFn.calls.map(([url]) => url), [
    '/apps/epic-board/api/chats', '/apps/epic-board/api/chats', '/apps/epic-board/api/chats/n/started', '/apps/epic-board/api/chats/n',
  ])
  assert.deepEqual(fetchFn.calls.map(([, options]) => options.method), ['GET', 'POST', 'POST', 'DELETE'])
  for (const [, options] of fetchFn.calls) {
    assert.equal(options.credentials, 'same-origin')
    assert.equal(options.cache, 'no-store')
  }
  assert.equal(fetchFn.calls[0][1].signal, controller.signal)
  assert.equal(fetchFn.calls[0][1].body, undefined)
  assert.equal(fetchFn.calls[0][1].headers, undefined)
  assert.equal(fetchFn.calls[3][1].body, undefined)
  assert.deepEqual(fetchFn.calls[1][1].headers, { 'Content-Type': 'application/json' })
  assert.deepEqual(JSON.parse(fetchFn.calls[1][1].body), { card_id: A })
  // no credential, token or session header is sent by the page itself
  for (const [, options] of fetchFn.calls) assert.ok(!JSON.stringify(options.headers ?? {}).match(/token|authorization|cookie|proxy/i))
})

test('a non-2xx answer rejects with the status and the backend\'s error', async () => {
  const backend = makeBackend(fakeFetch(response(409, { error: { code: 'card_done', message: 'That story is done.' } })))
  await assert.rejects(backend.post('/chats', { card_id: A }), (error) => {
    assert.equal(error.status, 409)
    assert.deepEqual(error.error, { code: 'card_done', message: 'That story is done.' })
    return true
  })
  const noBody = makeBackend(fakeFetch(response(502, null, { jsonFails: true })))
  await assert.rejects(noBody.get('/chats'), (error) => error.status === 502 && error.error === null)
})

test('a connection failure rejects as it is, and an answer that is not JSON on a 2xx resolves to null', async () => {
  const failing = makeBackend(async () => { throw new TypeError('Failed to fetch') })
  await assert.rejects(failing.get('/chats'), TypeError)
  const empty = makeBackend(fakeFetch(response(200, null, { jsonFails: true })))
  assert.equal(await empty.del('/chats/n'), null)
})

// ---- the records come first ----

test('readChats reports the records as soon as the backend answers, before it asks Crew anything', async () => {
  const order = []
  const backend = { get: async () => { order.push('backend'); return { folder_id: 'f_1', folder_reason: null, chats: [{ card_id: A, name: 'n', key: 'k', created: 't' }] } } }
  const gateway = { get: async (path) => { order.push(path); if (path === '/api/chat/slots') return [{ key: 'k', running: true }]; throw new Error('no') } }
  const seen = []
  await readChats({ backend, gateway, now: () => 5, onRecords: (records) => { order.push('records'); seen.push(records) } })
  assert.deepEqual(order, ['backend', 'records', '/api/chat/slots'])
  assert.deepEqual(seen[0].chats.map((record) => record.key), ['k'])
  assert.deepEqual(seen[0].folder, { id: 'f_1', reason: null })
})

test('the records are reported even when the read of Crew then fails, and for an unreadable file', async () => {
  const records = []
  const backend = { get: async () => ({ folder_id: 'f_1', chats: [{ card_id: A, name: 'n', key: 'k', created: 't' }] }) }
  await assert.rejects(readChats({ backend, gateway: { get: async () => { throw new Error('down') } }, now: () => 1, onRecords: (r) => records.push(r) }), /down/)
  assert.equal(records.length, 1)
  const unreadable = { get: async () => { throw Object.assign(new Error('x'), { status: 500, error: { code: 'chats_unreadable', message: 'bad file' } }) } }
  await readChats({ backend: unreadable, gateway: {}, now: () => 1, onRecords: (r) => records.push(r) })
  assert.deepEqual(records[1].recordsError, { code: 'chats_unreadable', message: 'bad file' })
})

test('the records result puts the chats on the board and keeps the marks of chats that are still there', () => {
  const start = chatsReduce(initialChats, { kind: 'chats', read: {
    at: 100, folder: { id: 'f', reason: null }, recordsError: null,
    chats: [{ card_id: A, name: 'n1', key: 'k1', created: 't' }, { card_id: B, name: 'n2', key: 'k2', created: 't' }],
    byKey: { k1: { state: 'working' }, k2: { state: 'missing' } }, missingSince: { k2: 50 },
  } })
  const next = chatsReduce(start, { kind: 'records', chats: [{ card_id: A, name: 'n1', key: 'k1', created: 't' }], folder: { id: 'f', reason: null }, recordsError: null })
  assert.deepEqual(next.records.map((record) => record.key), ['k1'])
  assert.deepEqual(next.byKey, { k1: { state: 'working' } }, 'a removed chat\'s read is dropped, the other is kept')
  assert.deepEqual(next.missingSince, {})
  assert.equal(next.at, 100)
  assert.equal(next.loaded, true)
  assert.equal(next.failed, start.failed, 'a records result is not a good read: it neither sets nor clears the failed flag')
  const failed = chatsReduce(start, { kind: 'failure' })
  assert.equal(chatsReduce(failed, { kind: 'records', chats: [], folder: { id: 'f', reason: null } }).failed, true)
})

test('an unreadable file clears the records and shows its error', () => {
  const state = chatsReduce(initialChats, { kind: 'records', chats: [], folder: { id: null, reason: null }, recordsError: { code: 'chats_unreadable', message: 'bad' } })
  assert.deepEqual([state.records, state.recordsError.message, state.loaded], [[], 'bad', true])
})

test('the page starts with no chat open, and no other action touches it', () => {
  assert.equal(initialUi.open, null)
  let state = uiReduce(initialUi, { kind: 'open-chat', cardId: A, key: 'k1' })
  for (const action of [{ kind: 'ask', cardId: B }, { kind: 'cancel', cardId: B }, { kind: 'step', cardId: B, step: 's' },
    { kind: 'started', cardId: B }, { kind: 'resuming', key: 'k2' }, { kind: 'brief-sent', key: 'k2' }]) {
    state = uiReduce(state, action)
  }
  assert.deepEqual(state.open, { cardId: A, key: 'k1' })
})
