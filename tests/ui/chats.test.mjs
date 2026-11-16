// The chat logic of the page: states, the chat read, the chats reducer and the card views.
// Property 1: One state, by precedence.            Validates: Requirements 6.2
// Property 2: Only our own keys count.             Validates: Requirements 6.1
// Property 6: The restoring clock.                 Validates: Requirements 8.2, 8.3
import test from 'node:test'
import assert from 'node:assert/strict'
import {
  RESTORE_MS, STATE_WORDS, cardViewOf, chatDelay, chatHref, chatsReduce, classifyChats, initialChats,
  readChats, reviewOf, reviewWord, stateOf, workersOf,
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
      if (path === '/api/chat/slots?crew=all') {
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
    details() { return gateway.calls.filter((path) => path !== '/api/chat/slots?crew=all') },
  }
  return gateway
}

const record = (cardId, key) => ({ card_id: cardId, name: key, key, created: 't' })
const backendAnswer = (chats, extra = {}) => ({ folder_id: 'f_1', folder_reason: null, chats, ...extra })
const row = (key, extra = {}) => ({ key, running: false, pending_approval: false, needs_input: false, interrupted: false, last_ts: 't1', messages: 3, ...extra })
const detailWith = (...roles) => ({ messages: roles.map((role) => ({ role })) })
const read = (deps) => readChats({ now: () => 1000, ...deps })

// ---- stateOf ----

test('each flag on its own gives its state, and a quiet row gives Your turn', () => {
  assert.equal(stateOf(row('k', { pending_approval: true })), 'needs-you')
  assert.equal(stateOf(row('k', { needs_input: true })), 'needs-you')
  assert.equal(stateOf(row('k', { running: true })), 'working')
  assert.equal(stateOf(row('k', { admission_queued: true })), 'working')
  assert.equal(stateOf(row('k', { interrupted: true })), 'interrupted')
  assert.equal(stateOf(row('k'), 'error'), 'interrupted')
  assert.equal(stateOf(row('k')), 'your-turn')
  assert.equal(stateOf(row('k'), 'assistant'), 'your-turn')
  assert.equal(stateOf(row('k'), null), 'your-turn')
})

test('flags in pairs: Needs you beats Interrupted, and Interrupted beats Working', () => {
  assert.equal(stateOf(row('k', { running: true, pending_approval: true })), 'needs-you')
  assert.equal(stateOf(row('k', { running: true, needs_input: true })), 'needs-you')
  assert.equal(stateOf(row('k', { admission_queued: true, needs_input: true })), 'needs-you')
  assert.equal(stateOf(row('k', { running: true, interrupted: true })), 'interrupted')
  assert.equal(stateOf(row('k', { pending_approval: true, interrupted: true }), 'error'), 'needs-you')
  assert.equal(stateOf(row('k', { interrupted: true }), 'error'), 'interrupted')
  assert.equal(stateOf(row('k', { running: true }), 'error'), 'working', 'a running turn is not interrupted by an old error row')
})

test('missing fields count as false, and only true counts as true', () => {
  assert.equal(stateOf({}), 'your-turn')
  assert.equal(stateOf(null), 'your-turn')
  assert.equal(stateOf({ running: 'yes', pending_approval: 1, needs_input: 'true', interrupted: 1 }), 'your-turn')
})

test('the state words are the six of the spec', () => {
  assert.deepEqual(STATE_WORDS, {
    'needs-you': 'Needs you', interrupted: 'Interrupted', working: 'Working', stalled: 'Stalled', review: 'Review', 'your-turn': 'Your turn',
  })
  assert.ok(Object.isFrozen(STATE_WORDS))
})

const PR = { kind: 'change', provider: 'github', number: 7, url: 'https://github.com/o/r/pull/7', state: 'open', ci: 'passed' }
const stale = (worker, at) => ({ open: 1, person: 0, items: [{ worker, stale_at_ms: at }] })

test('a worker of the conductor counts for Needs you and Working, found by crew_root or created_by', () => {
  const k = row('k')
  for (const link of ['crew_root', 'created_by']) {
    assert.equal(stateOf(k, undefined, [row('w', { [link]: 'k', pending_approval: true })]), 'needs-you', link)
    assert.equal(stateOf(k, undefined, [row('w', { [link]: 'k', needs_input: true })]), 'needs-you', link)
    assert.equal(stateOf(k, undefined, [row('w', { [link]: 'k', running: true })]), 'working', link)
    assert.equal(stateOf(k, undefined, [row('w', { [link]: 'k', admission_queued: true })]), 'working', link)
  }
  assert.equal(stateOf(row('k', { interrupted: true }), undefined, [row('w', { running: true })]), 'interrupted')
})

