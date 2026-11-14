// The chat logic of the page: states, the chat read, the chats reducer and the card views.
// Property 1: One state, by precedence.            Validates: Requirements 6.2
// Property 2: Only our own keys count.             Validates: Requirements 6.1
// Property 6: The restoring clock.                 Validates: Requirements 8.2, 8.3
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RESTORE_MS, STATE_WORDS, cardViewOf, chatDelay, chatHref, chatsReduce, classifyChats, initialChats,
  readChats, stateOf,
} from '../../ui/index.mjs'
import { forSeeds, forSeedsAsync } from './support.mjs'

// ---- Fakes ----

const httpError = (status, error) => Object.assign(new Error(`API ${status}`), { status, error })

// The app's own backend. `answer` is what GET /chats gives, or an Error to reject with.
function fakeBackend(answer) {
  const backend = { calls: [], get: async (path, init) => { backend.calls.push(`GET ${path}`); backend.signal = init?.signal; if (answer instanceof Error) throw answer; return answer } }
  return backend
}

// Crew. `rows` is the chat list, `details` maps a key to a slot detail, or to an Error to reject with.
// A key with no detail is a 404, as Crew answers for a chat it does not have open.
function fakeGateway({ rows = [], details = {}, listError = null } = {}) {
  const gateway = {
    calls: [],
    get: async (path) => {
      gateway.calls.push(path)
      if (path === '/api/chat/slots') {
        if (listError) throw listError
        return rows
      }
      const match = /^\/api\/chat\/slots\/([^?]+)\?limit=1$/.exec(path)
      assert.ok(match, `unexpected request ${path}`)
      const detail = details[decodeURIComponent(match[1])]
      if (detail instanceof Error) throw detail
      if (detail === undefined) throw httpError(404, null)
      return detail
    },
    details() { return gateway.calls.filter((path) => path !== '/api/chat/slots') },
  }
  return gateway
}

const record = (cardId, key) => ({ card_id: cardId, name: key, key, created: 't' })
const backendAnswer = (chats, extra = {}) => ({ folder_id: 'f_1', folder_reason: null, chats, ...extra })
const row = (key, extra = {}) => ({ key, running: false, pending_approval: false, needs_input: false, interrupted: false, last_ts: 't1', messages: 3, ...extra })
const detailWith = (...roles) => ({ messages: roles.map((role) => ({ role })) })
const read = (deps) => readChats({ now: () => 1000, ...deps })

// ---- stateOf ----

test('each flag on its own gives its state, and an idle row gives Idle', () => {
  assert.equal(stateOf(row('k', { pending_approval: true })), 'needs-you')
  assert.equal(stateOf(row('k', { needs_input: true })), 'needs-you')
  assert.equal(stateOf(row('k', { running: true })), 'working')
  assert.equal(stateOf(row('k', { admission_queued: true })), 'working')
  assert.equal(stateOf(row('k', { interrupted: true })), 'interrupted')
  assert.equal(stateOf(row('k'), 'error'), 'interrupted')
  assert.equal(stateOf(row('k')), 'idle')
  assert.equal(stateOf(row('k'), 'assistant'), 'idle')
  assert.equal(stateOf(row('k'), null), 'idle')
})

test('flags in pairs: Needs you beats Working, and Working beats Interrupted', () => {
  assert.equal(stateOf(row('k', { running: true, pending_approval: true })), 'needs-you')
  assert.equal(stateOf(row('k', { running: true, needs_input: true })), 'needs-you')
  assert.equal(stateOf(row('k', { admission_queued: true, needs_input: true })), 'needs-you')
  assert.equal(stateOf(row('k', { running: true, interrupted: true })), 'working')
  assert.equal(stateOf(row('k', { pending_approval: true, interrupted: true }), 'error'), 'needs-you')
  assert.equal(stateOf(row('k', { interrupted: true }), 'error'), 'interrupted')
})

test('missing fields count as false, and only true counts as true', () => {
  assert.equal(stateOf({}), 'idle')
  assert.equal(stateOf(null), 'idle')
  assert.equal(stateOf({ running: 'yes', pending_approval: 1, needs_input: 'true', interrupted: 1 }), 'idle')
})

