// Starting a story, resuming a chat and "Start again", against fakes of the backend and Crew.
// Property 7: A repeated start never sends the brief twice and never makes a second chat.
// Validates: Requirements 4.3, 4.4, 4.5, 4.6
import test from 'node:test'
import assert from 'node:assert/strict'
import { StartError, resumeChat, startAgain, startStory } from '../../ui/index.mjs'
import { forSeedsAsync } from './support.mjs'

const httpError = (status, error) => Object.assign(new Error(`API ${status}`), { status, error })
const CARD = 'epic-board.md#Filter by epic'
const RESERVATION = { card_id: CARD, name: 'epic-board-3fa91c0e', brief: 'THE BRIEF', folder_id: 'f_8c1' }

// Records every call and answers from `answers`: a function (path, body) -> value, or an Error to throw.
function recorder(answers) {
  const calls = []
  const make = (verb) => async (path, ...rest) => {
    calls.push([verb, path, ...rest])
    const answer = typeof answers === 'function' ? answers(verb, path, ...rest) : undefined
    if (answer instanceof Error) throw answer
    return answer
  }
  return { calls, get: make('get'), post: make('post'), del: make('del') }
}

function working() {
  const backend = recorder((verb, path) => (path === '/chats' ? RESERVATION : { ok: true }))
  const gateway = recorder((verb, path) => (path === '/api/chat/slots' ? { key: 'epic-board-3fa91c0e', messages: 0 } : {}))
  return { backend, gateway }
}

test('the requests of a start, in order, with exactly the bodies of the spec', async () => {
  const { backend, gateway } = working()
  const steps = []
  const result = await startStory({ cardId: CARD, backend, gateway, onStep: (step) => steps.push(step) })
  assert.deepEqual(steps, ['reserve', 'create', 'send', 'save'])
  assert.deepEqual(backend.calls, [
    ['post', '/chats', { card_id: CARD }],
    ['post', '/chats/epic-board-3fa91c0e/started', { key: 'epic-board-3fa91c0e' }],
  ])
  assert.deepEqual(gateway.calls, [
    ['post', '/api/chat/slots', { name: 'epic-board-3fa91c0e', agent: 'kirocrew-conductor', folder_id: 'f_8c1' }],
    ['post', '/api/chat', { slot: 'epic-board-3fa91c0e', message: 'THE BRIEF' }],
  ])
  assert.deepEqual(Object.keys(gateway.calls[0][2]).sort(), ['agent', 'folder_id', 'name'])
  assert.deepEqual(result, { cardId: CARD, name: 'epic-board-3fa91c0e', key: 'epic-board-3fa91c0e' })
})

test('the key Crew gives the chat is the one that is sent and saved, even when it differs from the name', async () => {
  const backend = recorder((verb, path) => (path === '/chats' ? RESERVATION : {}))
  const gateway = recorder((verb, path) => (path === '/api/chat/slots' ? { key: 'folded-key', messages: 0 } : {}))
  const result = await startStory({ cardId: CARD, backend, gateway })
  assert.deepEqual(gateway.calls[1], ['post', '/api/chat', { slot: 'folded-key', message: 'THE BRIEF' }])
  assert.deepEqual(backend.calls[1], ['post', '/chats/epic-board-3fa91c0e/started', { key: 'folded-key' }])
  assert.equal(result.key, 'folded-key')
})

test('a chat that already holds a message is not sent the brief again', async () => {
  const backend = recorder((verb, path) => (path === '/chats' ? RESERVATION : {}))
  const gateway = recorder((verb, path) => (path === '/api/chat/slots' ? { key: 'k', messages: 1 } : {}))
  const steps = []
  await startStory({ cardId: CARD, backend, gateway, onStep: (step) => steps.push(step) })
  assert.deepEqual(gateway.calls.map(([, path]) => path), ['/api/chat/slots'])
  assert.deepEqual(steps, ['reserve', 'create', 'send', 'save'], 'the step is still named, then passed')
  assert.equal(backend.calls.length, 2)
})