test('workersOf takes the rows whose crew_root or created_by is the key, and not the conductor or others', () => {
  const list = [row('k'), row('a', { crew_root: 'k' }), row('b', { created_by: 'k' }), row('c', { crew_root: 'x' }), row('d', { created_by: 'x' }), row('e')]
  assert.deepEqual(workersOf(list, 'k').map((r) => r.key), ['a', 'b'])
})

test('Stalled follows the rule of crewWorkCounts: stale item, no live conductor loop, worker not running', () => {
  const at = 5000
  const k = (extra) => row('k', { crew_work: stale('w', at), ...extra })
  assert.equal(stateOf(k(), undefined, [], 4999), 'your-turn', 'not yet stale')
  assert.equal(stateOf(k(), undefined, [], 5000), 'stalled')
  assert.equal(stateOf(k({ crew_work: { ...stale('w', at), conductor_looping: true } }), undefined, [], 9000), 'your-turn', 'a live loop picks it up')
  assert.equal(stateOf(k({ crew_work: stale('w', 0) }), undefined, [], 9000), 'your-turn', 'stale_at_ms 0 is never')
  assert.equal(stateOf(k(), undefined, [row('w', { running: true })], 9000), 'working', 'a running worker is never stale')
  assert.equal(stateOf(k({ crew_work: stale('', at) }), undefined, [], 9000), 'stalled', 'an unbound worker can be stale')
  assert.equal(stateOf(k({ crew_work: { items: 'x' } }), undefined, [], 9000), 'your-turn')
  assert.equal(stateOf(k({ source_links: [PR] }), undefined, [], 9000), 'stalled', 'Stalled comes before Review')
})

test('Review: an open or draft pull request of the conductor, with Checks failed when its ci failed', () => {
  const k = (...links) => row('k', { source_links: links })
  assert.equal(stateOf(k(PR)), 'review')
  assert.equal(stateOf(k({ ...PR, state: 'draft' })), 'review')
  for (const state of ['merged', 'closed', undefined]) assert.equal(stateOf(k({ ...PR, state })), 'your-turn', String(state))
  assert.equal(stateOf(k({ ...PR, kind: 'issue' })), 'your-turn')
  assert.equal(stateOf(k({ ...PR, url: 'http://github.com/o/r/pull/7' })), 'your-turn', 'only an https address')
  assert.equal(stateOf(k({ ...PR, url: 'javascript:alert(1)' })), 'your-turn')
  assert.equal(stateOf(k({ ...PR, state: 'merged' }, { ...PR, number: 8, state: 'open' })), 'review')
  assert.deepEqual(reviewOf(k(PR)), { number: 7, url: PR.url, failed: false })
  assert.deepEqual(reviewOf(k({ ...PR, ci: 'failed' })), { number: 7, url: PR.url, failed: true })
  assert.equal(reviewOf(row('k')), null)
  assert.equal(reviewWord({ number: 7, failed: false }), 'Review #7')
  assert.equal(reviewWord({ number: 7, failed: true }), 'Checks failed #7')
  assert.equal(stateOf(k(PR), undefined, [row('w', { running: true })]), 'working', 'Working comes before Review')
  assert.equal(stateOf(row('k'), undefined, [row('w', { source_links: [PR] })]), 'your-turn', 'a worker pull request does not count')
})