test('the state words are the four of the spec', () => {
  assert.deepEqual(STATE_WORDS, { 'needs-you': 'Needs you', working: 'Working', interrupted: 'Interrupted', idle: 'Idle' })
  assert.ok(Object.isFrozen(STATE_WORDS))
})

test('Property 1: one state, by precedence', () => {
  const flag = (r) => r.pick([undefined, false, false, true])
  const roles = ['error', 'assistant', 'user', 'inject', '', null, undefined]
  forSeeds('one state, by precedence', 400, (r) => {
    const candidate = { pending_approval: flag(r), needs_input: flag(r), running: flag(r), admission_queued: flag(r), interrupted: flag(r) }
    const lastRole = r.pick(roles)
    const expected = candidate.pending_approval === true || candidate.needs_input === true ? 'needs-you'
      : candidate.running === true || candidate.admission_queued === true ? 'working'
        : candidate.interrupted === true || lastRole === 'error' ? 'interrupted' : 'idle'
    const got = stateOf(candidate, lastRole)
    assert.ok(Object.keys(STATE_WORDS).includes(got))
    assert.equal(got, expected)
  })
})

// ---- chatHref, classifyChats, chatDelay ----

test('chatHref encodes only the key and carries nothing else', () => {
  assert.equal(chatHref('epic-board-3fa91c0e'), '/chat?sid=epic-board-3fa91c0e')
  assert.equal(chatHref('a/b?c#d e'), '/chat?sid=a%2Fb%3Fc%23d%20e')
  assert.equal(chatHref('é日'), '/chat?sid=%C3%A9%E6%97%A5')
  assert.equal(chatHref('a&token=x'), '/chat?sid=a%26token%3Dx')
  assert.doesNotMatch(chatHref('k'), /token|&/)
})

test('classifyChats reads a good answer and calls everything else a failure', () => {
  const body = { chats: [], byKey: {}, at: 1 }
  assert.deepEqual(classifyChats(200, body), { kind: 'chats', read: body })
  for (const bad of [[500, body], [200, null], [200, 'x'], [200, {}], [200, { chats: [] }], [200, { byKey: {} }], [200, [1]], [404, body]]) {
    assert.deepEqual(classifyChats(...bad), { kind: 'failure' }, JSON.stringify(bad))
  }
})

test('chatDelay: 5000 while a chat works, needs the person or is restoring, 15000 otherwise and after a failure', () => {
  const at = 100000
  const make = (byKey, missingSince = {}) => ({ kind: 'chats', read: { at, byKey, missingSince, chats: [] } })
  assert.equal(chatDelay(make({})), 15000)
  assert.equal(chatDelay(make({ a: { state: 'idle' }, b: { state: 'interrupted' } })), 15000)
  assert.equal(chatDelay(make({ a: { state: 'idle' }, b: { state: 'working' } })), 5000)
  assert.equal(chatDelay(make({ a: { state: 'needs-you' } })), 5000)
  assert.equal(chatDelay(make({ a: { state: 'missing' } }, { a: at - 59999 })), 5000)
  assert.equal(chatDelay(make({ a: { state: 'missing' } }, { a: at - RESTORE_MS })), 15000)
  assert.equal(chatDelay({ kind: 'failure' }), 15000)
  assert.equal(chatDelay(undefined), 15000)
})

// ---- readChats ----

test('no started chats: one request to the backend and none to Crew', async () => {
  const backend = fakeBackend(backendAnswer([]))
  const gateway = fakeGateway()
  const result = await read({ backend, gateway })
  assert.deepEqual(backend.calls, ['GET /chats'])
  assert.deepEqual(gateway.calls, [])
  assert.deepEqual(result, { at: 1000, folder: { id: 'f_1', reason: null }, recordsError: null, chats: [], byKey: {}, missingSince: {} })
})

test('the folder and its reason come from the backend, and a missing folder is null', async () => {
  const result = await read({ backend: fakeBackend({ folder_id: null, folder_reason: 'folder_id must be text.', chats: [] }), gateway: fakeGateway() })
  assert.deepEqual(result.folder, { id: null, reason: 'folder_id must be text.' })
})

