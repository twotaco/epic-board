// Epic Board page: a read-only board of the project's specs and epics, read from the
// main branch by the backend. Uses the host's React (looked up on first render). The
// pure parts (data functions, reducer, views, poller, renderBoard) are exported so
// tests can import them under Node without `window`.

// ---- Pure data functions (no `window`, no React) ----

const COLUMNS = [
  { key: 'planned', title: 'Planned' },
  { key: 'in progress', title: 'In progress' },
  { key: 'done', title: 'Done' },
]

// The three columns, each with the groups that hold a card of its status.
// Groups and cards keep the plan's order. A card listed under two epics is in
// two groups and counts twice. A group with no epic is named "No epic" and
// keyed "no-epic"; an epic group is keyed by its file name.
export function columnsOf(plan) {
  const planGroups = Array.isArray(plan?.groups) ? plan.groups : []
  return COLUMNS.map(({ key, title }) => {
    const groups = []
    let count = 0
    for (const group of planGroups) {
      const cards = (group.cards ?? []).filter((card) => card.status === key)
      if (cards.length === 0) continue
      groups.push({
        key: group.epic ? group.epic.file : 'no-epic',
        name: group.epic ? group.epic.name : null,
        cards,
      })
      count += cards.length
    }
    return { key, title, count, groups }
  })
}

// The progress line of a card: {text, fraction}. `fraction` is null when no bar is shown.
export function progressOf(card) {
  if (card.spec == null) return { text: 'No spec yet', fraction: null }
  if (card.tasks == null) return { text: 'Tasks could not be read', fraction: null }
  const { done, total } = card.tasks
  if (!(total > 0)) return { text: 'No tasks yet', fraction: null }
  const fraction = Math.min(1, Math.max(0, done / total))
  return { text: `${done} of ${total} ${total === 1 ? 'task' : 'tasks'}`, fraction }
}

// The plan age in words. `seconds` is null or undefined when no fetch has succeeded yet.
export function ageText(seconds) {
  if (seconds == null) return 'Not yet updated from origin'
  if (seconds < 60) return 'Updated less than a minute ago'
  const [unit, size] = seconds < 3600 ? ['minute', 60] : seconds < 86400 ? ['hour', 3600] : ['day', 86400]
  const n = Math.floor(seconds / size)
  return `Updated ${n} ${unit}${n === 1 ? '' : 's'} ago`
}

// Milliseconds until the next plan request. `result` is what `classify` returns:
//   {kind: 'pending'}, {kind: 'plan', plan}, {kind: 'error', ...} or {kind: 'failure'}.
// 2000 for pending or a plan with `refreshing` true; 15000 for everything else, including a failure.
export function nextDelay(result) {
  if (result?.kind === 'pending') return 2000
  if (result?.kind === 'plan' && result.plan?.refreshing === true) return 2000
  return 15000
}

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// Turns a plan answer into a result: {kind: 'pending'}, {kind: 'plan', plan},
// {kind: 'error', error} or {kind: 'failure'}. Anything of an unknown shape is a failure.
export function classify(status, body) {
  if (!isObject(body)) return { kind: 'failure' }
  if (status === 202) {
    const keys = Object.keys(body)
    return keys.length === 1 && keys[0] === 'pending' && body.pending === true
      ? { kind: 'pending' }
      : { kind: 'failure' }
  }
  if (isObject(body.error)) return { kind: 'error', error: body.error }
  if (Array.isArray(body.groups)) return { kind: 'plan', plan: body }
  return { kind: 'failure' }
}

// The reducer state: `content` is null, {type: 'plan', plan} or {type: 'error', error};
// `unreachable` is true after a failure until a later answer can be read.
export const initialState = Object.freeze({ content: null, unreachable: false })

export function reduce(state, result) {
  switch (result?.kind) {
    case 'plan':
      return { content: { type: 'plan', plan: result.plan }, unreachable: false }
    case 'error':
      return { content: { type: 'error', error: result.error }, unreachable: false }
    case 'pending':
      return { content: state.content, unreachable: false }
    case 'failure':
      return { content: state.content, unreachable: true }
    default:
      return state
  }
}

// What the page shows for a state. `kind` is 'loading', 'unreachable', 'error' or 'plan'.
export function viewOf(state) {
  const { content, unreachable } = state
  if (content === null) return { kind: unreachable ? 'unreachable' : 'loading' }
  if (content.type === 'error') {
    if (unreachable) return { kind: 'unreachable' }
    const { error } = content
    return {
      kind: 'error',
      message: error.message,
      code: error.code,
      settings: Array.isArray(error.settings) ? error.settings : [],
    }
  }
  const { plan } = content
  const groups = Array.isArray(plan.groups) ? plan.groups : []
  const empty = !groups.some((group) => Array.isArray(group.cards) && group.cards.length > 0)
  const age = ageText(plan.age_seconds)
  return {
    kind: 'plan',
    plan,
    branch: plan.branch,
    commit7: String(plan.commit ?? '').slice(0, 7),
    ageText: age,
    refreshing: plan.refreshing === true,
    failedFetch: plan.fetch?.ok === false ? { reason: plan.fetch.reason ?? '', ageText: age } : null,
    unreachableNotice: unreachable,
    empty,
    columns: empty ? null : columnsOf(plan),
    problems: Array.isArray(plan.problems) ? plan.problems : [],
  }
}

// ---- Polling ----

const REQUEST_TIMEOUT_MS = 10000