test('Property 1: one state, by precedence', () => {
  const flag = (r) => r.pick([undefined, false, false, true])
  const roles = ['error', 'assistant', 'user', 'inject', '', null, undefined]
  forSeeds('one state, by precedence', 400, (r) => {
    const make = () => ({ pending_approval: flag(r), needs_input: flag(r), running: flag(r), admission_queued: flag(r), interrupted: flag(r) })
    const candidate = { ...make(), key: 'k', crew_work: r.pick([undefined, stale('w1', 100), stale('', 100)]), source_links: r.pick([undefined, [PR], [{ ...PR, state: 'merged' }]]) }
    const workers = Array.from({ length: r.int(0, 3) }, (_, i) => ({ ...make(), key: `w${i}`, crew_root: 'k' }))
    const lastRole = r.pick(roles)
    const team = [candidate, ...workers]
    const on = (field) => team.some((x) => x[field] === true)
    const expected = on('pending_approval') || on('needs_input') ? 'needs-you'
      : candidate.interrupted === true || (lastRole === 'error' && !(candidate.running === true || candidate.admission_queued === true)) ? 'interrupted'
        : on('running') || on('admission_queued') ? 'working'
          : candidate.crew_work && !(candidate.crew_work.items[0].worker === 'w1' && workers.some((x) => x.key === 'w1' && x.running === true)) ? 'stalled'
            : candidate.source_links?.[0].state === 'open' ? 'review' : 'your-turn'
    const got = stateOf(candidate, lastRole, workers, 1000)
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
  assert.equal(chatDelay(make({ a: { state: 'your-turn' }, b: { state: 'interrupted' } })), 15000)
  assert.equal(chatDelay(make({ a: { state: 'your-turn' }, b: { state: 'working' } })), 5000)
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
    'k-working': 'working', 'k-needs': 'needs-you', 'k-interrupted': 'interrupted', 'k-idle': 'your-turn', 'k-error': 'interrupted',
  })
  assert.deepEqual(gateway.calls, ['/api/chat/slots?crew=all', '/api/chat/slots/k-idle?limit=1', '/api/chat/slots/k-error?limit=1'])
  assert.equal(result.byKey['someone-elses'], undefined)
})

test('the workers of a conductor count for its state, and the list asked for keeps them', async () => {
  const chats = [record('c1', 'a'), record('c2', 'b')]
  const gateway = fakeGateway({
    rows: [row('a'), row('w1', { crew_root: 'a', pending_approval: true }), row('b', { last_ts: 't9' }), row('w2', { created_by: 'b', running: true }), row('w3', { crew_root: 'nobody', pending_approval: true })],
    details: { b: detailWith('assistant') },
  })
  const result = await read({ backend: fakeBackend(backendAnswer(chats)), gateway })
  assert.equal(gateway.calls[0], '/api/chat/slots?crew=all')
  assert.deepEqual([result.byKey.a.state, result.byKey.b.state], ['needs-you', 'working'])
  assert.deepEqual(Object.keys(result.byKey), ['a', 'b'], 'no entry for a worker')
  assert.ok(!JSON.stringify(result).includes('w1'), 'nothing of a worker row is kept')
  assert.deepEqual(gateway.details(), ['/api/chat/slots/b?limit=1'], 'a worker is never read on its own')
})

test('Interrupted is read before Working: an idle conductor whose last row is an error is Interrupted while a worker runs', async () => {
  const gateway = fakeGateway({ rows: [row('a'), row('w', { crew_root: 'a', running: true })], details: { a: detailWith('assistant', 'error') } })
  const result = await read({ backend: fakeBackend(backendAnswer([record('c1', 'a')])), gateway })
  assert.equal(result.byKey.a.state, 'interrupted')
})

test('a Review entry keeps the pull request and nothing else of the row', async () => {
  const pr = { kind: 'change', number: 3, url: 'https://github.com/o/r/pull/3', state: 'draft', ci: 'passed', label: 'SECRET' }
  const gateway = fakeGateway({ rows: [row('a', { source_links: [pr], last_message: 'SECRET' })], details: { a: detailWith('assistant') } })
  const result = await read({ backend: fakeBackend(backendAnswer([record('c1', 'a')])), gateway })
  assert.deepEqual(result.byKey.a.review, { number: 3, url: pr.url, failed: false })
  assert.ok(!JSON.stringify(result).includes('SECRET'))
})

test('a stalled ledger item is judged at the time of the read', async () => {
  const gateway = () => fakeGateway({ rows: [row('a', { crew_work: stale('w', 2000) })], details: { a: detailWith('assistant') } })
  const backend = fakeBackend(backendAnswer([record('c1', 'a')]))
  assert.equal((await readChats({ backend, gateway: gateway(), now: () => 1999 })).byKey.a.state, 'your-turn')
  assert.equal((await readChats({ backend, gateway: gateway(), now: () => 2000 })).byKey.a.state, 'stalled')
})