test('an unreadable file of chats ends the read with no request to Crew', async () => {
  const backend = fakeBackend(httpError(500, { code: 'chats_unreadable', message: '/x/chats.json cannot be read.' }))
  const gateway = fakeGateway()
  const result = await read({ backend, gateway })
  assert.deepEqual(result.recordsError, { code: 'chats_unreadable', message: '/x/chats.json cannot be read.' })
  assert.deepEqual([result.chats, result.byKey], [[], {}])
  assert.deepEqual(gateway.calls, [])
})

test('any other backend failure rejects the read', async () => {
  for (const failure of [httpError(503, { code: 'proxy_secret_missing', message: 'x' }), httpError(401, { code: 'unauthorized' }), new TypeError('Failed to fetch')]) {
    await assert.rejects(read({ backend: fakeBackend(failure), gateway: fakeGateway() }), failure)
  }
})

test('the states of our chats, from the list, with other chats ignored', async () => {
  const chats = [record('c1', 'k-working'), record('c2', 'k-needs'), record('c3', 'k-interrupted'), record('c4', 'k-idle'), record('c5', 'k-error')]
  const gateway = fakeGateway({
    rows: [
      row('k-working', { running: true }), row('k-needs', { running: true, pending_approval: true }), row('k-interrupted', { interrupted: true }),
      row('k-idle'), row('k-error', { last_ts: 't9' }),
      row('someone-elses', { running: true, pending_approval: true }),
    ],
    details: { 'k-idle': detailWith('user', 'assistant'), 'k-error': detailWith('assistant', 'error') },
  })
  const result = await read({ backend: fakeBackend(backendAnswer(chats)), gateway })
  assert.deepEqual(Object.fromEntries(Object.entries(result.byKey).map(([key, entry]) => [key, entry.state])), {
    'k-working': 'working', 'k-needs': 'needs-you', 'k-interrupted': 'interrupted', 'k-idle': 'idle', 'k-error': 'interrupted',
  })
  assert.deepEqual(gateway.calls, ['/api/chat/slots', '/api/chat/slots/k-idle?limit=1', '/api/chat/slots/k-error?limit=1'])
  assert.equal(result.byKey['someone-elses'], undefined)
})

test('the last row is read only for a chat that is not Needs you, Working or interrupted', async () => {
  const gateway = fakeGateway({
    rows: [row('a', { pending_approval: true }), row('b', { running: true }), row('c', { needs_input: true }), row('d', { admission_queued: true }), row('e', { interrupted: true })],
  })
  const chats = ['a', 'b', 'c', 'd', 'e'].map((key, i) => record(`c${i}`, key))
  await read({ backend: fakeBackend(backendAnswer(chats)), gateway })
  assert.deepEqual(gateway.details(), [])
})

test('the earlier answer is reused while last_ts and messages are unchanged, and read again when either changes', async () => {
  const chats = [record('c1', 'k')]
  const backend = fakeBackend(backendAnswer(chats))
  const details = { k: detailWith('assistant') }
  let gateway = fakeGateway({ rows: [row('k')], details })
  const first = await read({ backend, gateway })
  assert.equal(gateway.details().length, 1)
  assert.equal(first.byKey.k.roleRead, true)

  gateway = fakeGateway({ rows: [row('k')], details })
  const second = await read({ backend, gateway, previous: { ...initialChats, byKey: first.byKey } })
  assert.deepEqual(gateway.details(), [], 'same last_ts and messages: no read')
  assert.equal(second.byKey.k.state, 'idle')

  gateway = fakeGateway({ rows: [row('k', { last_ts: 't2' })], details: { k: detailWith('assistant', 'error') } })
  const third = await read({ backend, gateway, previous: { ...initialChats, byKey: second.byKey } })
  assert.equal(gateway.details().length, 1, 'last_ts changed: read')
  assert.equal(third.byKey.k.state, 'interrupted')

  gateway = fakeGateway({ rows: [row('k', { last_ts: 't2', messages: 4 })], details })
  const fourth = await read({ backend, gateway, previous: { ...initialChats, byKey: third.byKey } })
  assert.equal(gateway.details().length, 1, 'messages changed: read')
  assert.equal(fourth.byKey.k.state, 'idle')
})