// The plan request loop. Everything it touches is injected:
//   request(signal)   -> promise of {status, body}; rejects on a connection failure or invalid JSON
//   hidden()          -> true while the page is hidden
//   setTimer(fn, ms)  -> handle; clearTimer(handle) clears it (used for both the 10-second abort
//                        timer and the next-request timer)
//   onResult(result)  -> receives what `classify` returns, or {kind: 'failure'} for a rejected,
//                        malformed or aborted request
//   createAbortController() -> optional; defaults to `new AbortController()`
//   classifyAnswer(status, body) -> optional; turns an answer into a result. Defaults to `classify`
//                        (the plan's); the chat poller passes `classifyChats`
//   delay(result)     -> optional; milliseconds until the next request. Defaults to `nextDelay`
//                        (the plan's); the chat poller passes `chatDelay`
// At most one request is in flight. Returns {start, visible, stop}.
export function createPoller({
  request,
  hidden,
  setTimer,
  clearTimer,
  onResult,
  createAbortController = () => new AbortController(),
  classifyAnswer = classify,
  delay = nextDelay,
}) {
  let stopped = false
  let inflight = null // {controller, abortTimer, settled}
  let nextTimer = null

  function clearNext() {
    if (nextTimer !== null) {
      clearTimer(nextTimer)
      nextTimer = null
    }
  }

  // Ends `current` with `result`. Anything that settles after the request ended, or after
  // `stop()`, is ignored.
  function settle(current, result) {
    if (current.settled || stopped) return
    current.settled = true
    clearTimer(current.abortTimer)
    inflight = null
    try {
      onResult(result)
    } finally {
      if (!stopped) nextTimer = setTimer(onNextTimer, delay(result))
    }
  }

  function send() {
    const controller = createAbortController()
    const current = { controller, abortTimer: null, settled: false }
    inflight = current
    current.abortTimer = setTimer(() => {
      if (current.settled || stopped) return
      controller.abort()
      settle(current, { kind: 'failure' })
    }, REQUEST_TIMEOUT_MS)
    let pending
    try {
      pending = Promise.resolve(request(controller.signal))
    } catch {
      pending = Promise.reject(new Error('request failed'))
    }
    pending.then(
      (answer) => {
        let result
        try {
          result = classifyAnswer(answer.status, answer.body)
        } catch {
          result = { kind: 'failure' }
        }
        settle(current, result)
      },
      () => settle(current, { kind: 'failure' }),
    )
  }

  function onNextTimer() {
    nextTimer = null
    if (stopped || inflight !== null || hidden()) return
    send()
  }

  return {
    start() {
      if (stopped || inflight !== null) return
      clearNext()
      if (hidden()) return
      send()
    },
    visible() {
      if (stopped) return
      clearNext()
      if (inflight !== null) return
      send()
    },
    stop() {
      if (stopped) return
      stopped = true
      clearNext()
      if (inflight !== null) {
        const current = inflight
        inflight = null
        current.settled = true
        clearTimer(current.abortTimer)
        current.controller.abort()
      }
    },
  }
}

// ---- Chats: the state of each started chat, and starting and resuming one ----

// The four states a chat can show. There is no "finished": a story is done only when main says so.
export const STATE_WORDS = Object.freeze({
  'needs-you': 'Needs you',
  working: 'Working',
  interrupted: 'Interrupted',
  idle: 'Idle',
})

// How long a chat that Crew does not know is "restoring" before the card offers to resume it.
export const RESTORE_MS = 60000
const CHAT_SOON_MS = 5000
const CHAT_LATER_MS = 15000
const AGENT = 'kirocrew-conductor'

// One state for a chat, from its row in Crew's chat list and the role of its last row (or
// undefined when that has not been read). The first that applies:
//   Needs you   a tool waits for an approval, or the chat asked a question
//   Working     a turn is running or waiting for admission
//   Interrupted the turn ended without a reply, or the last row is an error
//   Idle        anything else
// Needs you comes first because a turn that waits for an approval is still running.
export function stateOf(row, lastRole) {
  if (row?.pending_approval === true || row?.needs_input === true) return 'needs-you'
  if (row?.running === true || row?.admission_queued === true) return 'working'
  if (row?.interrupted === true || lastRole === 'error') return 'interrupted'
  return 'idle'
}

// The address of a chat in the dashboard. Only the percent-encoded key goes in it.
export function chatHref(key) {
  return `/chat?sid=${encodeURIComponent(key)}`
}

// Turns what `readChats` resolved into a result for the chat poller: {kind: 'chats', read} or
// {kind: 'failure'}.
export function classifyChats(status, body) {
  if (status === 200 && isObject(body) && isObject(body.byKey) && Array.isArray(body.chats)) {
    return { kind: 'chats', read: body }
  }
  return { kind: 'failure' }
}

// Whether a missing chat is still within its first minute at the end of a read.
function isRestoring(read, key) {
  const since = read.missingSince?.[key]
  return typeof since === 'number' && read.at - since < RESTORE_MS
}

// Milliseconds until the next chat read: 5000 while any chat is working, needs the person, or is
// restoring; 15000 otherwise, and after a failure.
export function chatDelay(result) {
  if (result?.kind !== 'chats') return CHAT_LATER_MS
  const read = result.read
  for (const [key, entry] of Object.entries(read.byKey)) {
    if (entry.state === 'working' || entry.state === 'needs-you') return CHAT_SOON_MS
    if (entry.state === 'missing' && isRestoring(read, key)) return CHAT_SOON_MS
  }
  return CHAT_LATER_MS
}

const errorMessage = (error) => String(error?.message ?? error)

// The role of the newest row in a slot detail, '' when the row has none, null when there are no rows.
function lastRoleOf(detail) {
  const rows = Array.isArray(detail?.messages) ? detail.messages : []
  if (rows.length === 0) return null
  return String(rows[rows.length - 1]?.role ?? '')
}