test('cardViewOf says Review #N linked to its pull request, and Checks failed #N when the checks failed', () => {
  const review = { number: 7, url: 'https://github.com/o/r/pull/7', failed: false }
  const view = (entry) => cardViewOf(card(), chatsWith({ records: started(), byKey: { k1: entry } }), {})
  assert.deepEqual([view({ state: 'review', review }).stateWord, view({ state: 'review', review }).stateHref], ['Review #7', review.url])
  assert.equal(view({ state: 'review', review: { ...review, failed: true } }).stateWord, 'Checks failed #7')
  assert.equal(view({ state: 'your-turn' }).stateWord, 'Your turn')
  assert.equal(view({ state: 'your-turn' }).stateHref, null)
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
  assert.equal(second.byKey.k.state, 'your-turn')

  gateway = fakeGateway({ rows: [row('k', { last_ts: 't2' })], details: { k: detailWith('assistant', 'error') } })
  const third = await read({ backend, gateway, previous: { ...initialChats, byKey: second.byKey } })
  assert.equal(gateway.details().length, 1, 'last_ts changed: read')
  assert.equal(third.byKey.k.state, 'interrupted')

  gateway = fakeGateway({ rows: [row('k', { last_ts: 't2', messages: 4 })], details })
  const fourth = await read({ backend, gateway, previous: { ...initialChats, byKey: third.byKey } })
  assert.equal(gateway.details().length, 1, 'messages changed: read')
  assert.equal(fourth.byKey.k.state, 'your-turn')
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
  assert.deepEqual(gateway.calls, ['/api/chat/slots?crew=all', '/api/chat/slots/k?limit=1'])

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
  assert.deepEqual(Object.fromEntries(Object.entries(result.byKey).map(([key, entry]) => [key, entry.state])), { a: 'working', b: 'working', c: 'interrupted', d: 'your-turn' })
  assert.deepEqual(result.missingSince, {})
})

test('a detail answer with no rows is Your turn', async () => {
  const result = await read({ backend: fakeBackend(backendAnswer([record('c1', 'k')])), gateway: fakeGateway({ rows: [row('k')], details: { k: { messages: [] } } }) })
  assert.equal(result.byKey.k.state, 'your-turn')
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
  state = chatsReduce(failed, { kind: 'chats', read: goodRead({ at: 2000, byKey: { k1: { state: 'your-turn' } } }) })
  assert.deepEqual([state.failed, state.byKey.k1.state, state.at], [false, 'your-turn', 2000])
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
      mode: 'chat', key: 'k1', name: 'k1', href: '/chat?sid=k1', state: 'needs-you', stateWord: 'Needs you', stateHref: null, brief: null, open: false, cleanup: null,
    }, status)
  }
})

test('a started chat carries its brief note, which only a chat shows', () => {
  const chats = chatsWith({ records: started(), byKey: { k1: { state: 'your-turn' } } })
  assert.deepEqual(cardViewOf(card(), chats, { briefs: { k1: { kind: 'sending' } } }).brief, { kind: 'sending' })
  assert.deepEqual(cardViewOf(card(), chats, { briefs: { k1: { kind: 'failed', reason: 'boom' } } }).brief, { kind: 'failed', reason: 'boom' })
  assert.equal(cardViewOf(card(), chats, { briefs: { other: { kind: 'sending' } } }).brief, null)
  assert.equal(cardViewOf(card(), chatsWith({ records: started() }), { briefs: { k1: { kind: 'failed', reason: 'x' } } }).href, '/chat?sid=k1', 'the link stays')
  assert.equal(cardViewOf(card(), chatsWith(), { briefs: { k1: { kind: 'sending' } } }).mode, 'startable', 'a card with no chat has no brief note')
})

test('a started chat that has not been read yet is a link with no state', () => {
  const view = cardViewOf(card(), chatsWith({ records: started() }), {})
  assert.deepEqual([view.mode, view.href, view.state, view.stateWord], ['chat', '/chat?sid=k1', null, null])
})

test('a card with a started chat never offers the question', () => {
  const chats = chatsWith({ records: started(), byKey: { k1: { state: 'your-turn' } } })
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
  const back = chatsWith({ records: started(), byKey: { k1: { state: 'your-turn' } }, at: 200000 })
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

test('a started chat is open only when the page has it open', () => {
  const chats = chatsWith({ records: started(), byKey: { k1: { state: 'your-turn' } } })
  assert.equal(cardViewOf(card(), chats, { open: { cardId: 'e.md#A', key: 'k1' } }).open, true)
  assert.equal(cardViewOf(card(), chats, { open: { cardId: 'e.md#B', key: 'k2' } }).open, false)
  assert.equal(cardViewOf(card(), chats, {}).open, false)
})