test('a cached last row of error keeps the chat Interrupted without a request', async () => {
  const chats = [record('c1', 'k')]
  const previous = { ...initialChats, byKey: { k: { state: 'interrupted', lastTs: 't1', messages: 3, role: 'error', roleRead: true } } }
  const gateway = fakeGateway({ rows: [row('k')] })
  const result = await read({ backend: fakeBackend(backendAnswer(chats)), gateway, previous })
  assert.equal(result.byKey.k.state, 'interrupted')
  assert.deepEqual(gateway.details(), [])
})

test('a chat that is not in the list is read on its own: a 404 is missing, with the time it was first missing', async () => {
  const chats = [record('c1', 'k')]
  const backend = fakeBackend(backendAnswer(chats))
  let gateway = fakeGateway({ rows: [] })
  const first = await readChats({ backend, gateway, now: () => 5000 })
  assert.deepEqual(first.byKey.k, { state: 'missing' })
  assert.deepEqual(first.missingSince, { k: 5000 })
  assert.deepEqual(gateway.calls, ['/api/chat/slots', '/api/chat/slots/k?limit=1'])

  const second = await readChats({ backend, gateway: fakeGateway({ rows: [] }), now: () => 9000, previous: { ...initialChats, missingSince: first.missingSince } })
  assert.deepEqual(second.missingSince, { k: 5000 }, 'the run keeps its start')

  const present = await readChats({ backend, gateway: fakeGateway({ rows: [row('k')], details: { k: detailWith('assistant') } }), now: () => 12000, previous: { ...initialChats, missingSince: second.missingSince } })
  assert.deepEqual(present.missingSince, {}, 'a read that finds it present ends the run')
})

test('a chat absent from the list but answered by its detail takes the state of Requirement 8.1', async () => {
  const chats = [record('c1', 'a'), record('c2', 'b'), record('c3', 'c'), record('c4', 'd')]
  const gateway = fakeGateway({
    rows: [],
    details: { a: { running: true, messages: [] }, b: { admission_queued: true, ...detailWith('assistant') }, c: detailWith('user', 'error'), d: detailWith('assistant') },
  })
  const result = await read({ backend: fakeBackend(backendAnswer(chats)), gateway })
  assert.deepEqual(Object.fromEntries(Object.entries(result.byKey).map(([key, entry]) => [key, entry.state])), { a: 'working', b: 'working', c: 'interrupted', d: 'idle' })
  assert.deepEqual(result.missingSince, {})
})

test('a detail answer with no rows is Idle', async () => {
  const result = await read({ backend: fakeBackend(backendAnswer([record('c1', 'k')])), gateway: fakeGateway({ rows: [row('k')], details: { k: { messages: [] } } }) })
  assert.equal(result.byKey.k.state, 'idle')
  assert.equal(result.byKey.k.role, null)
})

test('a list that is not a list, a failing list, and a detail that fails other than by 404 reject the read', async () => {
  const chats = [record('c1', 'k')]
  const backend = fakeBackend(backendAnswer(chats))
  await assert.rejects(read({ backend, gateway: fakeGateway({ rows: { not: 'a list' } }) }), /not a list/)
  await assert.rejects(read({ backend, gateway: fakeGateway({ listError: httpError(500, null) }) }), (error) => error.status === 500)
  await assert.rejects(read({ backend, gateway: fakeGateway({ rows: [row('k')], details: { k: httpError(500, null) } }) }), (error) => error.status === 500)
  await assert.rejects(read({ backend, gateway: fakeGateway({ rows: [], details: { k: httpError(403, null) } }) }), (error) => error.status === 403)
  await assert.rejects(read({ backend, gateway: fakeGateway({ rows: [], details: { k: new TypeError('Failed to fetch') } }) }), TypeError)
})

test('a detail that answers 404 for a chat that was in the list makes it missing, not a failure', async () => {
  const result = await read({ backend: fakeBackend(backendAnswer([record('c1', 'k')])), gateway: fakeGateway({ rows: [row('k')] }) })
  assert.equal(result.byKey.k.state, 'missing')
})