// One read of the chats. Everything it touches is injected:
//   backend.get(path, {signal}) -> the parsed body of the app's own backend; rejects with an error
//                                   that has `status` and `error` ({code, message}) on a non-2xx answer
//   gateway.get(path, {signal}) -> Crew's chat endpoints through useAppApi; rejects with `status`
//   previous                    -> the chats state, for the missing-since marks and the last-row cache
//   now()                       -> milliseconds
//   onRecords({chats, folder, recordsError}) -> optional; called as soon as the backend has answered,
//                                   before anything is asked of Crew, so a started chat shows its link
//                                   even while its state is being read or the read fails
// It reads the records, and when there are started chats the chat list, keeps only the rows whose key
// is a started chat's key, and reads a chat's newest row only when its row is not Needs you, Working or
// interrupted and its `last_ts` or `messages` changed since the last read. A key that is not in the list
// is read on its own: a 404 is `missing`. Anything else that goes wrong rejects.
export async function readChats({ backend, gateway, previous = initialChats, now, signal, onRecords = () => {} }) {
  let answer
  try {
    answer = await backend.get('/chats', { signal })
  } catch (error) {
    if (error?.error?.code === 'chats_unreadable') {
      const recordsError = { code: 'chats_unreadable', message: String(error.error.message ?? '') }
      const folder = { id: null, reason: null }
      onRecords({ chats: [], folder, recordsError })
      return { at: now(), folder, recordsError, chats: [], byKey: {}, missingSince: {} }
    }
    throw error
  }
  const records = Array.isArray(answer?.chats) ? answer.chats : []
  const folder = { id: typeof answer?.folder_id === 'string' ? answer.folder_id : null, reason: answer?.folder_reason ?? null }
  onRecords({ chats: records, folder, recordsError: null })
  const byKey = {}
  const missingSince = {}
  if (records.length === 0) return { at: now(), folder, recordsError: null, chats: [], byKey, missingSince }

  const list = await gateway.get('/api/chat/slots', { signal })
  if (!Array.isArray(list)) throw new Error('The chat list is not a list.')
  const ours = new Set(records.map((record) => record.key))
  const rows = new Map()
  for (const row of list) if (isObject(row) && ours.has(row.key)) rows.set(row.key, row)

  const detailOf = async (key) => {
    try {
      return await gateway.get(`/api/chat/slots/${encodeURIComponent(key)}?limit=1`, { signal })
    } catch (error) {
      if (error?.status === 404) return null
      throw error
    }
  }
  const markMissing = (key) => {
    byKey[key] = { state: 'missing' }
    missingSince[key] = typeof previous.missingSince?.[key] === 'number' ? previous.missingSince[key] : null
  }

  for (const record of records) {
    const key = record.key
    const row = rows.get(key)
    if (row) {
      let state = stateOf(row, undefined)
      let role
      let roleRead = false
      if (state === 'idle') {
        const cached = previous.byKey?.[key]
        if (cached?.roleRead === true && cached.lastTs === row.last_ts && cached.messages === row.messages) {
          role = cached.role
          roleRead = true
        } else {
          const detail = await detailOf(key)
          if (detail === null) {
            markMissing(key)
            continue
          }
          role = lastRoleOf(detail)
          roleRead = true
        }
        state = stateOf(row, role)
      }
      byKey[key] = { state, lastTs: row.last_ts, messages: row.messages, role, roleRead }
      continue
    }
    const detail = await detailOf(key)
    if (detail === null) {
      markMissing(key)
      continue
    }
    const role = lastRoleOf(detail)
    const state = detail.running === true || detail.admission_queued === true ? 'working' : role === 'error' ? 'interrupted' : 'idle'
    byKey[key] = { state, role, roleRead: true }
  }
  const at = now()
  for (const key of Object.keys(missingSince)) if (missingSince[key] === null) missingSince[key] = at
  return { at, folder, recordsError: null, chats: records, byKey, missingSince }
}

// The chats state. `records` are the started chats ({card_id, name, key, created}); `byKey` holds
// the last read of each; `missingSince` the time the current run of "missing" reads began; `at` the
// time of the last good read; `failed` is true after a failed read until a good one.
export const initialChats = Object.freeze({
  records: [],
  folder: Object.freeze({ id: null, reason: null }),
  recordsError: null,
  byKey: Object.freeze({}),
  missingSince: Object.freeze({}),
  at: null,
  failed: false,
  loaded: false,
})

// Results: {kind: 'chats', read} and {kind: 'failure'} from the chat poller, {kind: 'records', chats,
// folder, recordsError} from the start of a read (the records before the states), and the page's own
// {kind: 'started', record} and {kind: 'removed', name}. A failed read keeps what is shown.
export function chatsReduce(state, result) {
  switch (result?.kind) {
    case 'records': {
      const keys = new Set(result.chats.map((record) => record.key))
      const keep = (marks) => Object.fromEntries(Object.entries(marks).filter(([key]) => keys.has(key)))
      return {
        ...state, records: result.chats, folder: result.folder, recordsError: result.recordsError ?? null,
        byKey: keep(state.byKey), missingSince: keep(state.missingSince), loaded: true,
      }
    }
    case 'chats': {
      const { read } = result
      return {
        records: read.chats, folder: read.folder, recordsError: read.recordsError ?? null,
        byKey: read.byKey, missingSince: read.missingSince ?? {}, at: read.at, failed: false, loaded: true,
      }
    }
    case 'failure':
      return { ...state, failed: true }
    case 'started': {
      const record = { card_id: result.record.card_id, name: result.record.name, key: result.record.key, created: result.record.created ?? null }
      const records = state.records.filter((existing) => existing.card_id !== record.card_id).concat(record)
      return { ...state, records, recordsError: null }
    }
    case 'removed': {
      const gone = state.records.find((record) => record.name === result.name)
      if (!gone) return state
      const { [gone.key]: _entry, ...byKey } = state.byKey
      const { [gone.key]: _since, ...missingSince } = state.missingSince
      return { ...state, records: state.records.filter((record) => record !== gone), byKey, missingSince }
    }
    default:
      return state
  }
}

// What one card shows, from its plan card, the chats state, the page's own UI state and the time
// the last read ended (so it stays pure). `ui` is {asking, flows, resumes}:
//   asking   the card id that has the question open, or null
//   flows    {cardId: {kind: 'starting', step} | {kind: 'failed', step, reason}}
//   resumes  {key: {kind: 'resuming'} | {kind: 'failed', reason}}
//   briefs   {key: {kind: 'sending'} | {kind: 'failed', reason}}   the brief of a started chat
// The result's `mode` is one of: plain, startable, question, starting, blocked, chat, restoring,
// not-open, resuming, resume-failed.
export function cardViewOf(card, chats, ui = {}, nowMs = chats.at) {
  const record = chats.records.find((candidate) => candidate.card_id === card.id)
  if (record) {
    const key = record.key
    const entry = chats.byKey[key]
    if (entry?.state === 'missing') {
      const resume = ui.resumes?.[key]
      if (resume?.kind === 'resuming') return { mode: 'resuming', key, name: record.name }
      if (resume?.kind === 'failed') return { mode: 'resume-failed', key, name: record.name, reason: resume.reason }
      const since = chats.missingSince[key]
      const age = typeof since === 'number' && typeof nowMs === 'number' ? nowMs - since : 0
      return { mode: age < RESTORE_MS ? 'restoring' : 'not-open', key, name: record.name }
    }
    return {
      mode: 'chat', key, name: record.name, href: chatHref(key),
      state: entry ? entry.state : null,
      stateWord: entry ? STATE_WORDS[entry.state] : null,
      brief: ui.briefs?.[key] ?? null,
    }
  }
  if (card.status === 'done') return { mode: 'plain' }
  const flow = ui.flows?.[card.id]
  if (flow?.kind === 'starting') return { mode: 'starting', step: flow.step }
  if (ui.asking !== card.id) return { mode: 'startable' }
  if (chats.recordsError) return { mode: 'blocked', blocked: { kind: 'records', message: chats.recordsError.message } }
  if (!chats.folder.id) return { mode: 'blocked', blocked: { kind: 'folder', reason: chats.folder.reason } }
  return { mode: 'question', failure: flow?.kind === 'failed' ? { step: flow.step, reason: flow.reason } : null }
}