test('an error that only says Crew accepted the request counts as sent; any other error fails the send', async () => {
  const accepted = Object.assign(new Error('Crew accepted the request but the answer was not JSON'), { name: 'AcceptedBodyUnreadable' })
  let backend = recorder((verb, path) => (path === '/chats' ? RESERVATION : {}))
  let gateway = recorder((verb, path) => (path === '/api/chat/slots' ? { key: 'k', messages: 0 } : path === '/api/chat' ? accepted : {}))
  await startStory({ cardId: CARD, backend, gateway })
  assert.equal(backend.calls.length, 2, 'saved')

  backend = recorder((verb, path) => (path === '/chats' ? RESERVATION : {}))
  gateway = recorder((verb, path) => (path === '/api/chat/slots' ? { key: 'k', messages: 0 } : path === '/api/chat' ? httpError(500, null) : {}))
  await assert.rejects(startStory({ cardId: CARD, backend, gateway }), (error) => error instanceof StartError && error.step === 'send')
  assert.equal(backend.calls.length, 1, 'not saved')
})

test('each step failing throws a StartError that names the step and keeps the reason', async () => {
  const cases = [
    ['reserve', () => {
      const { backend, gateway } = working()
      return { backend: recorder((v, path) => (path === '/chats' ? httpError(409, { code: 'card_done', message: 'That story is done.' }) : {})), gateway }
    }, 'That story is done.', 'card_done'],
    ['create', () => {
      const { backend } = working()
      return { backend, gateway: recorder((v, path) => (path === '/api/chat/slots' ? new Error('API 400: {"error":"folder not found"}') : {})) }
    }, 'API 400: {"error":"folder not found"}', null],
    ['send', () => {
      const { backend } = working()
      return { backend, gateway: recorder((v, path) => (path === '/api/chat/slots' ? { key: 'k', messages: 0 } : new TypeError('Failed to fetch'))) }
    }, 'Failed to fetch', null],
    ['save', () => {
      const { gateway } = working()
      return { backend: recorder((v, path) => (path === '/chats' ? RESERVATION : httpError(500, { code: 'internal', message: 'The board\'s file of chats could not be written.' }))), gateway }
    }, 'The board\'s file of chats could not be written.', 'internal'],
  ]
  for (const [step, build, reason, code] of cases) {
    const steps = []
    await assert.rejects(startStory({ cardId: CARD, ...build(), onStep: (s) => steps.push(s) }), (error) => {
      assert.ok(error instanceof StartError, step)
      assert.equal(error.step, step)
      assert.equal(error.reason, reason)
      assert.equal(error.code, code)
      return true
    }, step)
    assert.equal(steps.at(-1), step, 'the last step named is the one that failed')
  }
})

test('every refusal of a reservation is shown with the backend\'s own words', async () => {
  const refusals = [
    ['card_not_found', 'That story is not in the plan on the main branch.'], ['card_done', 'That story is done.'],
    ['chat_exists', 'This story already has a chat.'], ['folder_not_set', 'No Crew folder is set for this project.'],
    ['plan_not_ready', 'The plan has not been read yet.'], ['chats_unreadable', '/x/chats.json cannot be read.'],
  ]
  for (const [code, message] of refusals) {
    const backend = recorder((v, path) => httpError(path === '/chats' ? 409 : 500, { code, message }))
    const gateway = recorder(() => ({}))
    await assert.rejects(startStory({ cardId: CARD, backend, gateway }), (error) => error.step === 'reserve' && error.reason === message && error.code === code, code)
    assert.deepEqual(gateway.calls, [], 'nothing is sent to Crew after a refusal')
  }
})

test('a create answer with no text key fails the create step, and a bad reservation fails the reserve step', async () => {
  for (const row of [{}, { key: '' }, { key: 5 }, null, undefined, 'x']) {
    const { backend } = working()
    const gateway = recorder((v, path) => (path === '/api/chat/slots' ? row : {}))
    await assert.rejects(startStory({ cardId: CARD, backend, gateway }), (error) => error.step === 'create', JSON.stringify(row))
    assert.equal(gateway.calls.length, 1, 'no brief is sent to a chat that has no key')
  }
  for (const reservation of [{}, { name: 'n' }, { name: 'n', brief: 'b' }, { name: 3, brief: 'b', folder_id: 'f' }, null, 'x']) {
    const backend = recorder((v, path) => (path === '/chats' ? reservation : {}))
    const gateway = recorder(() => ({}))
    await assert.rejects(startStory({ cardId: CARD, backend, gateway }), (error) => error.step === 'reserve', JSON.stringify(reservation))
    assert.deepEqual(gateway.calls, [])
  }
})

test('a long reason is cut to 300 characters', async () => {
  const { gateway } = working()
  const backend = recorder((v, path) => new Error('x'.repeat(1000)))
  await assert.rejects(startStory({ cardId: CARD, backend, gateway }), (error) => error.reason.length === 300)
})