test('the signal reaches the backend and a key in a path is percent-encoded', async () => {
  const backend = fakeBackend(backendAnswer([record('c1', 'a b/c')]))
  const gateway = fakeGateway({ rows: [], details: { 'a b/c': detailWith('assistant') } })
  const controller = new AbortController()
  await read({ backend, gateway, signal: controller.signal })
  assert.equal(backend.signal, controller.signal)
  assert.ok(gateway.calls.includes('/api/chat/slots/a%20b%2Fc?limit=1'))
})

test('Property 2: only our own keys count', async () => {
  await forSeedsAsync('only our own keys count', 150, async (r) => {
    const ours = Array.from({ length: r.int(1, 5) }, (_, i) => `ours-${i}`)
    const foreign = Array.from({ length: r.int(0, 6) }, (_, i) => `theirs-${i}`)
    const flags = () => ({
      running: r.bool(0.3), pending_approval: r.bool(0.2), needs_input: r.bool(0.1), interrupted: r.bool(0.2),
      last_ts: `t${r.int(1, 3)}`, messages: r.int(0, 5),
    })
    const present = ours.filter(() => r.bool(0.7))
    const details = Object.fromEntries(ours.map((key) => [key, r.bool(0.7) ? detailWith(r.pick(['assistant', 'error'])) : undefined]).filter(([, d]) => d !== undefined))
    const chats = ours.map((key, i) => record(`c${i}`, key))
    const backend = fakeBackend(backendAnswer(chats))
    const ourRows = present.map((key) => row(key, flags()))
    const withForeign = (extra) => [...ourRows, ...extra.map((key) => row(key, flags()))]

    const plain = fakeGateway({ rows: ourRows, details })
    const base = await read({ backend, gateway: plain })
    const noisy = fakeGateway({ rows: withForeign(foreign), details })
    const withOthers = await read({ backend, gateway: noisy })

    assert.deepEqual(Object.keys(base.byKey).sort(), [...ours].sort())
    assert.deepEqual(withOthers.byKey, base.byKey, 'rows of other chats change nothing')
    assert.deepEqual(withOthers.missingSince, base.missingSince)
    for (const path of noisy.calls) assert.ok(!path.includes('theirs-'), `a request about another chat: ${path}`)
  })
})

// ---- chatsReduce ----

const goodRead = (extra = {}) => ({
  at: 1000, folder: { id: 'f', reason: null }, recordsError: null, chats: [record('c1', 'k1')],
  byKey: { k1: { state: 'working' } }, missingSince: {}, ...extra,
})

test('a good read replaces everything and clears the failed flag; a failed read keeps what is shown', () => {
  let state = chatsReduce(initialChats, { kind: 'chats', read: goodRead() })
  assert.deepEqual([state.loaded, state.failed, state.at, state.records.length], [true, false, 1000, 1])
  const failed = chatsReduce(state, { kind: 'failure' })
  assert.equal(failed.failed, true)
  assert.deepEqual([failed.records, failed.byKey, failed.at], [state.records, state.byKey, state.at])
  state = chatsReduce(failed, { kind: 'chats', read: goodRead({ at: 2000, byKey: { k1: { state: 'idle' } } }) })
  assert.deepEqual([state.failed, state.byKey.k1.state, state.at], [false, 'idle', 2000])
})

test('a failure before any read leaves the state empty and not loaded', () => {
  const state = chatsReduce(initialChats, { kind: 'failure' })
  assert.deepEqual([state.records, state.loaded, state.failed], [[], false, true])
})

test('started adds the chat at once and replaces an older record of the same card; removed drops it and its marks', () => {
  let state = chatsReduce(initialChats, { kind: 'started', record: { card_id: 'c1', name: 'n1', key: 'k1' } })
  assert.deepEqual(state.records, [{ card_id: 'c1', name: 'n1', key: 'k1', created: null }])
  state = chatsReduce(state, { kind: 'started', record: { card_id: 'c1', name: 'n2', key: 'k2' } })
  assert.deepEqual(state.records.map((r) => r.key), ['k2'])
  state = chatsReduce({ ...state, byKey: { k2: { state: 'missing' } }, missingSince: { k2: 5 } }, { kind: 'removed', name: 'n2' })
  assert.deepEqual([state.records, state.byKey, state.missingSince], [[], {}, {}])
  assert.equal(chatsReduce(state, { kind: 'removed', name: 'nobody' }), state)
  assert.equal(chatsReduce(state, { kind: 'whatever' }), state)
})