// A start or resume that failed: `step` names where, `reason` is Crew's or the backend's own words.
export class StartError extends Error {
  constructor(step, reason, code = null) {
    super(`${step}: ${reason}`)
    this.name = 'StartError'
    this.step = step
    this.reason = reason
    this.code = code
  }
}

const REASON_MAX_CHARS = 300

function failAt(step, error) {
  if (error instanceof StartError) return error
  const reason = errorMessage(error?.error?.message ?? error).slice(0, REASON_MAX_CHARS)
  return new StartError(step, reason, error?.error?.code ?? null)
}

// How long the page waits for Crew to refuse a brief before it counts it as sent. `POST /api/chat` does not
// answer until the conductor's turn ends, and a turn that waits for a tool approval or an answer does not
// end on its own, so the page cannot wait for the answer.
export const SEND_WAIT_MS = 10000

const defaultSetTimer = (fn, ms) => setTimeout(fn, ms)
const defaultClearTimer = (handle) => clearTimeout(handle)

// Sends the brief to a chat and ends when Crew has accepted it, which is not when the turn ends:
//   - the request answers (the turn ended), or fails with an error that says Crew accepted the request:
//     sent;
//   - 10 seconds pass with no error: sent. The request is left running and whatever it later answers,
//     an error too, is ignored. It is not aborted: a request Crew has accepted must not be cut off;
//   - any other error before that: rejects with it.
export function sendBrief({ gateway, key, brief, setTimer = defaultSetTimer, clearTimer = defaultClearTimer }) {
  return new Promise((resolve, reject) => {
    let ended = false
    let timer = null
    const end = (how, value) => {
      if (ended) return
      ended = true
      if (timer !== null) clearTimer(timer)
      how(value)
    }
    timer = setTimer(() => end(resolve), SEND_WAIT_MS)
    let request
    try {
      request = Promise.resolve(gateway.post('/api/chat', { slot: key, message: brief }))
    } catch (error) {
      request = Promise.reject(error)
    }
    request.then(
      () => end(resolve),
      (error) => (/accepted the request/.test(errorMessage(error)) ? end(resolve) : end(reject, error)),
    )
  })
}

// The whole start of a story from its card, in four steps, each named to `onStep` before it runs:
//   reserve  ask the backend for a name, the brief and the folder id
//   create   open the chat in Crew (a name the board already created answers with the same chat)
//   save     tell the backend the chat has started, with the key Crew gave it
//   send     send the brief, unless the chat already holds a message, without waiting for the turn
// `onSaved({cardId, name, key, brief})` is called as soon as the chat is saved, before the send, so the card
// can show its link and the chat's state while the brief is on its way. A failure before the save throws a
// StartError and leaves the backend's record `reserved`, so a repeat is safe. A failure of the send throws a
// StartError for the step `send` that carries `saved`: the chat exists and is saved, only the brief is missing.
export async function startStory({
  cardId, backend, gateway, onStep = () => {}, onSaved = () => {}, setTimer = defaultSetTimer, clearTimer = defaultClearTimer,
}) {
  let step = 'reserve'
  let saved = null
  try {
    onStep(step)
    const reservation = await backend.post('/chats', { card_id: cardId })
    if (typeof reservation?.name !== 'string' || typeof reservation.brief !== 'string' || typeof reservation.folder_id !== 'string') {
      throw new StartError(step, 'The backend answered in a form the page cannot read.')
    }
    step = 'create'
    onStep(step)
    const row = await gateway.post('/api/chat/slots', { name: reservation.name, agent: AGENT, folder_id: reservation.folder_id })
    const key = row?.key
    if (typeof key !== 'string' || key === '') throw new StartError(step, 'Crew answered without a chat key.')
    step = 'save'
    onStep(step)
    await backend.post(`/chats/${encodeURIComponent(reservation.name)}/started`, { key })
    saved = { cardId, name: reservation.name, key, brief: reservation.brief }
    onSaved(saved)
    step = 'send'
    onStep(step)
    if (!(row.messages > 0)) await sendBrief({ gateway, key, brief: reservation.brief, setTimer, clearTimer })
    return saved
  } catch (error) {
    const failure = failAt(step, error)
    if (saved !== null && step === 'send') failure.saved = saved
    throw failure
  }
}

// Sends the brief again after a failed send, and only when the chat holds no message: it reads Crew's
// chat list, and sends only when the list has a row for the chat whose `messages` is 0. Resolves
// {sent: true} when it sent it and {sent: false} when the chat already holds a message (then the brief
// counts as sent). Nothing is sent when the list cannot be read or has no row for the chat.
export async function retryBrief({ gateway, key, brief, setTimer = defaultSetTimer, clearTimer = defaultClearTimer }) {
  try {
    const list = await gateway.get('/api/chat/slots')
    if (!Array.isArray(list)) throw new StartError('send', 'The chat list could not be read.')
    const row = list.find((candidate) => isObject(candidate) && candidate.key === key)
    if (!row) throw new StartError('send', 'Crew does not have this chat open.')
    if (typeof row.messages !== 'number') throw new StartError('send', 'Crew did not say how many messages the chat holds.')
    if (row.messages > 0) return { sent: false }
    await sendBrief({ gateway, key, brief, setTimer, clearTimer })
    return { sent: true }
  } catch (error) {
    throw failAt('send', error)
  }
}

// Resume a chat Crew has closed or not restored. No body.
export async function resumeChat({ key, gateway }) {
  try {
    await gateway.post(`/api/chat/slots/${encodeURIComponent(key)}/resume`)
  } catch (error) {
    throw failAt('resume', error)
  }
}

// "Start again": forget the board's record of a chat that cannot be resumed. It touches nothing in Crew.
export async function startAgain({ name, backend }) {
  try {
    await backend.del(`/chats/${encodeURIComponent(name)}`)
  } catch (error) {
    throw failAt('remove', error)
  }
}

// ---- The page ----

// The level of the page title. Column headings are one level below it and group
// headings two levels below it, so one edit shifts all three.
export const TITLE_LEVEL = 1