test('a name or key with unusual characters is percent-encoded in the path', async () => {
  const backend = recorder((v, path) => (path === '/chats' ? { ...RESERVATION, name: 'a b/c' } : {}))
  const gateway = recorder((v, path) => (path === '/api/chat/slots' ? { key: 'k', messages: 0 } : {}))
  await startStory({ cardId: CARD, backend, gateway })
  assert.equal(backend.calls[1][1], '/chats/a%20b%2Fc/started')
})

// ---- resume and start again ----

test('resuming posts to the chat\'s resume route with no body', async () => {
  const gateway = recorder(() => ({ ok: true, messages: [] }))
  await resumeChat({ key: 'epic-board-3fa91c0e', gateway })
  assert.deepEqual(gateway.calls, [['post', '/api/chat/slots/epic-board-3fa91c0e/resume']])
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
  await startAgain({ name: 'epic-board-3fa91c0e', backend })
  assert.deepEqual(backend.calls, [['del', '/chats/epic-board-3fa91c0e']])
  await assert.rejects(startAgain({ name: 'n', backend: recorder(() => httpError(404, { code: 'chat_not_found', message: 'There is no chat record with that name.' })) }),
    (error) => error.step === 'remove' && error.reason === 'There is no chat record with that name.' && error.code === 'chat_not_found')
})

// ---- Property 7 ----

// A world of one backend and one Crew, where calls can fail before or after they take effect.
function world(r, failureRate) {
  const state = { records: new Map(), chats: new Map(), nextName: 0, messages: 0, started: false }
  const fails = () => r.bool(failureRate)
  // `lost` is a call that took effect but whose answer never arrived.
  const answer = (effect) => {
    const before = fails()
    if (before) throw new TypeError('Failed to fetch')
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
    post: async (path, body) => answer(() => {
      if (path === '/api/chat/slots') {
        if (!state.chats.has(body.name)) state.chats.set(body.name, { key: `key-${body.name}`, messages: 0 })
        const chat = state.chats.get(body.name)
        return { key: chat.key, messages: chat.messages }
      }
      // POST /api/chat: the message lands in the chat
      const chat = [...state.chats.values()].find((candidate) => candidate.key === body.slot)
      chat.messages += 1
      state.messages += 1
      return {}
    }),
  }
  return { state, backend, gateway }
}

test('Property 7: a repeated start never sends the brief twice and never makes a second chat', async () => {
  await forSeedsAsync('a repeated start never sends the brief twice', 300, async (r) => {
    const { state, backend, gateway } = world(r, r.pick([0, 0.15, 0.3, 0.5]))
    let succeeded = null
    for (let attempt = 0; attempt < r.int(1, 12); attempt += 1) {
      try {
        succeeded = await startStory({ cardId: CARD, backend, gateway })
        break
      } catch (error) {
        assert.ok(error instanceof StartError, `attempt ${attempt} threw ${error}`)
        if (error.code === 'chat_exists') break // an earlier attempt's save was lost: the card has its chat
      }
      assert.ok(state.chats.size <= 1, 'at most one chat exists for the card')
      assert.ok(state.messages <= 1, 'at most one message was sent')
    }
    assert.ok(state.chats.size <= 1, 'at most one chat exists for the card')
    assert.ok(state.messages <= 1, 'the brief is sent at most once')
    assert.ok(state.records.size <= 1)
    if (succeeded) {
      const record = state.records.get(CARD)
      assert.equal(record.state, 'started')
      assert.equal(record.key, succeeded.key)
      assert.equal(state.chats.size, 1)
      assert.equal(state.messages, 1, 'a successful start has sent the brief exactly once')
    }
  })
})

test('Property 7 with no failures: one start gives one chat, one message and a started record', async () => {
  await forSeedsAsync('no failures', 20, async (r) => {
    const { state, backend, gateway } = world(r, 0)
    const result = await startStory({ cardId: CARD, backend, gateway })
    assert.deepEqual([state.chats.size, state.messages, state.records.get(CARD).state, state.records.get(CARD).key], [1, 1, 'started', result.key])
    await assert.rejects(startStory({ cardId: CARD, backend, gateway }), (error) => error.step === 'reserve' && error.code === 'chat_exists')
    assert.deepEqual([state.chats.size, state.messages], [1, 1])
  })
})