test('the state is never changed in place', () => {
  const before = chatsReduce(initialChats, { kind: 'chats', read: goodRead() })
  const snapshot = JSON.stringify(before)
  chatsReduce(before, { kind: 'failure' })
  chatsReduce(before, { kind: 'started', record: { card_id: 'c2', name: 'n', key: 'k' } })
  chatsReduce(before, { kind: 'removed', name: 'k1' })
  assert.equal(JSON.stringify(before), snapshot)
})

// ---- cardViewOf ----

const card = (extra = {}) => ({ id: 'e.md#A', name: 'A', status: 'planned', spec: null, tasks: null, epic: 'E', description: '', ...extra })
const chatsWith = (overrides = {}) => ({ ...initialChats, folder: { id: 'f_1', reason: null }, loaded: true, at: 100000, ...overrides })
const started = (key = 'k1') => [record('e.md#A', key)]

test('a Planned or In progress card with no chat is startable, and a Done card with no chat is plain', () => {
  assert.deepEqual(cardViewOf(card(), chatsWith(), {}), { mode: 'startable' })
  assert.deepEqual(cardViewOf(card({ status: 'in progress' }), chatsWith(), {}), { mode: 'startable' })
  assert.deepEqual(cardViewOf(card({ status: 'done' }), chatsWith(), {}), { mode: 'plain' })
  assert.deepEqual(cardViewOf(card({ status: 'done' }), chatsWith(), { asking: 'e.md#A' }), { mode: 'plain' })
})

test('the question opens on the card that was asked, and only there', () => {
  assert.deepEqual(cardViewOf(card(), chatsWith(), { asking: 'e.md#A' }), { mode: 'question', failure: null })
  assert.deepEqual(cardViewOf(card(), chatsWith(), { asking: 'e.md#Other' }), { mode: 'startable' })
})

test('a start in progress shows Starting with its step, and a failed start shows the question again with the failure', () => {
  const flows = { 'e.md#A': { kind: 'starting', step: 'create' } }
  assert.deepEqual(cardViewOf(card(), chatsWith(), { asking: 'e.md#A', flows }), { mode: 'starting', step: 'create' })
  const failed = { 'e.md#A': { kind: 'failed', step: 'send', reason: 'boom' } }
  assert.deepEqual(cardViewOf(card(), chatsWith(), { asking: 'e.md#A', flows: failed }), { mode: 'question', failure: { step: 'send', reason: 'boom' } })
  assert.deepEqual(cardViewOf(card(), chatsWith(), { flows: failed }), { mode: 'startable' }, 'the failure shows only while the question is open')
})

test('asking with no folder or an unreadable file shows the blocked text instead of the question', () => {
  const none = chatsWith({ folder: { id: null, reason: 'folder_id must be text.' } })
  assert.deepEqual(cardViewOf(card(), none, { asking: 'e.md#A' }), { mode: 'blocked', blocked: { kind: 'folder', reason: 'folder_id must be text.' } })
  assert.deepEqual(cardViewOf(card(), chatsWith({ folder: { id: null, reason: null } }), { asking: 'e.md#A' }).blocked, { kind: 'folder', reason: null })
  const unreadable = chatsWith({ folder: { id: null, reason: null }, recordsError: { code: 'chats_unreadable', message: 'chats.json cannot be read.' } })
  assert.deepEqual(cardViewOf(card(), unreadable, { asking: 'e.md#A' }), { mode: 'blocked', blocked: { kind: 'records', message: 'chats.json cannot be read.' } })
  assert.deepEqual(cardViewOf(card(), none, {}), { mode: 'startable' }, 'nothing is blocked until the person asks')
})

test('a card with a started chat is a link in every column, with its state once read', () => {
  for (const status of ['planned', 'in progress', 'done']) {
    const chats = chatsWith({ records: started(), byKey: { k1: { state: 'needs-you' } } })
    assert.deepEqual(cardViewOf(card({ status }), chats, { asking: 'e.md#A' }), {
      mode: 'chat', key: 'k1', name: 'k1', href: '/chat?sid=k1', state: 'needs-you', stateWord: 'Needs you',
    }, status)
  }
})