// The one style sheet. It sets no text or background colour (the host's theme
// supplies them). Borders, bar tracks, bar fills and tints use `currentColor` or
// a grey with an alpha between 0 and 1. No rule removes the focus indicator.
export const STYLE = `
.eb-root { container-type: inline-size; box-sizing: border-box; height: 100%; overflow-y: auto; padding: 16px; }
.eb-root *, .eb-root *::before, .eb-root *::after { box-sizing: border-box; }
.eb-title { margin: 0 0 12px 0; }
.eb-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; margin: 0 0 16px 0; }
.eb-branch { font-weight: 600; }
.eb-commit { font-family: monospace; }
.eb-checking { min-width: 0; }
.eb-notice, .eb-error { border: 1px solid currentColor; border-radius: 6px; margin: 0 0 16px 0; padding: 8px 12px; overflow-wrap: anywhere; }
.eb-notice p, .eb-error p { margin: 0; }
.eb-error ul { margin: 8px 0 0 0; padding-left: 20px; }
.eb-columns { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.eb-column { min-width: 0; }
.eb-column-title { display: flex; justify-content: space-between; align-items: baseline; gap: 8px; margin: 0 0 8px 0; padding-bottom: 4px; border-bottom: 1px solid currentColor; }
.eb-count { font-weight: 400; opacity: 0.7; }
.eb-group { min-width: 0; margin: 0 0 12px 0; }
.eb-group-title { margin: 0 0 6px 0; font-size: 0.95em; overflow-wrap: anywhere; }
.eb-cards { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.eb-card { position: relative; min-width: 0; border: 1px solid rgba(128, 128, 128, 0.5); border-radius: 6px; background: rgba(128, 128, 128, 0.1); padding: 8px 12px; overflow-wrap: anywhere; }
.eb-card-name { font-weight: 600; }
.eb-card-description { margin-top: 4px; }
.eb-card-spec { margin-top: 4px; font-family: monospace; font-size: 0.85em; opacity: 0.7; }
.eb-card-progress { margin-top: 4px; font-size: 0.9em; }
.eb-bar { margin-top: 4px; height: 6px; border-radius: 3px; background: rgba(128, 128, 128, 0.3); overflow: hidden; }
.eb-bar-fill { height: 100%; background: currentColor; opacity: 0.6; }
.eb-card-main { all: unset; font-weight: 600; cursor: pointer; overflow-wrap: anywhere; }
.eb-card-main::after { content: ''; position: absolute; inset: 0; border-radius: 6px; }
.eb-card-main:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.eb-card[data-mode='startable']:hover, .eb-card[data-mode='question']:hover, .eb-card[data-mode='blocked']:hover, .eb-card[data-mode='chat']:hover { background: rgba(128, 128, 128, 0.2); }
.eb-card:focus-within { border-color: currentColor; }
.eb-chat-line { margin-top: 6px; }
.eb-chat-state { display: inline-block; border: 1px solid currentColor; border-radius: 10px; padding: 0 8px; font-size: 0.85em; }
.eb-chat-state[data-state='needs-you'] { font-weight: 600; }
.eb-chat-note { margin: 6px 0 0 0; }
.eb-question, .eb-chat-controls { position: relative; z-index: 1; margin-top: 8px; }
.eb-question p, .eb-chat-controls p { margin: 6px 0 0 0; }
.eb-question button, .eb-chat-controls button { font: inherit; cursor: pointer; margin-top: 6px; }
.eb-empty-column { margin: 0; opacity: 0.7; }
.eb-problems { margin-top: 16px; border: 1px solid rgba(128, 128, 128, 0.5); border-radius: 6px; padding: 8px 12px; }
.eb-problems summary { cursor: pointer; }
.eb-problems ul { margin: 8px 0 0 0; padding-left: 20px; }
.eb-problems li { overflow-wrap: anywhere; margin-bottom: 4px; }
@container (min-width: 720px) {
  .eb-columns { grid-template-columns: repeat(3, minmax(0, 1fr)); }
}
@supports not (container-type: inline-size) {
  @media (min-width: 720px) {
    .eb-columns { grid-template-columns: repeat(3, minmax(0, 1fr)); }
  }
}
`

const EMPTY_PLAN_HINT = 'Specs are read from .kiro/specs/ and epics from docs/epics/.'

// What each step of a start says when it fails.
const STEP_TEXT = {
  reserve: 'Could not reserve the chat',
  create: 'Could not create the chat',
  send: 'Could not send the brief',
  save: 'Could not save the chat',
}

const NO_ACTIONS = Object.freeze({
  ask() {}, cancel() {}, start() {}, close() {}, sendBrief() {}, resume() {}, startAgain() {},
})

// The part of a card below its progress that belongs to the chat: the state word, the question,
// or the text and controls of a chat that is restoring or not open. Every text is a literal child.
function renderChatPart(h, card, view, actions) {
  switch (view.mode) {
    case 'chat': {
      const parts = []
      if (view.state) {
        parts.push(h('div', { className: 'eb-chat-line', key: 'state' },
          h('span', { className: 'eb-chat-state', 'data-state': view.state }, view.stateWord)))
      }
      if (view.brief?.kind === 'sending') {
        parts.push(h('p', { className: 'eb-chat-note', role: 'status', key: 'brief' }, 'Sending the brief…'))
      } else if (view.brief?.kind === 'failed') {
        parts.push(h('div', { className: 'eb-chat-controls', key: 'brief' },
          h('p', { className: 'eb-chat-note', role: 'status' }, 'The brief was not sent'),
          view.brief.reason ? h('p', { className: 'eb-chat-note' }, view.brief.reason) : null,
          h('button', { type: 'button', onClick: () => actions.sendBrief(view.key) }, 'Send the brief again')))
      }
      return parts.length > 0 ? parts : null
    }
    case 'restoring':
      return h('p', { className: 'eb-chat-note', role: 'status', key: 'chat' }, 'Restoring chat…')
    case 'not-open':
      return h('div', { className: 'eb-chat-controls', key: 'chat' },
        h('p', { className: 'eb-chat-note', role: 'status' }, 'This chat is not open.'),
        h('button', { type: 'button', onClick: () => actions.resume(view.key) }, 'Resume chat'))
    case 'resuming':
      return h('p', { className: 'eb-chat-note', role: 'status', key: 'chat' }, 'Resuming…')
    case 'resume-failed':
      return h('div', { className: 'eb-chat-controls', key: 'chat' },
        h('p', { className: 'eb-chat-note', role: 'status' }, 'The chat could not be resumed.'),
        view.reason ? h('p', { className: 'eb-chat-note' }, view.reason) : null,
        h('button', { type: 'button', onClick: () => actions.startAgain(view.name, card.id) }, 'Start again'))
    case 'starting':
      return h('p', { className: 'eb-chat-note', role: 'status', key: 'chat' }, 'Starting…')
    case 'question': {
      const onKeyDown = (event) => { if (event?.key === 'Escape') actions.cancel(card.id) }
      return h('div', { className: 'eb-question', role: 'group', 'aria-label': 'Start a conductor', onKeyDown, key: 'chat' },
        view.failure
          ? h('p', { className: 'eb-chat-note', role: 'status' }, `${STEP_TEXT[view.failure.step] ?? 'The start failed'}: ${view.failure.reason}`)
          : null,
        h('p', null, 'Start a conductor on this story?'),
        h('button', { type: 'button', onClick: () => actions.start(card.id) }, 'Start'),
        ' ',
        h('button', { type: 'button', onClick: () => actions.cancel(card.id) }, 'Cancel'))
    }
    case 'blocked': {
      const { blocked } = view
      const onKeyDown = (event) => { if (event?.key === 'Escape') actions.close(card.id) }
      return h('div', { className: 'eb-question', role: 'group', 'aria-label': 'Start a conductor', onKeyDown, key: 'chat' },
        blocked.kind === 'folder'
          ? [
            h('p', { key: 'a' }, 'No Crew folder is set for this project.'),
            blocked.reason ? h('p', { key: 'b' }, blocked.reason) : null,
            h('p', { key: 'c' }, 'Set ', h('code', null, 'EPIC_BOARD_FOLDER'), ' or ', h('code', null, 'folder_id'), ' in config.json.'),
          ]
          : h('p', null, blocked.message),
        h('button', { type: 'button', onClick: () => actions.close(card.id) }, 'Close'))
    }
    default:
      return null
  }
}

