// Epic Board page: a read-only board of the project's specs and epics, read from the
// main branch by the backend. Uses the host's React (looked up on first render). The
// pure parts (data functions, reducer, views, poller, renderBoard) are exported so
// tests can import them under Node without `window`.

// ---- Pure data functions (no `window`, no React) ----

const COLUMNS = [
  { key: 'unplanned', title: 'Unplanned' },
  { key: 'planned', title: 'Planned' },
  { key: 'in progress', title: 'In progress' },
  { key: 'done', title: 'Done' },
]

// The four columns, each with the groups that hold a card of its status.
// Groups and cards keep the plan's order. A card listed under two epics is in
// two groups and counts twice. A group with no epic is named "No epic" and
// keyed "no-epic"; an epic group is keyed by its file name.
// A group's Filter_Key: its epic's file name, or "no-epic". Shared by columnsOf and the filter.
const groupKey = (group) => (group.epic ? group.epic.file : 'no-epic')

export function columnsOf(plan, started = new Set()) {
  const planGroups = Array.isArray(plan?.groups) ? plan.groups : []
  return COLUMNS.map(({ key, title }) => {
    const groups = []
    let count = 0
    for (const group of planGroups) {
      const cards = (group.cards ?? []).filter((card) => {
        const col = (card.status === 'planned' || card.status === 'unplanned') && started.has(card.id) ? 'in progress' : card.status
        return col === key
      })
      if (cards.length === 0) continue
      groups.push({
        key: groupKey(group),
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
    case 'reset':
      return initialState
    default:
      return state
  }
}

// ---- The epic filter ----

export const FILTER_STORAGE_KEY = 'epic-board.filter'

// The dropdown's options: All epics, then one per group that has a card, in the plan's order.
export function filterOptions(plan) {
  const groups = Array.isArray(plan?.groups) ? plan.groups : []
  return [
    { key: 'all', label: 'All epics' },
    ...groups
      .filter((group) => Array.isArray(group.cards) && group.cards.length > 0)
      .map((group) => ({ key: groupKey(group), label: group.epic ? group.epic.name : 'No epic' })),
  ]
}

// The plan narrowed to one group. `all`, or a key no group has, gives the plan itself. Never mutates.
export function filterPlan(plan, key) {
  if (key === 'all' || !Array.isArray(plan?.groups)) return plan
  const groups = plan.groups.filter((group) => groupKey(group) === key)
  return groups.length === 0 ? plan : { ...plan, groups }
}

// The saved choice, or 'all' when there is no storage, the read throws or the value is not text.
export function loadChoice(storage) {
  try {
    const value = storage?.getItem(FILTER_STORAGE_KEY)
    return typeof value === 'string' && value !== '' ? value : 'all'
  } catch {
    return 'all'
  }
}

// ---- Folded columns (one-column layout on a narrow screen) ----

export const FOLD_STORAGE_KEY = 'epic-board.folded'

// In progress starts open; Unplanned, Planned and Done start folded.
export const DEFAULT_FOLDS = Object.freeze({ unplanned: true, planned: true, 'in progress': false, done: true })

// The saved folds of every project, {projectId: {columnKey: true|false}}, or {} when there is no storage,
// the read throws or the value is not an object.
export function loadFolds(storage) {
  try {
    const value = JSON.parse(storage?.getItem(FOLD_STORAGE_KEY) ?? 'null')
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value : {}
  } catch {
    return {}
  }
}

// Saves the folds. Gives false, and throws nothing, when there is no storage or the write fails.
export function saveFolds(storage, folds) {
  try {
    storage.setItem(FOLD_STORAGE_KEY, JSON.stringify(folds))
    return true
  } catch {
    return false
  }
}

// The folds of one project: the defaults, with the saved true/false values on top. Other values are ignored.
export function foldsFor(folds, projectId) {
  const saved = folds?.[projectId ?? ''] ?? {}
  const result = { ...DEFAULT_FOLDS }
  for (const key of Object.keys(DEFAULT_FOLDS)) {
    if (typeof saved[key] === 'boolean') result[key] = saved[key]
  }
  return result
}

// The folds with one column of one project turned over. Never mutates.
export function toggleFold(folds, projectId, columnKey) {
  const id = projectId ?? ''
  const current = foldsFor(folds, id)
  return { ...folds, [id]: { ...current, [columnKey]: !current[columnKey] } }
}

// Saves the choice. Gives false, and throws nothing, when there is no storage or the write fails.
export function saveChoice(storage, key) {
  try {
    storage.setItem(FILTER_STORAGE_KEY, key)
    return true
  } catch {
    return false
  }
}

// What the page shows for a state. `kind` is 'loading', 'unreachable', 'error' or 'plan'.
export function viewOf(state, filterKey = 'all', started = new Set()) {
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
  const options = filterOptions(plan)
  const key = options.some((option) => option.key === filterKey) ? filterKey : 'all'
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
    filter: { key, options },
    columns: empty ? null : columnsOf(filterPlan(plan, key), started),
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

// The states a chat can show. "Session finished" is the person's own mark (the Finish session button), never
// read from Crew: a story is done only when main says so.
// "Review" and "Your turn" are the words for a card whose conductor is waiting for the person; a Review
// badge says "Review #N" or "Checks failed #N" (see `reviewWord`).
export const STATE_WORDS = Object.freeze({
  'needs-you': 'Needs you',
  interrupted: 'Interrupted',
  working: 'Working',
  stalled: 'Stalled',
  review: 'Review',
  'your-turn': 'Your turn',
  finished: 'Session finished',
})

// How long a chat that Crew does not know is "restoring" before the card offers to resume it.
export const RESTORE_MS = 60000
const CHAT_SOON_MS = 5000
const CHAT_LATER_MS = 15000
const AGENT = 'kirocrew-conductor'
// `crew=all` keeps the rows of a conductor's workers, which a person's list leaves out by default.
const CHAT_LIST = '/api/chat/slots?crew=all'

const isFlagged = (row) => row?.pending_approval === true || row?.needs_input === true
const isBusy = (row) => row?.running === true || row?.admission_queued === true

// The rows of a conductor's workers: every row whose `crew_root` or `created_by` is the conductor's key.
// They are used only for the flags of `stateOf`. Nothing else of such a row is ever read.
export function workersOf(list, key) {
  return list.filter((row) => isObject(row) && row.key !== key && (row.crew_root === key || row.created_by === key))
}

// Whether the conductor's ledger has an item gone quiet, by the rule of Crew's `crewWorkCounts`
// (`website/src/lib/crewWork.ts`): no live conductor loop, the item's worker is not running, and its
// `stale_at_ms` has passed.
export function hasStalled(facts, rows, now) {
  if (!isObject(facts) || !Array.isArray(facts.items) || facts.conductor_looping) return false
  const running = new Set(rows.filter((row) => row?.running === true).map((row) => row.key))
  return facts.items.some((item) => {
    if (!isObject(item)) return false
    const at = typeof item.stale_at_ms === 'number' ? item.stale_at_ms : 0
    return !(item.worker && running.has(item.worker)) && at > 0 && now >= at
  })
}

const isHttps = (value) => {
  try { return new URL(value).protocol === 'https:' } catch { return false }
}

// The conductor's open or draft pull request, as {number, url, failed}, or null. Only an https address
// is kept, and `failed` is true when its checks failed. Crew sends `state` and `ci` only to the owner (or
// for a public repository), so a link without a `state` is not counted.
export function reviewOf(row) {
  const links = Array.isArray(row?.source_links) ? row.source_links : []
  for (const link of links) {
    if (!isObject(link) || (link.kind !== undefined && link.kind !== 'change')) continue
    if (link.state !== 'open' && link.state !== 'draft') continue
    if (!Number.isInteger(link.number) || !isHttps(link.url)) continue
    return { number: link.number, url: link.url, failed: link.ci === 'failed' }
  }
  return null
}

// The word of a Review badge.
export const reviewWord = (review) => (review ? `${review.failed ? 'Checks failed' : 'Review'} #${review.number}` : STATE_WORDS.review)

// One state for a conductor's chat, from its row in Crew's chat list, the role of its last row (or
// undefined when that has not been read), the rows of its workers and the time. The first that applies:
//   Needs you   the conductor or a worker waits for an approval or asked a question
//   Interrupted the conductor's turn ended without a reply, or its last row is an error
//   Working     the conductor or a worker is running or queued
//   Stalled     the conductor's ledger has an item gone quiet
//   Review      the conductor has an open or draft pull request
//   Your turn   anything else
// Needs you comes first because a turn that waits for an approval is still running.
export function stateOf(row, lastRole, workers = [], now = 0) {
  const team = [row, ...workers]
  if (team.some(isFlagged)) return 'needs-you'
  if (row?.interrupted === true || (lastRole === 'error' && !isBusy(row))) return 'interrupted'
  if (team.some(isBusy)) return 'working'
  if (hasStalled(row?.crew_work, team, now)) return 'stalled'
  if (reviewOf(row)) return 'review'
  return 'your-turn'
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
  // A finished chat is the person's mark: its state is never read from Crew.
  for (const record of records) if (record.state === 'finished') byKey[record.key] = { state: 'finished' }
  const open = records.filter((record) => record.state !== 'finished')
  if (open.length === 0) return { at: now(), folder, recordsError: null, chats: records, byKey, missingSince }

  const list = await gateway.get(CHAT_LIST, { signal })
  if (!Array.isArray(list)) throw new Error('The chat list is not a list.')
  const ours = new Set(open.map((record) => record.key))
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

  for (const record of open) {
    const key = record.key
    const row = rows.get(key)
    if (row) {
      const workers = workersOf(list, key)
      let role
      let roleRead = false
      // The last row matters only when nothing above Interrupted has decided and the conductor is not running.
      if (![row, ...workers].some(isFlagged) && row.interrupted !== true && !isBusy(row)) {
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
      }
      const state = stateOf(row, role, workers, now())
      byKey[key] = { state, lastTs: row.last_ts, messages: row.messages, role, roleRead }
      if (state === 'review') byKey[key].review = reviewOf(row)
      continue
    }
    const detail = await detailOf(key)
    if (detail === null) {
      markMissing(key)
      continue
    }
    const role = lastRoleOf(detail)
    const state = detail.running === true || detail.admission_queued === true ? 'working' : role === 'error' ? 'interrupted' : 'your-turn'
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
// {kind: 'started', record}, {kind: 'finished', name} and {kind: 'removed', name}. A failed read keeps what is shown.
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
    case 'finished': {
      const record = state.records.find((candidate) => candidate.name === result.name)
      if (!record) return state
      const records = state.records.map((candidate) => (candidate === record ? { ...record, state: 'finished', worktree_path: null } : candidate))
      return { ...state, records, byKey: { ...state.byKey, [record.key]: { state: 'finished' } } }
    }
    case 'removed': {
      const gone = state.records.find((record) => record.name === result.name)
      if (!gone) return state
      const { [gone.key]: _entry, ...byKey } = state.byKey
      const { [gone.key]: _since, ...missingSince } = state.missingSince
      return { ...state, records: state.records.filter((record) => record !== gone), byKey, missingSince }
    }
    case 'reset':
      return initialChats
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
// not-open, resuming, resume-failed, finished. A card can hold a finished record and a started one; the
// started one is shown.
export function cardViewOf(card, chats, ui = {}, nowMs = chats.at) {
  const own = chats.records.filter((candidate) => candidate.card_id === card.id)
  const record = own.find((candidate) => candidate.state !== 'finished') ?? own[0]
  if (record && record.state !== 'finished') {
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
      stateWord: entry ? (entry.state === 'review' ? reviewWord(entry.review) : STATE_WORDS[entry.state]) : null,
      stateHref: entry?.state === 'review' && entry.review ? entry.review.url : null,
      brief: ui.briefs?.[key] ?? null,
      open: ui.open?.key === key,
      cleanup: ui.cleanups?.[record.name] ?? null,
    }
  }
  if (card.status === 'done' && !record) return { mode: 'plain' }
  const flow = ui.flows?.[card.id]
  if (flow?.kind === 'starting') return { mode: 'starting', step: flow.step }
  if (ui.asking !== card.id) return record ? { mode: 'finished', key: record.key, name: record.name, href: chatHref(record.key) } : { mode: 'startable' }
  if (chats.recordsError) return { mode: 'blocked', blocked: { kind: 'records', message: chats.recordsError.message } }
  if (!chats.folder.id) return { mode: 'blocked', blocked: { kind: 'folder', reason: chats.folder.reason } }
  return { mode: 'question', failure: flow?.kind === 'failed' ? { step: flow.step, reason: flow.reason } : null }
}

// Whether a host value is something React can mount as a component: a function, or an object with a
// `$$typeof` (memo, forwardRef).
export function isComponent(value) {
  return typeof value === 'function' || (typeof value === 'object' && value !== null && '$$typeof' in value)
}

export function isChatPanel(value) {
  return isComponent(value)
}

// The components the page may take from the host's `@kirocrew/ui`: the seven it draws with, and the
// Select of the project and epic dropdowns.
const KIT_NAMES = ['Btn', 'Card', 'CardTitle', 'Badge', 'PageHeader', 'EmptyState', 'ErrorNotice', 'Select']

// The entries of `module` that are components, by name. Anything else is left out. Never throws: a
// getter that throws leaves its component out.
export function pickKit(module) {
  const kit = {}
  if (typeof module !== 'object' || module === null) return kit
  for (const name of KIT_NAMES) {
    try {
      if (isComponent(module[name])) kit[name] = module[name]
    } catch {
      // a throwing getter: that component is missing
    }
  }
  return kit
}

// The kit of the host's `@kirocrew/ui`, empty when there is no window or no module. Never throws.
export function hostKit() {
  try {
    return pickKit(typeof window !== 'undefined' ? window.__kirocrew_modules?.['@kirocrew/ui'] : undefined)
  } catch {
    return {}
  }
}

// What the Panel shows, or null: {cardId, key, title}. `title` is the plan card's name, found by id in the
// columns of `view`, or 'Chat' when the plan has no such card now. Null when no chat is open or the host has
// no chat panel.
export function panelViewOf(view, ui, hasPanel) {
  if (!hasPanel || !ui?.open) return null
  const { cardId, key } = ui.open
  for (const column of view?.columns ?? []) {
    for (const group of column.groups ?? []) {
      const found = (group.cards ?? []).find((card) => card.id === cardId)
      if (found) return { cardId, key, title: found.name }
    }
  }
  return { cardId, key, title: 'Chat' }
}

// A click the page takes over: the primary button with no modifier key, and not already handled.
export function isPlainClick(event) {
  return event.button === 0 && !event.ctrlKey && !event.metaKey && !event.shiftKey && !event.altKey && !event.defaultPrevented
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

// The whole start of a story from its card, in four or five steps, each named to `onStep` before it runs:
//   reserve  ask the backend for a name, the brief and the folder id
//   folder   (worktree only) create the Worktree_Folder in Crew; on failure, clean up the backend worktree
//   create   open the chat in Crew (a name the board already created answers with the same chat)
//   save     tell the backend the chat has started, with the key Crew gave it
//   send     send the brief, unless the chat already holds a message, without waiting for the turn
// `cardName` is the story's display name, used as the Worktree_Folder name.
// `onSaved({cardId, name, key, brief})` is called as soon as the chat is saved, before the send, so the card
// can show its link and the chat's state while the brief is on its way. A failure before the save throws a
// StartError and leaves the backend's record `reserved`, so a repeat is safe. A failure of the send throws a
// StartError for the step `send` that carries `saved`: the chat exists and is saved, only the brief is missing.
export async function startStory({
  cardId, cardName = '', backend, gateway, onStep = () => {}, onSaved = () => {},
  setTimer = defaultSetTimer, clearTimer = defaultClearTimer,
}) {
  let step = 'reserve'
  let saved = null
  try {
    onStep(step)
    const reservation = await backend.post('/chats', { card_id: cardId })
    if (typeof reservation?.name !== 'string' || typeof reservation.brief !== 'string' || typeof reservation.folder_id !== 'string') {
      throw new StartError(step, 'The backend answered in a form the page cannot read.')
    }
    let chatFolderId = reservation.folder_id
    let worktreeFolderId = null
    if (typeof reservation.worktree_path === 'string' && reservation.worktree_path !== '') {
      step = 'folder'
      onStep(step)
      let folderResult
      try {
        const suffix = reservation.name.slice(-8)
        const sep = ' · '
        const maxStory = 100 - sep.length - suffix.length
        const storyPart = cardName.slice(0, maxStory)
        const folderName = storyPart ? storyPart + sep + suffix : suffix
        folderResult = await gateway.post('/api/chat/folders', {
          name: folderName,
          project_dir: reservation.worktree_path,
          parent_id: reservation.folder_id,
        })
      } catch (folderError) {
        // Clean up the backend worktree before surfacing the folder error.
        try { await backend.del(`/chats/${encodeURIComponent(reservation.name)}/worktree`) } catch { /* ignore */ }
        throw folderError
      }
      if (typeof folderResult?.id !== 'string' || folderResult.id === '') {
        try { await backend.del(`/chats/${encodeURIComponent(reservation.name)}/worktree`) } catch { /* ignore */ }
        throw new StartError(step, 'Crew answered without a folder id.')
      }
      chatFolderId = folderResult.id
      worktreeFolderId = folderResult.id
    }
    step = 'create'
    onStep(step)
    const row = await gateway.post('/api/chat/slots', { name: reservation.name, agent: AGENT, folder_id: chatFolderId })
    const key = row?.key
    if (typeof key !== 'string' || key === '') throw new StartError(step, 'Crew answered without a chat key.')
    step = 'save'
    onStep(step)
    const startedBody = worktreeFolderId !== null ? { key, worktree_folder_id: worktreeFolderId } : { key }
    await backend.post(`/chats/${encodeURIComponent(reservation.name)}/started`, startedBody)
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

// The one style sheet. A colour is `currentColor`, `inherit` or a host theme token as
// `var(--token, currentColor)`. The only greys of its own, `rgba(128, 128, 128, a)`, sit in
// rules for the fallbacks (the elements marked `eb-fb`), which draw what a missing Crew
// component would. No rule removes the focus indicator.
export const STYLE = `
.eb-root { container-type: inline-size; box-sizing: border-box; height: 100%; overflow-y: auto; padding: 16px; }
.eb-root *, .eb-root *::before, .eb-root *::after { box-sizing: border-box; }
.eb-root.eb-has-header { padding: 0; }
.eb-body { padding: 0 16px 16px 16px; }
@media (min-width: 768px) {
  .eb-body { padding: 0 24px 16px 24px; }
}
.eb-title { margin: 0 0 12px 0; }
.eb-has-header .eb-title { margin: 0; }
.eb-header { display: flex; flex-wrap: wrap; align-items: baseline; gap: 4px 16px; margin: 0 0 16px 0; }
.eb-branch { font-weight: 600; }
.eb-commit { font-family: monospace; }
.eb-checking { min-width: 0; }
.eb-error { border: 1px solid currentColor; border-radius: 6px; margin: 0 0 16px 0; padding: 8px 12px; overflow-wrap: anywhere; }
.eb-notice { border: 1px solid var(--border, currentColor); border-radius: var(--radius-lg, 0); background: var(--bg-elevated, transparent); margin: 0 0 16px 0; padding: 8px 12px; font-size: 13px; overflow-wrap: anywhere; }
.eb-notice-error { border-color: var(--danger, currentColor); background: var(--danger-subtle, transparent); color: var(--danger-text, currentColor); }
.eb-notice p, .eb-error p { margin: 0; }
.eb-error ul { margin: 8px 0 0 0; padding-left: 20px; }
.eb-filters { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; margin: 0 0 16px 0; }
.eb-filter { margin: 0; }
.eb-filter select { font: inherit; padding: 4px 8px; }
.eb-filter [role='combobox'], .eb-filter select { min-width: min(calc(100vw - 32px), calc(var(--eb-select-ch, 0) * 1ch + 64px)); }
.eb-columns { display: grid; grid-template-columns: minmax(0, 1fr); gap: 16px; }
.eb-column { --eb-lane: var(--muted, currentColor); min-width: 0; border: 1px solid var(--border, currentColor); border-radius: var(--radius-md, 0); background: var(--card, transparent); overflow: hidden; }
.eb-column[data-column='in progress'] { --eb-lane: var(--accent, currentColor); }
.eb-column[data-column='done'] { --eb-lane: var(--ok, currentColor); }
.eb-column-title { display: flex; justify-content: space-between; align-items: center; gap: 4px; margin: 0; padding: 8px; border-bottom: 1px solid var(--border, currentColor); background: var(--bg-elevated, transparent); font-size: 11px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }
.eb-dot { flex: none; width: 8px; height: 8px; margin-right: 2px; border-radius: 50%; background: var(--eb-lane, currentColor); }
.eb-column-name { margin-right: auto; color: var(--eb-lane, currentColor); }
.eb-count { font-size: 11px; font-weight: 400; letter-spacing: normal; color: var(--muted, currentColor); }
.eb-column-title { position: relative; }
.eb-fold { all: unset; flex: none; display: inline-flex; align-items: center; justify-content: center; width: 16px; height: 16px; cursor: pointer; color: var(--muted, currentColor); }
.eb-fold::after { content: ''; position: absolute; inset: 0; }
.eb-fold:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.eb-chevron { width: 6px; height: 6px; border-right: 1.5px solid currentColor; border-bottom: 1.5px solid currentColor; transform: translateY(-2px) rotate(45deg); }
.eb-column[data-folded='true'] .eb-chevron { transform: rotate(-45deg); }
.eb-column[data-folded='true'] .eb-column-title { border-bottom: 0; }
.eb-column[data-folded='true'] .eb-column-body { display: none; }
.eb-group { min-width: 0; margin: 0; padding: 6px; }
.eb-group-title { margin: 0 0 6px 0; font-size: 11.5px; font-weight: 600; color: var(--muted, currentColor); overflow-wrap: anywhere; }
.eb-cards { list-style: none; margin: 0; padding: 0; display: grid; gap: 8px; }
.eb-card { position: relative; min-width: 0; margin-bottom: 0; overflow-wrap: anywhere; }
.eb-card.eb-fb { border: 1px solid rgba(128, 128, 128, 0.5); border-radius: 6px; background: rgba(128, 128, 128, 0.1); padding: 8px 12px; }
.eb-card-name { font-weight: 600; }
.eb-card-description { margin-top: 4px; font-size: 13px; display: -webkit-box; -webkit-box-orient: vertical; -webkit-line-clamp: 3; line-clamp: 3; overflow: hidden; }
.eb-card-meta { margin-top: 4px; font-size: 12px; color: var(--muted, currentColor); overflow-wrap: anywhere; }
.eb-card-spec, .eb-folder-dir { margin-top: 4px; font-family: var(--mono, monospace); font-size: 12px; color: var(--muted, currentColor); overflow-wrap: anywhere; }
.eb-card-progress { margin-top: 4px; }
.eb-bar { margin-top: 4px; height: 6px; border-radius: 3px; background: var(--border, transparent); overflow: hidden; }
.eb-bar-fill { height: 100%; background: var(--accent, currentColor); }
.eb-card-main { all: unset; font-weight: 600; cursor: pointer; overflow-wrap: anywhere; }
.eb-card-main::after { content: ''; position: absolute; inset: 0; border-radius: inherit; }
.eb-card-main:focus-visible { outline: 2px solid currentColor; outline-offset: 2px; }
.eb-card[data-mode='startable']:hover, .eb-card[data-mode='question']:hover, .eb-card[data-mode='blocked']:hover, .eb-card[data-mode='chat']:hover { background: var(--bg-hover, transparent); }
.eb-card.eb-fb[data-mode='startable']:hover, .eb-card.eb-fb[data-mode='question']:hover, .eb-card.eb-fb[data-mode='blocked']:hover, .eb-card.eb-fb[data-mode='chat']:hover { background: rgba(128, 128, 128, 0.2); }
.eb-card:focus-within { border-color: currentColor; }
.eb-card[data-open='true'] { border-color: currentColor; box-shadow: 0 0 0 1px currentColor; }
.eb-chat-open { margin-left: 8px; font-size: 12px; color: var(--muted, currentColor); }
.eb-chat-line { margin-top: 6px; }
.eb-chat-state.eb-fb { display: inline-block; border: 1px solid currentColor; border-radius: 10px; padding: 0 8px; font-size: 0.85em; }
.eb-chat-state.eb-fb[data-state='needs-you'] { font-weight: 600; }
.eb-chat-state a { position: relative; z-index: 1; }
.eb-chat-note { margin: 6px 0 0 0; }
.eb-question, .eb-chat-controls { position: relative; z-index: 1; margin-top: 8px; }
/* Crew's Card has the class card-glow, whose rule '.card-glow > * { position: relative; z-index: 1 }' makes every
   child of the card its own positioned box. The stretched link would then cover only the title. Inside a card the
   children stay static, so the link covers the whole card, and the card's own controls stay above it. */
.eb-root .eb-card > * { position: static; z-index: auto; }
.eb-root .eb-card > .eb-question, .eb-root .eb-card > .eb-chat-controls { position: relative; z-index: 1; }
.eb-question p, .eb-chat-controls p { margin: 6px 0 0 0; }
.eb-question button, .eb-chat-controls button { margin-top: 6px; }
.eb-question button.eb-fb, .eb-chat-controls button.eb-fb { font: inherit; cursor: pointer; }
.eb-setup { padding: 8px; }
.eb-setup ul { margin: 0; padding: 0; }
.eb-folder { list-style: none; margin: 0; padding: 8px 0; border-bottom: 1px solid var(--border, currentColor); }
.eb-folder-label { display: flex; align-items: center; gap: 6px; }
.eb-folder-label input { margin: 0; accent-color: var(--accent, currentColor); }
.eb-folder-name { display: block; width: 100%; margin-top: 6px; font: inherit; }
.eb-worktree-label { display: flex; align-items: center; gap: 6px; margin-top: 6px; font-size: 13px; }
.eb-worktree-label input { margin: 0; accent-color: var(--accent, currentColor); }
.eb-setup-actions { display: flex; gap: 8px; margin-top: 12px; }
.eb-empty-column { margin: 0; padding: 6px; color: var(--muted, currentColor); }
.eb-problems { margin-top: 16px; border: 1px solid var(--border, currentColor); border-radius: var(--radius-md, 0); padding: 8px 12px; }
.eb-problems summary { cursor: pointer; }
.eb-problems ul { margin: 8px 0 0 0; padding-left: 20px; }
.eb-problems li { overflow-wrap: anywhere; margin-bottom: 4px; }
@container (min-width: 720px) {
  .eb-columns { grid-template-columns: repeat(4, minmax(0, 1fr)); }
  .eb-fold { display: none; }
  .eb-column[data-folded='true'] .eb-column-title { border-bottom: 1px solid var(--border, currentColor); }
  .eb-column[data-folded='true'] .eb-column-body { display: block; }
}
@supports not (container-type: inline-size) {
  @media (min-width: 720px) {
    .eb-columns { grid-template-columns: repeat(4, minmax(0, 1fr)); }
    .eb-fold { display: none; }
    .eb-column[data-folded='true'] .eb-column-title { border-bottom: 1px solid var(--border, currentColor); }
    .eb-column[data-folded='true'] .eb-column-body { display: block; }
  }
}
.eb-shell { container: eb-shell / inline-size; height: 100%; }
.eb-split { position: relative; height: 100%; }
.eb-panel { display: flex; flex-direction: column; min-width: 0; min-height: 0; height: 100%; background: var(--bg, transparent); }
.eb-panel-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; padding: 0 8px; min-height: 40px; background: var(--bg-elevated, transparent); border-bottom: 1px solid var(--border, currentColor); }
.eb-panel-title { font-size: 11.5px; font-weight: 600; overflow-wrap: anywhere; }
.eb-panel-head button.eb-fb { font: inherit; cursor: pointer; }
.eb-panel-body { flex: 1 1 0; min-height: 0; }
.eb-shell[data-panel='open'] .eb-panel { position: absolute; inset: 0; }
.eb-shell[data-panel='open'] .eb-root { visibility: hidden; }
@container eb-shell (min-width: 1000px) {
  .eb-shell[data-panel='open'] .eb-split { display: flex; }
  .eb-shell[data-panel='open'] .eb-root { visibility: visible; flex: 1 1 0; min-width: 0; }
  .eb-shell[data-panel='open'] .eb-panel { position: static; flex: 0 0 clamp(380px, 40%, 640px); border-left: 1px solid var(--border, currentColor); }
}
@supports not (container-type: inline-size) {
  @media (min-width: 1000px) {
    .eb-shell[data-panel='open'] .eb-split { display: flex; }
    .eb-shell[data-panel='open'] .eb-root { visibility: visible; flex: 1 1 0; min-width: 0; }
    .eb-shell[data-panel='open'] .eb-panel { position: static; flex: 0 0 clamp(380px, 40%, 640px); border-left: 1px solid var(--border, currentColor); }
  }
}
`

const EMPTY_PLAN_HINT = 'Specs are read from .kiro/specs/ and epics from docs/epics/.'

// ---- Projects: list, choice and query ----

export const PROJECT_STORAGE_KEY = 'epic-board.project'
const ID_PATTERN = /^[a-z0-9-]{1,64}$/

// The Project_List from a `GET /projects` body, or null when it is not a list of valid {id, name} pairs.
export function readProjects(body) {
  if (!Array.isArray(body)) return null
  const ids = new Set()
  const result = []
  for (const item of body) {
    if (item === null || typeof item !== 'object' || Array.isArray(item)) return null
    if (typeof item.id !== 'string' || typeof item.name !== 'string') return null
    if (!ID_PATTERN.test(item.id) || ids.has(item.id)) return null
    ids.add(item.id)
    result.push({ id: item.id, name: item.name, worktree: item.worktree !== false })
  }
  return result
}

// The project to show: the saved one when it is in the list, else the first. null for an empty list.
export function resolveProject(projects, savedId) {
  if (!Array.isArray(projects) || projects.length === 0) return null
  if (typeof savedId === 'string') {
    const found = projects.find((p) => p.id === savedId)
    if (found) return found
  }
  return projects[0]
}

// The dropdown options when there are 2 or more projects, else null.
export function projectOptions(projects) {
  if (!Array.isArray(projects) || projects.length < 2) return null
  return projects.map((p) => ({ key: p.id, label: p.name }))
}

// The saved Project_Id, or null when nothing is saved, the storage is absent or throws.
export function loadProject(storage) {
  try {
    const value = storage?.getItem(PROJECT_STORAGE_KEY)
    return typeof value === 'string' && value !== '' ? value : null
  } catch {
    return null
  }
}

// Saves the Project_Id. Returns false when the storage is absent or the write throws.
export function saveProject(storage, id) {
  try {
    storage.setItem(PROJECT_STORAGE_KEY, id)
    return true
  } catch {
    return false
  }
}

// The query string for a project id, or '' when id is null/undefined.
export function projectQuery(id) {
  if (id == null) return ''
  return '?project=' + encodeURIComponent(id)
}

// The projects state. `phase` is 'loading' | 'ready' | 'failed'; `projects` is null until ready.
export const initialProjects = Object.freeze({ phase: 'loading', projects: null, currentId: null })

export function projectsReduce(state, action) {
  switch (action?.kind) {
    case 'projects-read': {
      const project = resolveProject(action.projects, action.savedId)
      return { phase: 'ready', projects: action.projects, currentId: project?.id ?? null }
    }
    case 'projects-failed':
      return { ...state, phase: 'failed' }
    case 'switch': {
      if (!state.projects?.some((p) => p.id === action.id)) return state
      if (state.currentId === action.id) return state
      return { ...state, currentId: action.id }
    }
    default:
      return state
  }
}

// ---- Setup: folders, state and reducer ----

// Builds a Selectable_Folder list from a GET /api/chat/folders body.
// Returns null for a non-array body; otherwise returns [{id, name, project_dir}] after applying
// the three folder rules: nearest-wins parent resolution, system-folder exclusion, no-directory exclusion.
// `worktreeFolderIds` are the ids the backend reports for the worktree folders the board made. Crew does not
// set owner_app on them, so they are left out here by id.
export function readFolders(body, worktreeFolderIds = []) {
  if (!Array.isArray(body)) return null
  const made = new Set(Array.isArray(worktreeFolderIds) ? worktreeFolderIds : [])
  const byId = new Map()
  for (const item of body) {
    if (item && typeof item.id === 'string') byId.set(item.id, item)
  }
  const SYSTEM = (item) =>
    item.hidden === true ||
    (typeof item.owner_app === 'string' && item.owner_app !== '') ||
    item.mate_home === true
  const result = []
  for (const item of body) {
    if (typeof item?.id !== 'string' || typeof item?.name !== 'string') continue
    if (SYSTEM(item) || made.has(item.id)) continue
    // Walk parent_id chain to find nearest directory (up to 20 hops to guard against cycles).
    let dir = item.project_dir ?? null
    if (!dir) {
      let cur = item
      for (let hop = 0; hop < 20 && cur; hop++) {
        if (!cur.parent_id) break
        const parent = byId.get(cur.parent_id)
        if (!parent || SYSTEM(parent)) break
        if (parent.project_dir) { dir = parent.project_dir; break }
        cur = parent
      }
    }
    if (!dir) continue
    result.push({ id: item.id, name: item.name, project_dir: dir })
  }
  return result
}

export const initialSetup = Object.freeze({
  phase: 'closed', folders: null, setupInfo: null, checks: {}, names: {}, worktrees: {}, saveError: null,
})

export function setupReduce(state, action) {
  switch (action?.kind ?? action) {
    case 'setup-open':
      return { ...initialSetup, phase: 'opening' }
    case 'setup-loaded': {
      const { folders, setupInfo } = action
      const checks = {}, names = {}, worktrees = {}
      for (const folder of folders ?? []) {
        const match = setupInfo?.projects?.find((p) => p.folder_id === folder.id)
        checks[folder.id] = !!match
        names[folder.id] = match ? match.name : ''
        worktrees[folder.id] = match ? match.worktree !== false : true
      }
      return { ...state, phase: 'ready', folders, setupInfo, checks, names, worktrees, saveError: null }
    }
    case 'setup-load-failed':
      return { ...state, phase: 'error', saveError: action.message }
    case 'setup-check': {
      const checks = { ...state.checks, [action.folderId]: action.checked }
      // A folder ticked for the first time gets its own name, as the set-up-projects spec says (Req 4).
      const folder = state.folders?.find((f) => f.id === action.folderId)
      const names = action.checked && folder && !(state.names[action.folderId] ?? '').trim()
        ? { ...state.names, [action.folderId]: folder.name } : state.names
      return { ...state, checks, names }
    }
    case 'setup-name':
      return { ...state, names: { ...state.names, [action.folderId]: action.value } }
    case 'setup-worktree':
      return { ...state, worktrees: { ...state.worktrees, [action.folderId]: action.value } }
    case 'setup-saving':
      return { ...state, phase: 'saving', saveError: null }
    case 'setup-save-failed':
      return { ...state, phase: 'ready', saveError: action.message }
    case 'setup-close':
      return initialSetup
    default:
      return state
  }
}

// What each step of a start says when it fails.
// The note the page posts into a chat when its card is finished. A statement for the person reading the
// chat: it asks the agent for nothing.
export const FINISH_NOTE = 'This session is finished and its working folder was removed. '
  + 'For more work on this story, use Restart session on its card in Epic Board to open a new chat.'
// The same note for a session that never had a worktree: no folder was removed, so it does not say so.
export const FINISH_NOTE_PLAIN = 'This session is finished. '
  + 'For more work on this story, use Restart session on its card in Epic Board to open a new chat.'

const STEP_TEXT = {
  reserve: 'Could not reserve the chat',
  folder: 'Could not create worktree folder',
  create: 'Could not create the chat',
  send: 'Could not send the brief',
  save: 'Could not save the chat',
}

const NO_ACTIONS = Object.freeze({
  ask() {}, cancel() {}, start() {}, close() {}, sendBrief() {}, resume() {}, startAgain() {}, filter() {}, openChat() {}, switchProject() {},
  removeWorktree() {}, finish() {}, finishAsk() {}, finishCancel() {},
})

// A button: the host's Btn (`primary` for the main action only), or a native button marked as a fallback.
function renderButton(h, Btn, props, text, primary = false) {
  return Btn
    ? h(Btn, primary ? { ...props, primary: true } : props, text)
    : h('button', { ...props, className: 'eb-fb' }, text)
}

// The Badge variant of each chat state; a Review badge for failed checks is `err`.
const STATE_VARIANT = Object.freeze({
  'needs-you': 'warn', interrupted: 'err', working: 'ok', stalled: 'warn', review: 'muted', 'your-turn': 'muted',
  finished: 'muted',
})

// The modes of a card whose chat is started and not finished: each shows the Finish control.
const FINISHABLE = new Set(['chat', 'restoring', 'not-open', 'resuming', 'resume-failed'])

// The Finish control of a started card. `finish` is {name, path, kept, run, asking}: the record's name and
// worktree path, the "Worktree kept" refusal if any, the run of Finish if any, and whether the confirm
// step is open.
function renderFinish(h, card, actions, parts, finish) {
  const { Btn } = parts
  const { name, path, kept, run, asking } = finish
  if (kept) {
    return h('div', { className: 'eb-chat-controls', key: 'finish' },
      h('p', { role: 'status', className: 'eb-chat-note' }, `Worktree kept: ${kept.reason || `uncommitted changes at ${path}.`}`),
      renderButton(h, Btn, { type: 'button', onClick: () => actions.removeWorktree(name, true) }, 'Remove anyway'))
  }
  if (run?.kind === 'running') return h('p', { className: 'eb-chat-note', role: 'status', key: 'finish' }, 'Finishing…')
  if (asking) {
    const onKeyDown = (event) => { if (event?.key === 'Escape') actions.finishCancel(card.id) }
    const unticked = isObject(card.tasks) && card.tasks.done < card.tasks.total
    return h('div', { className: 'eb-question', role: 'group', 'aria-label': 'Finish this session', onKeyDown, key: 'finish' },
      h('p', null, path
        ? `This removes the folder ${path}. Files that git ignores in it, such as .env and node_modules, are deleted with it.`
        : 'This marks the session finished. No folder is touched.'),
      unticked ? h('p', null, 'Not all tasks are ticked on main.') : null,
      renderButton(h, Btn, { type: 'button', 'data-eb-finish': card.id, onClick: () => actions.finish(name, false) }, 'Finish session', true),
      ' ',
      renderButton(h, Btn, { type: 'button', onClick: () => actions.finishCancel(card.id) }, 'Cancel'))
  }
  return h('div', { className: 'eb-chat-controls', key: 'finish' },
    run?.kind === 'failed' ? h('p', { className: 'eb-chat-note', role: 'status' }, `Could not finish: ${run.reason}`) : null,
    renderButton(h, Btn, { type: 'button', onClick: () => actions.finishAsk(card.id) }, 'Finish session'))
}

// The part of a card below its progress that belongs to the chat: the state word, the question,
// or the text and controls of a chat that is restoring or not open. Every text is a literal child.
function renderChatPart(h, card, view, actions, parts = {}, projectWorktree = true, finish = null) {
  const body = renderChatBody(h, card, view, actions, parts, projectWorktree)
  return finish ? [].concat(body ?? [], renderFinish(h, card, actions, parts, finish)) : body
}

function renderChatBody(h, card, view, actions, parts, projectWorktree) {
  const { Btn, Badge } = parts
  switch (view.mode) {
    case 'finished': {
      const badge = Badge
        ? h(Badge, { variant: STATE_VARIANT.finished, className: 'eb-chat-state', 'data-state': 'finished' }, STATE_WORDS.finished)
        : h('span', { className: 'eb-chat-state eb-fb', 'data-state': 'finished' }, STATE_WORDS.finished)
      return h('div', { className: 'eb-chat-controls', key: 'chat' },
        h('div', { className: 'eb-chat-line' }, badge),
        renderButton(h, Btn, { type: 'button', onClick: () => actions.ask(card.id) }, 'Restart session'))
    }
    case 'chat': {
      const chat = []
      if (view.state || view.open) {
        const word = view.stateHref
          ? h('a', { href: view.stateHref, target: '_blank', rel: 'noopener noreferrer' }, view.stateWord)
          : view.stateWord
        const variant = view.state === 'review' && /^Checks failed/.test(view.stateWord ?? '') ? 'err' : STATE_VARIANT[view.state]
        chat.push(h('div', { className: 'eb-chat-line', key: 'state' },
          view.state
            ? (Badge
              ? h(Badge, { variant, className: 'eb-chat-state', 'data-state': view.state }, word)
              : h('span', { className: 'eb-chat-state eb-fb', 'data-state': view.state }, word))
            : null,
          view.open ? h('span', { className: 'eb-chat-open' }, 'Chat open') : null))
      }
      if (view.brief?.kind === 'sending') {
        chat.push(h('p', { className: 'eb-chat-note', role: 'status', key: 'brief' }, 'Sending the brief…'))
      } else if (view.brief?.kind === 'failed') {
        chat.push(h('div', { className: 'eb-chat-controls', key: 'brief' },
          h('p', { className: 'eb-chat-note', role: 'status' }, 'The brief was not sent'),
          view.brief.reason ? h('p', { className: 'eb-chat-note' }, view.brief.reason) : null,
          renderButton(h, Btn, { type: 'button', onClick: () => actions.sendBrief(view.key) }, 'Send the brief again')))
      }
      return chat.length > 0 ? chat : null
    }
    case 'restoring':
      return h('p', { className: 'eb-chat-note', role: 'status', key: 'chat' }, 'Restoring chat…')
    case 'not-open':
      return h('div', { className: 'eb-chat-controls', key: 'chat' },
        h('p', { className: 'eb-chat-note', role: 'status' }, 'This chat is not open.'),
        renderButton(h, Btn, { type: 'button', onClick: () => actions.resume(view.key) }, 'Resume chat'))
    case 'resuming':
      return h('p', { className: 'eb-chat-note', role: 'status', key: 'chat' }, 'Resuming…')
    case 'resume-failed':
      return h('div', { className: 'eb-chat-controls', key: 'chat' },
        h('p', { className: 'eb-chat-note', role: 'status' }, 'The chat could not be resumed.'),
        view.reason ? h('p', { className: 'eb-chat-note' }, view.reason) : null,
        renderButton(h, Btn, { type: 'button', onClick: () => actions.startAgain(view.name, card.id) }, 'Start again'))
    case 'starting':
      return h('p', { className: 'eb-chat-note', role: 'status', key: 'chat' }, 'Starting…')
    case 'question': {
      const onKeyDown = (event) => { if (event?.key === 'Escape') actions.cancel(card.id) }
      return h('div', { className: 'eb-question', role: 'group', 'aria-label': 'Start a conductor', onKeyDown, key: 'chat' },
        view.failure
          ? h('p', { className: 'eb-chat-note', role: 'status' }, `${STEP_TEXT[view.failure.step] ?? 'The start failed'}: ${view.failure.reason}`)
          : null,
        h('p', null, 'Start a conductor on this story?'),
        h('p', { className: 'eb-card-meta' }, projectWorktree ? 'Works in its own worktree' : 'Works in the shared checkout'),
        renderButton(h, Btn, { type: 'button', 'data-eb-start': card.id, onClick: () => actions.start(card.id, card.name) }, 'Start', true),
        ' ',
        renderButton(h, Btn, { type: 'button', onClick: () => actions.cancel(card.id) }, 'Cancel'))
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
        renderButton(h, Btn, { type: 'button', onClick: () => actions.close(card.id) }, 'Close'))
    }
    default:
      return null
  }
}

function renderCard(h, card, index, view, actions, parts = {}) {
  const progress = progressOf(card)
  // Without the chats state a card has no controls: the board as the board spec drew it.
  const seen = view.chats ? cardViewOf(card, view.chats, view.ui ?? {}) : { mode: 'plain' }
  // A host with no chat panel shows no Panel, so no card is marked.
  const chat = seen.open && !view.panelAvailable ? { ...seen, open: false } : seen
  // Finish belongs to a card whose chat is started and not finished.
  const record = view.chats && FINISHABLE.has(chat.mode)
    ? view.chats.records.find((r) => r.card_id === card.id && r.state === 'started') : null
  const cleanup = record ? view.ui?.cleanups?.[record.name] : null
  const finish = record ? {
    name: record.name, path: record.worktree_path || null, kept: cleanup?.kind === 'kept' ? cleanup : null,
    run: view.ui?.finishes?.[record.name] ?? null, asking: view.ui?.finishing === card.id,
  } : null
  const main = { className: 'eb-card-main', 'data-card-id': card.id }
  // The card's name is the label of its one main control. It stays a button while the question is open,
  // so a keyboard user's focus is not lost, and it is plain text whenever there is nothing to do.
  let name = card.name
  if (chat.mode === 'startable' || chat.mode === 'question' || chat.mode === 'blocked') {
    name = h('button', { ...main, type: 'button', onClick: () => actions.ask(card.id) }, card.name)
  } else if (chat.mode === 'chat' || chat.mode === 'finished') {
    name = h('a', {
      ...main,
      href: chat.href,
      ...(chat.open ? { 'aria-current': 'true' } : {}),
      onClick: (event) => {
        if (!view.panelAvailable || !isPlainClick(event)) return // the browser follows the link
        event.preventDefault()
        actions.openChat({ cardId: card.id, key: chat.key })
      },
    }, card.name)
  }
  const children = [
    parts.CardTitle
      ? h(parts.CardTitle, { className: 'eb-card-name', role: 'presentation' }, name)
      : h('div', { className: 'eb-card-name' }, name),
    card.description ? h('div', { className: 'eb-card-description' }, card.description) : null,
    card.spec != null ? h('div', { className: 'eb-card-spec' }, card.spec) : null,
    progress.fraction !== null && parts.Badge
      ? h('div', { className: 'eb-card-progress' },
        h(parts.Badge, { variant: progress.fraction === 1 ? 'ok' : 'muted', className: 'eb-progress' }, progress.text))
      : h('div', { className: 'eb-card-progress eb-card-meta' }, progress.text),
    progress.fraction !== null
      ? h('div', { className: 'eb-bar', 'aria-hidden': 'true' },
        h('div', { className: 'eb-bar-fill', style: { width: `${progress.fraction * 100}%` } }))
      : null,
    renderChatPart(h, card, chat, actions, parts, view.projectWorktree ?? true, finish),
  ]
  const marks = { 'data-mode': chat.mode, ...(chat.open ? { 'data-open': 'true' } : {}) }
  return parts.Card
    ? h('li', { className: 'eb-item', key: index }, h(parts.Card, { className: 'eb-card', ...marks }, ...children))
    : h('li', { className: 'eb-card eb-fb', ...marks, key: index }, ...children)
}

// A column. In the one-column layout its heading holds a button that folds or unfolds its cards; the style
// sheet hides the button, and shows every column, once the columns sit side by side.
function renderColumn(h, column, view, actions, parts = {}) {
  const folded = view.folded?.[column.key] === true
  const bodyId = `eb-column-${column.key.replace(/[^a-z]+/g, '-')}`
  return h('div', { className: 'eb-column', 'data-column': column.key, 'data-folded': folded ? 'true' : 'false', key: column.key },
    h(`h${TITLE_LEVEL + 1}`, { className: 'eb-column-title' },
      h('span', { className: 'eb-dot', 'aria-hidden': 'true' }),
      h('span', { className: 'eb-column-name' }, column.title),
      ' ',
      h('span', { className: 'eb-count' }, String(column.count)),
      h('button', {
        type: 'button',
        className: 'eb-fold',
        'aria-expanded': folded ? 'false' : 'true',
        'aria-controls': bodyId,
        'aria-label': column.title,
        onClick: () => actions.toggleColumn?.(column.key),
      }, h('span', { className: 'eb-chevron', 'aria-hidden': 'true' }))),
    h('div', { className: 'eb-column-body', id: bodyId },
      column.groups.length === 0
        ? h('p', { className: 'eb-empty-column' }, 'Nothing here')
        : column.groups.map((group, index) => h('div', { className: 'eb-group', key: `${group.key}:${index}` },
          h(`h${TITLE_LEVEL + 2}`, { className: 'eb-group-title' }, group.name ?? 'No epic'),
          h('ul', { className: 'eb-cards' }, group.cards.map((card, i) => renderCard(h, card, i, view, actions, parts)))))))
}

function renderProblems(h, problems) {
  const summary = problems.length === 1 ? '1 file could not be read' : `${problems.length} files could not be read`
  return h('details', { className: 'eb-problems' },
    h('summary', null, summary),
    h('ul', null, problems.map((problem, index) => h('li', { key: index },
      h('div', null, problem.file),
      h('div', null, problem.reason)))))
}

// One dropdown, the host's Select when there is one, else a native select, in its own `div.eb-filter`.
// Crew's Select (kirocrew-ui/Select.tsx, 0.12.2): `options` are the values as strings, `optionLabels` the
// labels in the same order, and `onChange` receives the chosen value. `options` here is [{key, label}].
// Crew's list is exactly as wide as its trigger, so the trigger is made at least as wide as the longest
// label (`--eb-select-ch`, in characters), and the list does not squeeze its options while a short one
// such as "All epics" is chosen.
function renderDropdown(h, Select, { key, label, value, options, choose }) {
  const longest = options.reduce((most, option) => Math.max(most, String(option.label ?? '').length), 0)
  const control = Select
    ? h(Select, {
      'aria-label': label,
      value,
      options: options.map((option) => option.key),
      optionLabels: options.map((option) => option.label),
      onChange: choose,
    })
    : h('select', {
      className: 'eb-fb',
      'aria-label': label,
      value,
      onChange: (event) => choose(event.target.value),
    }, options.map((option) => h('option', { key: option.key, value: option.key }, option.label)))
  return h('div', { className: 'eb-filter', key, style: { '--eb-select-ch': String(longest) } }, control)
}

// The project dropdown, named "Project". `view` is {options: [{key, label}], currentId}.
function renderProjects(h, view, actions, Select) {
  return renderDropdown(h, Select, {
    key: 'project', label: 'Project', value: view.currentId, options: view.options, choose: (value) => actions.switchProject(value),
  })
}

// The epic dropdown, named "Epic".
function renderFilter(h, filter, actions, Select) {
  return renderDropdown(h, Select, {
    key: 'filter', label: 'Epic', value: filter.key, options: filter.options, choose: (value) => actions.filter(value),
  })
}

// The project and epic dropdowns together in one flex row; null when neither applies.
function renderFilters(h, view, actions, parts) {
  const projectEl = view.projects ? renderProjects(h, view.projects, actions, parts.Select) : null
  const epicEl = view.empty || !view.filter ? null : renderFilter(h, view.filter, actions, parts.Select)
  if (!projectEl && !epicEl) return null
  return h('div', { className: 'eb-filters', key: 'filters' }, projectEl, epicEl)
}

// The "Checking for updates…" text: always in the page, hidden while nothing is refreshing, so the layout does not move.
const renderChecking = (h, view) =>
  h('span', { className: 'eb-checking', style: { visibility: view.refreshing ? 'visible' : 'hidden' }, key: 'checking' }, 'Checking for updates…')

// The header's "Projects" button: a plain Btn, or a native button. It is in the plan view only.
function renderProjectsButton(h, view, actions, Btn) {
  const props = {
    type: 'button',
    'data-eb-setup-btn': 'true',
    'aria-expanded': view.setupState?.phase !== 'closed' ? 'true' : 'false',
    onClick: () => actions.openSetup?.(),
    key: 'setup-btn',
  }
  return Btn ? h(Btn, props, 'Projects') : h('button', { ...props, className: 'eb-fb' }, 'Projects')
}

function renderEmpty(h, view, EmptyState) {
  const title = `No specs or epics were found on ${view.branch}.`
  return EmptyState
    ? h(EmptyState, { title, subtitle: EMPTY_PLAN_HINT, ...(view.icon ? { icon: view.icon } : {}), key: 'empty' })
    : h('div', { className: 'eb-empty', key: 'empty' }, h('p', null, title), h('p', null, EMPTY_PLAN_HINT))
}

function renderPlanView(h, view, actions, parts = {}) {
  return [
    // With PageHeader the header is drawn by `renderBoard`.
    parts.PageHeader
      ? null
      : h('div', { className: 'eb-header', key: 'header' },
        h('span', { className: 'eb-branch' }, view.branch),
        h('span', { className: 'eb-commit' }, view.commit7),
        h('span', { className: 'eb-age' }, view.ageText),
        renderChecking(h, view),
        renderProjectsButton(h, view, actions, parts.Btn)),
    renderFilters(h, view, actions, parts),
    view.projectsNotice ? h('div', { className: 'eb-notice', role: 'status', key: 'projects-notice' }, h('p', null, 'Could not read the list of projects.')) : null,
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
      ? renderEmpty(h, view, parts.EmptyState)
      : h('div', { className: 'eb-columns', key: 'columns' }, view.columns.map((column) => renderColumn(h, column, view, actions, parts))),
    view.problems.length > 0 ? renderProblems(h, view.problems) : null,
  ]
}

// The backend's error: its message, then its code and the `settings` entries as code text.
function renderBackendError(h, view, ErrorNotice) {
  const code = h('p', null, view.code)
  const settings = view.settings.length > 0
    ? h('ul', null, view.settings.map((setting, index) => h('li', { key: index }, h('code', null, setting))))
    : null
  return ErrorNotice
    ? h(ErrorNotice, { message: view.message, footer: h('div', null, code, settings), key: 'error' })
    : h('div', { className: 'eb-error', role: 'alert', key: 'error' }, h('p', null, view.message), code, settings)
}

function renderBody(h, view, actions, parts) {
  if (view.unconfigured) {
    const setupProps = {
      type: 'button',
      'aria-label': 'Set up projects',
      'aria-expanded': view.setupState?.phase !== 'closed' ? 'true' : 'false',
      onClick: () => actions.openSetup?.(),
    }
    return h('div', { className: 'eb-notice', role: 'status', key: 'unconfigured' },
      h('p', null, 'Choose your projects'),
      parts.Btn
        ? h(parts.Btn, { ...setupProps, primary: true }, 'Set up projects')
        : h('button', { ...setupProps, className: 'eb-fb' }, 'Set up projects'))
  }
  const projectsBar = view.projects
    ? h('div', { className: 'eb-filters', key: 'filters' }, renderProjects(h, view.projects, actions, parts.Select))
    : null
  const projectsNoticeEl = view.projectsNotice
    ? h('div', { className: 'eb-notice', role: 'status', key: 'projects-notice' }, h('p', null, 'Could not read the list of projects.'))
    : null
  switch (view.kind) {
    case 'loading':
      return h('p', { role: 'status' }, 'Loading…')
    case 'unreachable':
      return [
        projectsBar,
        projectsNoticeEl,
        parts.ErrorNotice
          ? h(parts.ErrorNotice, { message: 'Could not reach the backend.', key: 'error' })
          : h('p', { className: 'eb-error', role: 'alert', key: 'error' }, 'Could not reach the backend.'),
      ]
    case 'error':
      return [
        projectsBar,
        projectsNoticeEl,
        renderBackendError(h, view, parts.ErrorNotice),
      ]
    default:
      return renderPlanView(h, view, actions, parts)
  }
}

// The setup overlay: rendered when setupState.phase is not 'closed'.
export function renderSetupView(h, setupState, actions, kit = {}) {
  if (setupState.phase === 'closed') return null
  const { Btn } = kit

  if (setupState.phase === 'opening') {
    return h('div', { className: 'eb-setup' },
      h('p', { role: 'status' }, 'Loading…'),
      renderButton(h, Btn, { type: 'button', onClick: () => actions.closeSetup?.() }, 'Close'))
  }

  if (setupState.phase === 'error') {
    return h('div', { className: 'eb-setup' },
      h('p', { className: 'eb-notice eb-notice-error', role: 'status' }, setupState.saveError ?? 'Could not load folder list.'),
      h('div', { className: 'eb-setup-actions' },
        renderButton(h, Btn, { type: 'button', onClick: () => actions.tryAgain?.() }, 'Try again'),
        renderButton(h, Btn, { type: 'button', onClick: () => actions.closeSetup?.() }, 'Close')))
  }

  const folders = setupState.folders ?? []
  if (folders.length === 0) {
    return h('div', { className: 'eb-setup' },
      h('p', null, 'No Crew folders have a project directory. Set a project directory in Crew first.'),
      renderButton(h, Btn, { type: 'button', onClick: () => actions.closeSetup?.() }, 'Close'))
  }

  const isSaving = setupState.phase === 'saving'
  const { checks, names, worktrees, setupInfo } = setupState

  const checkedFolders = folders.filter((f) => !!checks[f.id])
  const saveEnabled = !isSaving &&
    checkedFolders.length > 0 &&
    checkedFolders.every((f) => (names[f.id] ?? '').trim() !== '')

  const configNotice = setupInfo?.source === 'saved' && setupInfo?.config_has_projects
    ? h('p', { className: 'eb-notice', role: 'status', key: 'config-notice' },
        'config.json also has a projects list; this saved setup takes priority.')
    : null

  return h('div', { className: 'eb-setup' },
    configNotice,
    setupState.saveError ? h('p', { className: 'eb-notice eb-notice-error', role: 'status', key: 'save-error' }, setupState.saveError) : null,
    h('ul', { key: 'folders' }, folders.map((folder) => {
      const checked = !!checks[folder.id]
      return h('li', { className: 'eb-folder', key: folder.id },
        h('label', { className: 'eb-folder-label' },
          h('input', {
            type: 'checkbox',
            checked,
            onChange: () => actions.checkFolder?.({ folderId: folder.id, checked: !checked }),
          }),
          folder.name),
        h('div', { className: 'eb-folder-dir' }, folder.project_dir),
        checked
          ? h('input', {
            type: 'text',
            className: 'eb-folder-name',
            // Uncontrolled: the host's page keeps what is typed in the box; the state follows it. The box is
            // mounted again with the last value when the folder is ticked again.
            defaultValue: names[folder.id] ?? '',
            placeholder: folder.name,
            'aria-label': `Name for ${folder.name}`,
            onChange: (e) => actions.nameFolder?.({ folderId: folder.id, value: e.target.value }),
          })
          : null,
        checked
          ? h('label', { className: 'eb-worktree-label' },
            h('input', {
              type: 'checkbox',
              checked: worktrees[folder.id] !== false,
              onChange: () => actions.worktreeFolder?.({ folderId: folder.id, value: worktrees[folder.id] === false }),
            }),
            'Start each story in its own worktree')
          : null)
    })),
    h('div', { className: 'eb-setup-actions', key: 'actions' },
      renderButton(h, Btn, {
        type: 'button',
        disabled: !saveEnabled,
        onClick: () => actions.saveSetup?.(checkedFolders),
      }, isSaving ? 'Saving…' : 'Save', true),
      isSaving ? null : renderButton(h, Btn, { type: 'button', onClick: () => actions.closeSetup?.() }, 'Cancel')))
}

// Builds the page for a view (what `viewOf` returns) with h = createElement.
// Pure: no React, no hooks, no `window`. Every plan text is passed as a child.
// A plan view that also carries `chats` (the chats state) and `ui` draws the card controls; `actions`
// are what they call: ask(cardId), cancel(cardId), start(cardId), close(cardId), sendBrief(key), resume(key)
// and startAgain(name, cardId). Each defaults to doing nothing.
// `kit` holds the host's components by name (`pickKit`): `kit.Select` is the Select of the dropdowns, or
// none for a native select. An empty kit draws every part as the earlier specs do.
export function renderBoard(h, view, actions = {}, kit = {}) {
  const mergedActions = { ...NO_ACTIONS, ...actions }
  const style = h('style', null, STYLE)
  const title = h(`h${TITLE_LEVEL}`, { className: 'eb-title' }, 'Epic Board')
  if (!kit.PageHeader) return h('div', { className: 'eb-root' }, style, title, renderBody(h, view, mergedActions, kit))
  // The branch, commit, age and "Projects" button are in the plan view only; the other states draw the title alone.
  const inPlan = !view.unconfigured && view.kind === 'plan'
  const header = inPlan
    ? {
      title,
      subtitle: [view.branch, view.commit7, view.ageText].join(' · '),
      actions: [renderChecking(h, view), renderProjectsButton(h, view, mergedActions, kit.Btn)],
    }
    : { title }
  return h('div', { className: 'eb-root eb-has-header' },
    style,
    h(kit.PageHeader, header),
    h('div', { className: 'eb-body' }, renderBody(h, view, mergedActions, kit)))
}

// The Panel: a titled region with a Close button around `content`. `panel` is {title, ariaLabel?}.
// Chat panels use the default label "Chat: {title}"; pass `ariaLabel` to override.
export function renderPanel(h, panel, content, actions = {}, kit = {}) {
  const label = panel.ariaLabel ?? `Chat: ${panel.title}`
  return h('aside', { className: 'eb-panel', 'data-eb-panel': 'true', tabIndex: -1, 'aria-label': label },
    h('div', { className: 'eb-panel-head' },
      h('span', { className: 'eb-panel-title' }, panel.title),
      renderButton(h, kit.Btn, { type: 'button', onClick: () => actions.closeChat?.() }, 'Close')),
    h('div', { className: 'eb-panel-body' }, content))
}

// The page: the board, and beside or over it the Panel's tree (null when no chat is open). The board
// keeps its place in the tree either way, so it stays mounted.
export function renderShell(h, board, panelTree) {
  return h('div', { className: 'eb-shell', 'data-panel': panelTree ? 'open' : 'closed' },
    h('div', { className: 'eb-split' }, board, panelTree))
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
//   {kind: 'open-chat', cardId, key}            show that chat in the Panel (the same state when it is already open)
//   {kind: 'close-chat', key?, focus?}          close the Panel; with `key` only if that chat is the open one;
//                                               with `focus` ask for focus on the card that was open
export const initialUi = Object.freeze({
  asking: null, flows: Object.freeze({}), resumes: Object.freeze({}), briefs: Object.freeze({}), focus: null, open: null,
  cleanups: Object.freeze({}), finishing: null, finishes: Object.freeze({}),
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
    case 'finish-ask':
      return { ...state, finishing: action.cardId }
    case 'finish-cancel':
      return { ...state, finishing: state.finishing === action.cardId ? null : state.finishing, focus: { cardId: action.cardId } }
    case 'finish-run':
      return {
        ...state, finishing: null, finishes: { ...state.finishes, [action.name]: { kind: 'running' } },
        cleanups: without(state.cleanups, action.name),
      }
    case 'finish-failed':
      return { ...state, finishes: { ...state.finishes, [action.name]: { kind: 'failed', reason: action.reason } } }
    case 'worktree-kept':
      return {
        ...state, finishes: without(state.finishes, action.name),
        cleanups: { ...state.cleanups, [action.name]: { kind: 'kept', path: action.path, reason: action.reason } },
      }
    case 'cleanup-done':
      return { ...state, cleanups: without(state.cleanups, action.name), finishes: without(state.finishes, action.name) }
    case 'open-chat':
      return state.open?.key === action.key ? state : { ...state, open: { cardId: action.cardId, key: action.key } }
    case 'close-chat': {
      if (!state.open || (action.key !== undefined && state.open.key !== action.key)) return state
      return { ...state, open: null, focus: action.focus === true ? { cardId: state.open.cardId } : state.focus }
    }
    case 'reset':
      return initialUi
    default:
      return state
  }
}

// The app's own backend, through `fetch`. Resolves with the parsed body; a non-2xx answer rejects with an
// error that has `status` and `error` (the body's {code, message}). Like the plan request, it carries no
// credential of its own: the host signs it on its way to the backend.
export function makeBackend(fetchFn, projectId = null) {
  const projectParam = projectQuery(projectId)
  const call = async (method, path, body, init = {}) => {
    const options = { method, credentials: 'same-origin', cache: 'no-store', signal: init.signal }
    if (body !== undefined) {
      options.headers = { 'Content-Type': 'application/json' }
      options.body = JSON.stringify(body)
    }
    const query = projectParam === '' ? '' : (path.includes('?') ? '&' + projectParam.slice(1) : projectParam)
    const response = await fetchFn(BACKEND_BASE + path + query, options)
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
    patch: (path, body, init) => call('PATCH', path, body, init),
  }
}

// The host's app client (`useAppApi`), or a hook that gives none when the host has no such module.
function hostApiHook() {
  const sdk = typeof window !== 'undefined' ? window.__kirocrew_modules?.['@kirocrew/app-sdk'] : undefined
  return typeof sdk?.useAppApi === 'function' ? sdk.useAppApi : () => null
}

// The host's Crew Select, or null when the module or its Select is missing or the lookup throws.
export function hostSelect() {
  return hostKit().Select ?? null
}

// The host's Kanban icon (lucide-react) for the empty state, or null when there is none or the lookup throws.
function hostIcon() {
  try {
    const Kanban = typeof window !== 'undefined' ? window.__kirocrew_modules?.['lucide-react']?.Kanban : undefined
    return isComponent(Kanban) ? Kanban : null
  } catch {
    return null
  }
}

// The host's ChatPanel, or undefined when there is none.
function hostChatPanel() {
  return typeof window !== 'undefined' ? window.__kirocrew_modules?.['@kirocrew/app-sdk']?.ChatPanel : undefined
}

// The browser's localStorage, or undefined when there is none or reading it throws.
function hostStorage() {
  try {
    return typeof window !== 'undefined' ? window.localStorage : undefined
  } catch {
    return undefined
  }
}

const NO_CLIENT = 'The host has no app client, so Crew cannot be reached.'

// Builds the page component from the host's React. This is the only function that uses
// hooks. `env` may supply `fetch`, `document`, `setTimeout`, `clearTimeout`, `now` and `useAppApi`
// (tests pass fakes); each one defaults to the global and is looked up inside the effect or the
// component, so importing this module and calling `createBoard` need no `window`.
export function createBoard(React, env = {}) {
  const { useReducer, useState, useEffect, useRef, createElement: h } = React

  // Shows the Chat_Panel, or the failure text and a link to the chat when it throws; tries again when the
  // `slotKey` changes. Built on first use, so a React with no `Component` costs nothing until a Panel opens.
  let Boundary = null
  const boundary = () => {
    if (Boundary === null) {
      Boundary = class PanelBoundary extends React.Component {
        constructor(props) {
          super(props)
          this.state = { failed: false }
        }
        static getDerivedStateFromError() {
          return { failed: true }
        }
        componentDidUpdate(previous) {
          if (this.state.failed && previous.slotKey !== this.props.slotKey) this.setState({ failed: false })
        }
        render() {
          if (!this.state.failed) return this.props.children
          return [
            h('p', { role: 'status', key: 'text' }, 'The chat could not be shown here.'),
            h('a', { href: chatHref(this.props.slotKey), key: 'link' }, 'Open the chat in Crew'),
          ]
        }
      }
    }
    return Boundary
  }

  return function Board() {
    const [state, dispatch] = useReducer(reduce, initialState)
    const [chats, chatsDispatch] = useReducer(chatsReduce, initialChats)
    const [ui, uiDispatch] = useReducer(uiReduce, initialUi)
    const [projectsState, projectsDispatch] = useReducer(projectsReduce, initialProjects)
    const [setupState, setupDispatch] = useReducer(setupReduce, initialSetup)
    const api = (env.useAppApi ?? hostApiHook())()
    const storage = env.storage !== undefined ? env.storage : hostStorage()
    const kit = env.kit ?? hostKit()
    const Select = env.Select !== undefined ? env.Select : (kit.Select ?? null)
    const [filterKey, setFilterKey] = useState(() => loadChoice(storage))
    const [folds, setFolds] = useState(() => loadFolds(storage))
    const ChatPanel = env.ChatPanel ?? hostChatPanel()
    const hasPanel = isChatPanel(ChatPanel)
    const Kanban = hostIcon()
    const icon = Kanban ? h(Kanban, { size: 40, 'aria-hidden': 'true' }) : undefined
    const { phase: projectsPhase, projects, currentId } = projectsState
    const unconfigured = projectsPhase === 'ready' && (!projects || projects.length === 0)

    // What the handlers and the pollers read. Refs, so they always see the latest render.
    // `projectId` tracks the project of the active effect run; old callbacks compare against it.
    const latest = useRef(null)
    if (latest.current === null) {
      latest.current = { starts: new Set(), briefs: new Map(), sending: new Set(), timers: new Set(), poller: null, alive: false, projectId: null, finishes: new Set() }
    }
    latest.current.chats = chats
    latest.current.api = api
    latest.current.hasPanel = hasPanel
    latest.current.projectWorktree = projects?.find((p) => p.id === currentId)?.worktree ?? true
    const prevSetupOpen = useRef(false)

    // Read the Project_List once. No plan or chat poller starts until this ends.
    useEffect(() => {
      const doc = env.document ?? document
      const fetchFn = env.fetch ?? fetch
      const setTimer = env.setTimeout ?? setTimeout
      const clearTimer = env.clearTimeout ?? clearTimeout
      let done = false
      let timer = null

      const doFetch = () => {
        if (done) return
        if (timer !== null) { clearTimer(timer); timer = null }
        makeBackend(fetchFn).get('/projects').then(
          (body) => {
            if (done) return
            const list = readProjects(body)
            if (list !== null) {
              done = true
              projectsDispatch({ kind: 'projects-read', projects: list, savedId: loadProject(storage) })
            } else {
              projectsDispatch({ kind: 'projects-failed' })
              timer = setTimer(doFetch, 15000)
            }
          },
          () => {
            if (done) return
            projectsDispatch({ kind: 'projects-failed' })
            timer = setTimer(doFetch, 15000)
          },
        )
      }

      const onVisibility = () => { if (!doc.hidden) doFetch() }
      doc.addEventListener('visibilitychange', onVisibility)
      if (!doc.hidden) doFetch()
      return () => {
        done = true
        if (timer !== null) { clearTimer(timer); timer = null }
        doc.removeEventListener('visibilitychange', onVisibility)
      }
    }, [])

    // Plan poller: starts (or restarts on project switch) once the project list is known.
    useEffect(() => {
      if (projectsPhase === 'loading') return
      if (unconfigured) return
      const doc = env.document ?? document
      const fetchFn = env.fetch ?? fetch
      const setTimer = env.setTimeout ?? setTimeout
      const clearTimer = env.clearTimeout ?? clearTimeout
      const projectId = projectsPhase === 'ready' ? currentId : null
      latest.current.projectId = projectId

      const planUrl = PLAN_URL + projectQuery(projectId)
      const request = async (signal) => {
        const response = await fetchFn(planUrl, { method: 'GET', credentials: 'same-origin', cache: 'no-store', signal })
        const body = await response.json()
        return { status: response.status, body }
      }

      const live = () => latest.current.projectId === projectId && latest.current.alive
      const poller = createPoller({
        request,
        hidden: () => doc.hidden,
        setTimer: (fn, ms) => setTimer(fn, ms),
        clearTimer: (handle) => clearTimer(handle),
        onResult: (result) => { if (live()) dispatch(result) },
      })
      const onVisibility = () => { if (!doc.hidden) poller.visible() }
      doc.addEventListener('visibilitychange', onVisibility)
      poller.start()
      return () => {
        poller.stop()
        doc.removeEventListener('visibilitychange', onVisibility)
      }
    }, [currentId, projectsPhase])

    // Chat poller: starts (or restarts on project switch) once the project list is known.
    useEffect(() => {
      if (projectsPhase === 'loading') return
      if (unconfigured) return
      const doc = env.document ?? document
      const fetchFn = env.fetch ?? fetch
      const setTimer = env.setTimeout ?? setTimeout
      const clearTimer = env.clearTimeout ?? clearTimeout
      const now = env.now ?? Date.now
      const projectId = projectsPhase === 'ready' ? currentId : null
      const backend = makeBackend(fetchFn, projectId)
      const gateway = {
        get: (path, init) => (latest.current.api ? latest.current.api.get(path, init) : Promise.reject(new Error(NO_CLIENT))),
        post: (path, ...rest) => (latest.current.api ? latest.current.api.post(path, ...rest) : Promise.reject(new Error(NO_CLIENT))),
        patch: (path, ...rest) => (latest.current.api ? latest.current.api.patch(path, ...rest) : Promise.reject(new Error(NO_CLIENT))),
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

      const live = () => latest.current.projectId === projectId && latest.current.alive
      const poller = createPoller({
        request: async (signal) => ({
          status: 200,
          body: await readChats({
            backend, gateway, previous: latest.current.chats, now, signal,
            onRecords: (records) => { if (live()) chatsDispatch({ kind: 'records', ...records }) },
          }),
        }),
        hidden: () => doc.hidden,
        setTimer: (fn, ms) => setTimer(fn, ms),
        clearTimer: (handle) => clearTimer(handle),
        onResult: (result) => {
          if (!live()) return
          chatsDispatch(result)
        },
        classifyAnswer: classifyChats,
        delay: chatDelay,
      })
      latest.current.poller = poller
      latest.current.alive = true
      const onVisibility = () => { if (!doc.hidden) poller.visible() }
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
    }, [currentId, projectsPhase])

    // After Cancel or Close, put focus back on the card's button.
    useEffect(() => {
      if (!ui.focus) return
      const doc = env.document ?? document
      const target = [...doc.querySelectorAll('[data-card-id]')].find((node) => node.getAttribute('data-card-id') === ui.focus.cardId)
      if (target && typeof target.focus === 'function') target.focus()
    }, [ui.focus])

    // When the question opens on a card, put focus on its "Start" button, so that Escape closes it straight
    // after a mouse click (start-a-story, Requirement 2, criterion 3).
    useEffect(() => {
      if (ui.asking == null) return
      const doc = env.document ?? document
      const target = [...doc.querySelectorAll('[data-eb-start]')].find((node) => node.getAttribute('data-eb-start') === ui.asking)
      if (target && typeof target.focus === 'function') target.focus()
    }, [ui.asking])

    // When the Finish confirm step opens on a card, put focus on its "Finish session" button, so Escape closes it.
    useEffect(() => {
      if (ui.finishing == null) return
      const doc = env.document ?? document
      const target = [...doc.querySelectorAll('[data-eb-finish]')].find((node) => node.getAttribute('data-eb-finish') === ui.finishing)
      if (target && typeof target.focus === 'function') target.focus()
    }, [ui.finishing])

    // When a Panel opens or shows another chat, put focus on its container.
    const panelKey = hasPanel && ui.open ? ui.open.key : null
    useEffect(() => {
      if (panelKey === null) return
      const doc = env.document ?? document
      const target = doc.querySelector('[data-eb-panel]')
      if (target && typeof target.focus === 'function') target.focus()
    }, [panelKey])

    // When the setup panel opens, focus it; when it closes, return focus to the Projects button.
    const setupOpen = setupState.phase !== 'closed'
    useEffect(() => {
      const wasOpen = prevSetupOpen.current
      prevSetupOpen.current = setupOpen
      const doc = env.document ?? document
      if (setupOpen && !wasOpen) {
        const target = doc.querySelector('[data-eb-panel]')
        if (target && typeof target.focus === 'function') target.focus()
      } else if (!setupOpen && wasOpen) {
        const target = doc.querySelector('[data-eb-setup-btn]')
        if (target && typeof target.focus === 'function') target.focus()
      }
    }, [setupOpen])

    const refresh = () => latest.current.poller?.visible()
    const live = (fn) => (...args) => { if (latest.current.alive) fn(...args) }
    const ownUi = live(uiDispatch)
    const ownChats = live(chatsDispatch)

    const filter = (key) => {
      setFilterKey(key)
      saveChoice(storage, key)
    }

    const toggleColumn = (columnKey) => {
      const next = toggleFold(folds, currentId, columnKey)
      setFolds(next)
      saveFolds(storage, next)
    }

    const switchProject = (id) => {
      if (!projects?.some((p) => p.id === id)) return
      dispatch({ kind: 'reset' })
      chatsDispatch({ kind: 'reset' })
      uiDispatch({ kind: 'reset' })
      setFilterKey('all')
      saveChoice(storage, 'all')
      saveProject(storage, id)
      projectsDispatch({ kind: 'switch', id })
    }

    const openSetup = async () => {
      ownUi({ kind: 'close-chat' })
      setupDispatch({ kind: 'setup-open' })
      const fetchFn = env.fetch ?? fetch
      const setTimer = env.setTimeout ?? setTimeout
      const clearTimer = env.clearTimeout ?? clearTimeout
      const controller = new AbortController()
      const timer = setTimer(() => controller.abort(), 10000)
      try {
        const [foldersResult, setupResult] = await Promise.allSettled([
          latest.current.api
            ? latest.current.api.get('/api/chat/folders', { signal: controller.signal })
            : Promise.reject(new Error(NO_CLIENT)),
          makeBackend(fetchFn).get('/setup', { signal: controller.signal }),
        ])
        clearTimer(timer)
        if (!latest.current.alive) return
        if (foldersResult.status === 'fulfilled' && setupResult.status === 'fulfilled') {
          setupDispatch({ kind: 'setup-loaded', folders: readFolders(foldersResult.value, setupResult.value?.worktree_folder_ids) ?? [], setupInfo: setupResult.value })
        } else {
          const reason = foldersResult.reason ?? setupResult.reason
          setupDispatch({ kind: 'setup-load-failed', message: String(reason?.message ?? reason) })
        }
      } catch (error) {
        clearTimer(timer)
        if (latest.current.alive) setupDispatch({ kind: 'setup-load-failed', message: String(error?.message ?? error) })
      }
    }

    const saveSetup = async (checkedFolders) => {
      const fetchFn = env.fetch ?? fetch
      const body = {
        projects: checkedFolders.map((folder) => ({
          folder_id: folder.id,
          name: (setupState.names[folder.id] ?? '').trim() || folder.name,
          repository: folder.project_dir,
          worktree: setupState.worktrees[folder.id] !== false,
        })),
      }
      setupDispatch({ kind: 'setup-saving' })
      try {
        await makeBackend(fetchFn).post('/setup', body)
        if (!latest.current.alive) return
        setupDispatch({ kind: 'setup-close' })
        dispatch({ kind: 'reset' })
        chatsDispatch({ kind: 'reset' })
        uiDispatch({ kind: 'reset' })
        setFilterKey('all')
        saveChoice(storage, 'all')
        const projectsList = await makeBackend(fetchFn).get('/projects')
        if (!latest.current.alive) return
        const list = readProjects(projectsList)
        if (list !== null) projectsDispatch({ kind: 'projects-read', projects: list, savedId: loadProject(storage) })
      } catch (error) {
        if (latest.current.alive) setupDispatch({ kind: 'setup-save-failed', message: String(error?.message ?? error) })
      }
    }

    const actions = {
      ask: (cardId) => ownUi({ kind: 'ask', cardId }),
      cancel: (cardId) => ownUi({ kind: 'cancel', cardId }),
      close: (cardId) => ownUi({ kind: 'cancel', cardId }),
      // Only a chat the page holds a record for is opened.
      openChat: ({ cardId, key }) => {
        if (latest.current.chats.records.some((record) => record.key === key && record.card_id === cardId)) {
          ownUi({ kind: 'open-chat', cardId, key })
        }
      },
      closeChat: () => ownUi({ kind: 'close-chat', focus: true }),
      async start(cardId, cardName = '') {
        const { starts, backend, gateway } = latest.current
        const startProjectId = latest.current.projectId
        const liveStart = () => latest.current.projectId === startProjectId && latest.current.alive
        if (starts.has(cardId)) return // a start is already running for this card
        starts.add(cardId)
        liveStart() && ownUi({ kind: 'step', cardId, step: 'reserve' })
        try {
          const result = await startStory({
            cardId, cardName, backend, gateway,
            setTimer: latest.current.setTimer, clearTimer: latest.current.clearTimer,
            onStep: (step) => { if (step !== 'send' && liveStart()) ownUi({ kind: 'step', cardId, step }) },
            // The chat is saved: its link and its state appear now, while the brief is on its way.
            onSaved: (saved) => {
              if (!liveStart()) return
              latest.current.briefs.set(saved.key, saved.brief)
              ownChats({ kind: 'started', record: { card_id: cardId, name: saved.name, key: saved.key } })
              ownUi({ kind: 'started', cardId })
              if (latest.current.hasPanel) ownUi({ kind: 'open-chat', cardId, key: saved.key })
              ownUi({ kind: 'brief-sending', key: saved.key })
              refresh()
            },
          })
          if (liveStart()) {
            // The brief is sent (Crew accepted it, or 10 seconds passed with no error): forget its text.
            latest.current.briefs.delete(result.key)
            ownUi({ kind: 'brief-sent', key: result.key })
          }
        } catch (error) {
          if (liveStart()) {
            if (error.saved) {
              // The chat exists and is saved; only the brief was not sent. The card keeps its link.
              ownUi({ kind: 'brief-failed', key: error.saved.key, reason: error.reason ?? String(error?.message ?? error) })
            } else {
              ownUi({ kind: 'failed', cardId, step: error.step ?? 'reserve', reason: error.reason ?? String(error?.message ?? error) })
              if (error.code === 'chat_exists') refresh() // another page started it: read the records again
            }
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
          if (record) {
            ownUi({ kind: 'resumed', key: record.key })
            ownUi({ kind: 'close-chat', key: record.key })
          }
          ownUi({ kind: 'ask', cardId })
        } catch (error) {
          if (record) ownUi({ kind: 'resume-failed', key: record.key, reason: error.reason ?? String(error?.message ?? error) })
        }
      },
      finishAsk: (cardId) => ownUi({ kind: 'finish-ask', cardId }),
      finishCancel: (cardId) => ownUi({ kind: 'finish-cancel', cardId }),
      // Finish: the worktree goes (unless git finds work that would be lost and `force` is off), the Crew
      // folder is released, the record is marked finished, then one note goes into the chat.
      async finish(name, force = false) {
        const record = latest.current.chats.records.find((candidate) => candidate.name === name && candidate.state !== 'finished')
        if (!record || latest.current.finishes.has(name)) return
        const finishProjectId = latest.current.projectId
        const isLive = () => latest.current.projectId === finishProjectId && latest.current.alive
        const { backend, gateway } = latest.current
        const at = `/chats/${encodeURIComponent(name)}`
        latest.current.finishes.add(name)
        ownUi({ kind: 'finish-run', name })
        const fail = (error) => {
          if (!isLive()) return
          ownUi({ kind: 'finish-failed', name, reason: errorMessage(error?.error?.message ?? error).slice(0, REASON_MAX_CHARS) })
          refresh()
        }
        try {
          if (typeof record.worktree_path === 'string' && record.worktree_path !== '') {
            try {
              await backend.del(`${at}/worktree${force ? '?force=true' : ''}`)
            } catch (error) {
              const code = error?.error?.code
              if (code === 'worktree_has_changes' || code === 'worktree_has_unpushed') {
                if (isLive()) ownUi({ kind: 'worktree-kept', name, path: record.worktree_path, reason: String(error.error.message ?? '') })
              } else {
                fail(error)
              }
              return
            }
          }
          if (typeof record.worktree_folder_id === 'string' && record.worktree_folder_id !== '') {
            try {
              await gateway.patch(`/api/chat/folders/${encodeURIComponent(record.worktree_folder_id)}`, { project_dir: '' })
            } catch { /* a folder that cannot be released is left alone */ }
          }
          try {
            await backend.post(`${at}/finished`)
          } catch (error) {
            fail(error)
            return
          }
          if (!isLive()) return
          ownChats({ kind: 'finished', name })
          ownUi({ kind: 'cleanup-done', name })
          const note = typeof record.worktree_path === 'string' && record.worktree_path !== '' ? FINISH_NOTE : FINISH_NOTE_PLAIN
          try {
            await gateway.post(`/api/chat/slots/${encodeURIComponent(record.key)}/note`, { content: note, source: 'epic-board' })
          } catch { /* a closed chat answers 404: the card is finished all the same */ }
        } finally {
          latest.current.finishes.delete(name)
        }
      },
      removeWorktree: (name, force = true) => actions.finish(name, force),
    }

    const started = new Set(chats.records.filter((record) => record.state !== 'finished').map((record) => record.card_id))
    const view = viewOf(state, filterKey, started)
    // A saved or chosen epic that the plan lacks: show all epics and save that.
    const effectiveKey = view.kind === 'plan' ? view.filter.key : filterKey
    useEffect(() => {
      if (effectiveKey !== filterKey) {
        setFilterKey(effectiveKey)
        saveChoice(storage, effectiveKey)
      }
    }, [effectiveKey, filterKey])

    // Project dropdown shown only when the list is ready and has 2 or more projects.
    const projectsOptions = projectsPhase === 'ready' ? projectOptions(projects) : null
    const projectsView = projectsOptions ? { options: projectsOptions, currentId } : null
    const projectsNotice = projectsPhase === 'failed'

    const setupActionSet = {
      closeSetup: () => setupDispatch({ kind: 'setup-close' }),
      tryAgain: openSetup,
      checkFolder: ({ folderId, checked }) => setupDispatch({ kind: 'setup-check', folderId, checked }),
      nameFolder: ({ folderId, value }) => setupDispatch({ kind: 'setup-name', folderId, value }),
      worktreeFolder: ({ folderId, value }) => setupDispatch({ kind: 'setup-worktree', folderId, value }),
      saveSetup,
    }
    const projectWorktree = latest.current.projectWorktree
    const board = renderBoard(h,
      { ...view, chats, ui, panelAvailable: hasPanel, projects: projectsView, projectsNotice, setupState, unconfigured, icon, projectWorktree, folded: foldsFor(folds, currentId) },
      { ...actions, filter, switchProject, openSetup, toggleColumn, ...setupActionSet },
      { ...kit, Select })
    const chatPanel = !setupOpen ? panelViewOf(view, ui, hasPanel) : null
    let panelTree
    if (setupOpen) {
      panelTree = renderPanel(h, { title: 'Projects', ariaLabel: 'Projects' }, renderSetupView(h, setupState, setupActionSet, kit), { closeChat: setupActionSet.closeSetup }, kit)
    } else if (chatPanel) {
      panelTree = renderPanel(h, chatPanel, h(boundary(), { slotKey: chatPanel.key }, h(ChatPanel, { slotKey: chatPanel.key, conversationOnly: true })), actions, kit)
    } else {
      panelTree = null
    }
    return renderShell(h, board, panelTree)
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