test('a started chat that has not been read yet is a link with no state', () => {
  const view = cardViewOf(card(), chatsWith({ records: started() }), {})
  assert.deepEqual([view.mode, view.href, view.state, view.stateWord], ['chat', '/chat?sid=k1', null, null])
})

test('a card with a started chat never offers the question', () => {
  const chats = chatsWith({ records: started(), byKey: { k1: { state: 'idle' } } })
  assert.equal(cardViewOf(card(), chats, { asking: 'e.md#A', flows: { 'e.md#A': { kind: 'starting', step: 'save' } } }).mode, 'chat')
})

test('a card with only a reserved record is a card with no started chat', () => {
  // The backend lists started chats only, so a reserved record is simply absent from `records`.
  assert.equal(cardViewOf(card(), chatsWith({ records: [record('e.md#Other', 'k9')] }), {}).mode, 'startable')
})

test('a missing chat is restoring for a minute, then not open, and has no link', () => {
  const chats = (at) => chatsWith({ records: started(), byKey: { k1: { state: 'missing' } }, missingSince: { k1: 10000 }, at })
  assert.equal(cardViewOf(card(), chats(10000), {}).mode, 'restoring')
  assert.equal(cardViewOf(card(), chats(10000 + RESTORE_MS - 1), {}).mode, 'restoring')
  assert.equal(cardViewOf(card(), chats(10000 + RESTORE_MS), {}).mode, 'not-open')
  assert.equal(cardViewOf(card(), chats(10000 + RESTORE_MS), {}).href, undefined)
  assert.equal(cardViewOf(card({ status: 'done' }), chats(10000 + RESTORE_MS), {}).mode, 'not-open')
})

test('resuming and a failed resume replace the not-open text', () => {
  const chats = chatsWith({ records: started(), byKey: { k1: { state: 'missing' } }, missingSince: { k1: 0 }, at: 200000 })
  assert.equal(cardViewOf(card(), chats, { resumes: { k1: { kind: 'resuming' } } }).mode, 'resuming')
  assert.deepEqual(cardViewOf(card(), chats, { resumes: { k1: { kind: 'failed', reason: 'nope' } } }), { mode: 'resume-failed', key: 'k1', name: 'k1', reason: 'nope' })
  const back = chatsWith({ records: started(), byKey: { k1: { state: 'idle' } }, at: 200000 })
  assert.equal(cardViewOf(card(), back, { resumes: { k1: { kind: 'resuming' } } }).mode, 'chat', 'a chat that is back is a chat')
})

test('the view takes the time of the last read, not the clock', () => {
  const chats = chatsWith({ records: started(), byKey: { k1: { state: 'missing' } }, missingSince: { k1: 0 }, at: RESTORE_MS - 1 })
  assert.equal(cardViewOf(card(), chats, {}).mode, 'restoring')
  assert.equal(cardViewOf(card(), chats, {}, RESTORE_MS).mode, 'not-open')
})

test('Property 6: the restoring clock', async () => {
  await forSeedsAsync('the restoring clock', 200, async (r) => {
    const backend = fakeBackend(backendAnswer([record('e.md#A', 'k1')]))
    let state = initialChats
    let runStart = null
    let time = r.int(0, 5000)
    for (let step = 0; step < r.int(2, 14); step += 1) {
      time += r.pick([1000, 5000, 15000, 30000, RESTORE_MS - 1, RESTORE_MS, RESTORE_MS + 1])
      const present = r.bool(0.35)
      const gateway = present
        ? fakeGateway({ rows: [row('k1')], details: { k1: detailWith('assistant') } })
        : fakeGateway({ rows: [] })
      const result = await readChats({ backend, gateway, previous: state, now: () => time })
      state = chatsReduce(state, { kind: 'chats', read: result })
      const view = cardViewOf(card(), state, {})
      if (present) {
        runStart = null
        assert.equal(view.mode, 'chat')
      } else {
        if (runStart === null) runStart = time
        assert.equal(view.mode, time - runStart < RESTORE_MS ? 'restoring' : 'not-open', `step ${step}, run began ${runStart}, now ${time}`)
        assert.equal(view.href, undefined)
      }
    }
  })
})