function renderCard(h, card, index, view, actions) {
  const progress = progressOf(card)
  // Without the chats state a card has no controls: the board as the board spec drew it.
  const chat = view.chats ? cardViewOf(card, view.chats, view.ui ?? {}) : { mode: 'plain' }
  const main = { className: 'eb-card-main', 'data-card-id': card.id }
  // The card's name is the label of its one main control. It stays a button while the question is open,
  // so a keyboard user's focus is not lost, and it is plain text whenever there is nothing to do.
  let name = card.name
  if (chat.mode === 'startable' || chat.mode === 'question' || chat.mode === 'blocked') {
    name = h('button', { ...main, type: 'button', onClick: () => actions.ask(card.id) }, card.name)
  } else if (chat.mode === 'chat') {
    name = h('a', { ...main, href: chat.href }, card.name)
  }
  return h('li', { className: 'eb-card', 'data-mode': chat.mode, key: index },
    h('div', { className: 'eb-card-name' }, name),
    card.description ? h('div', { className: 'eb-card-description' }, card.description) : null,
    card.spec != null ? h('div', { className: 'eb-card-spec' }, card.spec) : null,
    h('div', { className: 'eb-card-progress' }, progress.text),
    progress.fraction !== null
      ? h('div', { className: 'eb-bar', 'aria-hidden': 'true' },
        h('div', { className: 'eb-bar-fill', style: { width: `${progress.fraction * 100}%` } }))
      : null,
    renderChatPart(h, card, chat, actions))
}

function renderColumn(h, column, view, actions) {
  return h('div', { className: 'eb-column', key: column.key },
    h(`h${TITLE_LEVEL + 1}`, { className: 'eb-column-title' },
      h('span', null, column.title),
      ' ',
      h('span', { className: 'eb-count' }, String(column.count))),
    column.groups.length === 0
      ? h('p', { className: 'eb-empty-column' }, 'Nothing here')
      : column.groups.map((group, index) => h('div', { className: 'eb-group', key: `${group.key}:${index}` },
        h(`h${TITLE_LEVEL + 2}`, { className: 'eb-group-title' }, group.name ?? 'No epic'),
        h('ul', { className: 'eb-cards' }, group.cards.map((card, i) => renderCard(h, card, i, view, actions))))))
}

function renderProblems(h, problems) {
  const summary = problems.length === 1 ? '1 file could not be read' : `${problems.length} files could not be read`
  return h('details', { className: 'eb-problems' },
    h('summary', null, summary),
    h('ul', null, problems.map((problem, index) => h('li', { key: index },
      h('div', null, problem.file),
      h('div', null, problem.reason)))))
}

function renderPlanView(h, view, actions) {
  return [
    h('div', { className: 'eb-header', key: 'header' },
      h('span', { className: 'eb-branch' }, view.branch),
      h('span', { className: 'eb-commit' }, view.commit7),
      h('span', { className: 'eb-age' }, view.ageText),
      h('span', { className: 'eb-checking', style: { visibility: view.refreshing ? 'visible' : 'hidden' } },
        'Checking for updates…')),
    view.failedFetch
      ? h('div', { className: 'eb-notice', role: 'status', key: 'failed-fetch' },
        h('p', null, 'Could not fetch from origin. Showing an earlier copy of the plan.'),
        view.failedFetch.reason ? h('p', null, view.failedFetch.reason) : null,
        h('p', null, view.failedFetch.ageText))
      : null,
    view.unreachableNotice
      ? h('div', { className: 'eb-notice', role: 'status', key: 'unreachable' },
        h('p', null, 'Could not reach the backend. Showing the plan from the last update.'))
      : null,
    view.chats?.failed
      ? h('div', { className: 'eb-notice', role: 'status', key: 'chats-failed' },
        h('p', null, 'Could not read chat status. Showing the last known states.'))
      : null,
    view.empty
      ? h('div', { className: 'eb-empty', key: 'empty' },
        h('p', null, `No specs or epics were found on ${view.branch}.`),
        h('p', null, EMPTY_PLAN_HINT))
      : h('div', { className: 'eb-columns', key: 'columns' }, view.columns.map((column) => renderColumn(h, column, view, actions))),
    view.problems.length > 0 ? renderProblems(h, view.problems) : null,
  ]
}

function renderBody(h, view, actions) {
  switch (view.kind) {
    case 'loading':
      return h('p', { role: 'status' }, 'Loading…')
    case 'unreachable':
      return h('p', { className: 'eb-error', role: 'alert' }, 'Could not reach the backend.')
    case 'error':
      return h('div', { className: 'eb-error', role: 'alert' },
        h('p', null, view.message),
        h('p', null, view.code),
        view.settings.length > 0
          ? h('ul', null, view.settings.map((setting, index) => h('li', { key: index }, h('code', null, setting))))
          : null)
    default:
      return renderPlanView(h, view, actions)
  }
}

// Builds the page for a view (what `viewOf` returns) with h = createElement.
// Pure: no React, no hooks, no `window`. Every plan text is passed as a child.
// A plan view that also carries `chats` (the chats state) and `ui` draws the card controls; `actions`
// are what they call: ask(cardId), cancel(cardId), start(cardId), close(cardId), sendBrief(key), resume(key)
// and startAgain(name, cardId). Each defaults to doing nothing.
export function renderBoard(h, view, actions = {}) {
  return h('div', { className: 'eb-root' },
    h('style', null, STYLE),
    h(`h${TITLE_LEVEL}`, { className: 'eb-title' }, 'Epic Board'),
    renderBody(h, view, { ...NO_ACTIONS, ...actions }))
}

const PLAN_URL = '/apps/epic-board/api/plan'
const BACKEND_BASE = '/apps/epic-board/api'

// The page's own state for the card controls: which card has the question open, the start of each card,
// the resume of each chat, and a request to put focus back on a card's button.
//   {kind: 'ask', cardId}                       open the question there (and close it anywhere else)
//   {kind: 'cancel', cardId}                    close it, forget a failed start, and ask for focus on the card
//   {kind: 'step', cardId, step}                a start is running
//   {kind: 'failed', cardId, step, reason}      a start failed; the question stays open with the failure
//   {kind: 'started', cardId}                   a start worked
//   {kind: 'resuming', key} | {kind: 'resume-failed', key, reason} | {kind: 'resumed', key}
//   {kind: 'brief-sending', key} | {kind: 'brief-failed', key, reason} | {kind: 'brief-sent', key}
export const initialUi = Object.freeze({
  asking: null, flows: Object.freeze({}), resumes: Object.freeze({}), briefs: Object.freeze({}), focus: null,
})

function without(object, key) {
  const { [key]: _gone, ...rest } = object
  return rest
}

export function uiReduce(state, action) {
  switch (action?.kind) {
    case 'ask':
      return { ...state, asking: action.cardId }
    case 'cancel': {
      const flow = state.flows[action.cardId]
      return {
        ...state,
        asking: state.asking === action.cardId ? null : state.asking,
        flows: flow?.kind === 'failed' ? without(state.flows, action.cardId) : state.flows,
        focus: { cardId: action.cardId },
      }
    }
    case 'step':
      return { ...state, flows: { ...state.flows, [action.cardId]: { kind: 'starting', step: action.step } } }
    case 'failed':
      return {
        ...state,
        asking: action.cardId,
        flows: { ...state.flows, [action.cardId]: { kind: 'failed', step: action.step, reason: action.reason } },
      }
    case 'started':
      return {
        ...state,
        asking: state.asking === action.cardId ? null : state.asking,
        flows: without(state.flows, action.cardId),
      }
    case 'resuming':
      return { ...state, resumes: { ...state.resumes, [action.key]: { kind: 'resuming' } } }
    case 'resume-failed':
      return { ...state, resumes: { ...state.resumes, [action.key]: { kind: 'failed', reason: action.reason } } }
    case 'resumed':
      return { ...state, resumes: without(state.resumes, action.key) }
    case 'brief-sending':
      return { ...state, briefs: { ...state.briefs, [action.key]: { kind: 'sending' } } }
    case 'brief-failed':
      return { ...state, briefs: { ...state.briefs, [action.key]: { kind: 'failed', reason: action.reason } } }
    case 'brief-sent':
      return { ...state, briefs: without(state.briefs, action.key) }
    default:
      return state
  }
}

// The app's own backend, through `fetch`. Resolves with the parsed body; a non-2xx answer rejects with an
// error that has `status` and `error` (the body's {code, message}). Like the plan request, it carries no
// credential of its own: the host signs it on its way to the backend.
export function makeBackend(fetchFn) {
  const call = async (method, path, body, init = {}) => {
    const options = { method, credentials: 'same-origin', cache: 'no-store', signal: init.signal }
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' }
      options.body = JSON.stringify(body)
    }
    const response = await fetchFn(BACKEND_BASE + path, options)
    let data = null
    try {
      data = await response.json()
    } catch {
      data = null
    }
    if (!response.ok) throw Object.assign(new Error(`Backend ${response.status}`), { status: response.status, error: data?.error ?? null })
    return data
  }
  return {
    get: (path, init) => call('GET', path, undefined, init),
    post: (path, body, init) => call('POST', path, body, init),
    del: (path, init) => call('DELETE', path, undefined, init),
  }
}

// The host's app client (`useAppApi`), or a hook that gives none when the host has no such module.
function hostApiHook() {
  const sdk = typeof window !== 'undefined' ? window.__kirocrew_modules?.['@kirocrew/app-sdk'] : undefined
  return typeof sdk?.useAppApi === 'function' ? sdk.useAppApi : () => null
}

const NO_CLIENT = 'The host has no app client, so Crew cannot be reached.'

// Builds the page component from the host's React. This is the only function that uses
// hooks. `env` may supply `fetch`, `document`, `setTimeout`, `clearTimeout`, `now` and `useAppApi`
// (tests pass fakes); each one defaults to the global and is looked up inside the effect or the
// component, so importing this module and calling `createBoard` need no `window`.
export function createBoard(React, env = {}) {
  const { useReducer, useEffect, useRef, createElement: h } = React

  return function Board() {
    const [state, dispatch] = useReducer(reduce, initialState)
    const [chats, chatsDispatch] = useReducer(chatsReduce, initialChats)
    const [ui, uiDispatch] = useReducer(uiReduce, initialUi)
    const api = (env.useAppApi ?? hostApiHook())()

    // What the handlers and the chat poller read. Refs, so they always see the latest render.
    const latest = useRef(null)
    if (latest.current === null) {
      // `briefs` holds the text of a brief that was saved but not sent, by chat key, for "Send the brief again";
      // `sending` the keys whose brief is on its way; `timers` the send timers, to clear them on unmount.
      latest.current = { starts: new Set(), briefs: new Map(), sending: new Set(), timers: new Set(), poller: null, alive: true }
    }
    latest.current.chats = chats
    latest.current.api = api

    useEffect(() => {
      const doc = env.document ?? document
      const fetchFn = env.fetch ?? fetch
      const setTimer = env.setTimeout ?? setTimeout
      const clearTimer = env.clearTimeout ?? clearTimeout

      // A GET of the plan route. A body that is not JSON rejects, which the poller counts
      // as a failure.
      const request = async (signal) => {
        const response = await fetchFn(PLAN_URL, {
          method: 'GET',
          credentials: 'same-origin',
          cache: 'no-store',
          signal,
        })
        const body = await response.json()
        return { status: response.status, body }
      }

      const poller = createPoller({
        request,
        hidden: () => doc.hidden,
        setTimer: (fn, ms) => setTimer(fn, ms),
        clearTimer: (handle) => clearTimer(handle),
        onResult: (result) => dispatch(result),
      })
      const onVisibility = () => {
        if (!doc.hidden) poller.visible()
      }
      doc.addEventListener('visibilitychange', onVisibility)
      poller.start()
      return () => {
        poller.stop()
        doc.removeEventListener('visibilitychange', onVisibility)
      }
    }, [])

    // The chat poller: the backend's records and, when there are started chats, their states in Crew.
    useEffect(() => {
      const doc = env.document ?? document
      const fetchFn = env.fetch ?? fetch
      const setTimer = env.setTimeout ?? setTimeout
      const clearTimer = env.clearTimeout ?? clearTimeout
      const now = env.now ?? Date.now
      const backend = makeBackend(fetchFn)
      const gateway = {
        get: (path, init) => (latest.current.api ? latest.current.api.get(path, init) : Promise.reject(new Error(NO_CLIENT))),
        post: (path, ...rest) => (latest.current.api ? latest.current.api.post(path, ...rest) : Promise.reject(new Error(NO_CLIENT))),
      }
      latest.current.backend = backend
      latest.current.gateway = gateway
      latest.current.setTimer = (fn, ms) => {
        const handle = setTimer(() => { latest.current.timers.delete(handle); fn() }, ms)
        latest.current.timers.add(handle)
        return handle
      }
      latest.current.clearTimer = (handle) => {
        latest.current.timers.delete(handle)
        clearTimer(handle)
      }

      const poller = createPoller({
        request: async (signal) => ({
          status: 200,
          body: await readChats({
            backend, gateway, previous: latest.current.chats, now, signal,
            onRecords: (records) => { if (latest.current.alive) chatsDispatch({ kind: 'records', ...records }) },
          }),
        }),
        hidden: () => doc.hidden,
        setTimer: (fn, ms) => setTimer(fn, ms),
        clearTimer: (handle) => clearTimer(handle),
        onResult: (result) => chatsDispatch(result),
        classifyAnswer: classifyChats,
        delay: chatDelay,
      })
      latest.current.poller = poller
      latest.current.alive = true
      const onVisibility = () => {
        if (!doc.hidden) poller.visible()
      }
      doc.addEventListener('visibilitychange', onVisibility)
      poller.start()
      return () => {
        latest.current.alive = false
        latest.current.poller = null
        for (const handle of latest.current.timers) clearTimer(handle)
        latest.current.timers.clear()
        poller.stop()
        doc.removeEventListener('visibilitychange', onVisibility)
      }
    }, [])

    // After Cancel or Close, put focus back on the card's button.
    useEffect(() => {
      if (!ui.focus) return
      const doc = env.document ?? document
      const target = [...doc.querySelectorAll('[data-card-id]')].find((node) => node.getAttribute('data-card-id') === ui.focus.cardId)
      if (target && typeof target.focus === 'function') target.focus()
    }, [ui.focus])

    const refresh = () => latest.current.poller?.visible()
    const live = (fn) => (...args) => { if (latest.current.alive) fn(...args) }
    const ownUi = live(uiDispatch)
    const ownChats = live(chatsDispatch)

    const actions = {
      ask: (cardId) => ownUi({ kind: 'ask', cardId }),
      cancel: (cardId) => ownUi({ kind: 'cancel', cardId }),
      close: (cardId) => ownUi({ kind: 'cancel', cardId }),
      async start(cardId) {
        const { starts, backend, gateway } = latest.current
        if (starts.has(cardId)) return // a start is already running for this card
        starts.add(cardId)
        ownUi({ kind: 'step', cardId, step: 'reserve' })
        try {
          const result = await startStory({
            cardId, backend, gateway,
            setTimer: latest.current.setTimer, clearTimer: latest.current.clearTimer,
            onStep: (step) => { if (step !== 'send') ownUi({ kind: 'step', cardId, step }) },
            // The chat is saved: its link and its state appear now, while the brief is on its way.
            onSaved: (saved) => {
              latest.current.briefs.set(saved.key, saved.brief)
              ownChats({ kind: 'started', record: { card_id: cardId, name: saved.name, key: saved.key } })
              ownUi({ kind: 'started', cardId })
              ownUi({ kind: 'brief-sending', key: saved.key })
              refresh()
            },
          })
          // The brief is sent (Crew accepted it, or 10 seconds passed with no error): forget its text.
          latest.current.briefs.delete(result.key)
          ownUi({ kind: 'brief-sent', key: result.key })
        } catch (error) {
          if (error.saved) {
            // The chat exists and is saved; only the brief was not sent. The card keeps its link.
            ownUi({ kind: 'brief-failed', key: error.saved.key, reason: error.reason ?? String(error?.message ?? error) })
          } else {
            ownUi({ kind: 'failed', cardId, step: error.step ?? 'reserve', reason: error.reason ?? String(error?.message ?? error) })
            if (error.code === 'chat_exists') refresh() // another page started it: read the records again
          }
        } finally {
          starts.delete(cardId)
        }
      },
      async sendBrief(key) {
        const { briefs, sending, gateway } = latest.current
        const brief = briefs.get(key)
        if (brief === undefined || sending.has(key)) return // nothing to send, or a send is already running
        sending.add(key)
        ownUi({ kind: 'brief-sending', key })
        try {
          await retryBrief({ gateway, key, brief, setTimer: latest.current.setTimer, clearTimer: latest.current.clearTimer })
          briefs.delete(key)
          ownUi({ kind: 'brief-sent', key })
          refresh()
        } catch (error) {
          ownUi({ kind: 'brief-failed', key, reason: error.reason ?? String(error?.message ?? error) })
        } finally {
          sending.delete(key)
        }
      },
      async resume(key) {
        ownUi({ kind: 'resuming', key })
        try {
          await resumeChat({ key, gateway: latest.current.gateway })
          ownUi({ kind: 'resumed', key })
          refresh()
        } catch (error) {
          ownUi({ kind: 'resume-failed', key, reason: error.reason ?? String(error?.message ?? error) })
        }
      },
      async startAgain(name, cardId) {
        const record = latest.current.chats.records.find((candidate) => candidate.name === name)
        try {
          await startAgain({ name, backend: latest.current.backend })
          ownChats({ kind: 'removed', name })
          if (record) ownUi({ kind: 'resumed', key: record.key })
          ownUi({ kind: 'ask', cardId })
        } catch (error) {
          if (record) ownUi({ kind: 'resume-failed', key: record.key, reason: error.reason ?? String(error?.message ?? error) })
        }
      },
    }

    return renderBoard(h, { ...viewOf(state), chats, ui }, actions)
  }
}

// The host's React is looked up on first use, so importing this module needs no `window`.
let built = null

export default function EpicBoardPage(props) {
  if (built === null) {
    const React = window.__kirocrew_modules.react
    built = { React, Component: createBoard(React) }
  }
  return built.React.createElement(built.Component, props)
}
