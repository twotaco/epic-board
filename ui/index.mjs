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
// At most one request is in flight. Returns {start, visible, stop}.
export function createPoller({
  request,
  hidden,
  setTimer,
  clearTimer,
  onResult,
  createAbortController = () => new AbortController(),
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
      if (!stopped) nextTimer = setTimer(onNextTimer, nextDelay(result))
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
          result = classify(answer.status, answer.body)
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
.eb-card { min-width: 0; border: 1px solid rgba(128, 128, 128, 0.5); border-radius: 6px; background: rgba(128, 128, 128, 0.1); padding: 8px 12px; overflow-wrap: anywhere; }
.eb-card-name { font-weight: 600; }
.eb-card-description { margin-top: 4px; }
.eb-card-spec { margin-top: 4px; font-family: monospace; font-size: 0.85em; opacity: 0.7; }
.eb-card-progress { margin-top: 4px; font-size: 0.9em; }
.eb-bar { margin-top: 4px; height: 6px; border-radius: 3px; background: rgba(128, 128, 128, 0.3); overflow: hidden; }
.eb-bar-fill { height: 100%; background: currentColor; opacity: 0.6; }
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

function renderCard(h, card, index) {
  const progress = progressOf(card)
  return h('li', { className: 'eb-card', key: index },
    h('div', { className: 'eb-card-name' }, card.name),
    card.description ? h('div', { className: 'eb-card-description' }, card.description) : null,
    card.spec != null ? h('div', { className: 'eb-card-spec' }, card.spec) : null,
    h('div', { className: 'eb-card-progress' }, progress.text),
    progress.fraction !== null
      ? h('div', { className: 'eb-bar', 'aria-hidden': 'true' },
        h('div', { className: 'eb-bar-fill', style: { width: `${progress.fraction * 100}%` } }))
      : null)
}

function renderColumn(h, column) {
  return h('div', { className: 'eb-column', key: column.key },
    h(`h${TITLE_LEVEL + 1}`, { className: 'eb-column-title' },
      h('span', null, column.title),
      ' ',
      h('span', { className: 'eb-count' }, String(column.count))),
    column.groups.length === 0
      ? h('p', { className: 'eb-empty-column' }, 'Nothing here')
      : column.groups.map((group, index) => h('div', { className: 'eb-group', key: `${group.key}:${index}` },
        h(`h${TITLE_LEVEL + 2}`, { className: 'eb-group-title' }, group.name ?? 'No epic'),
        h('ul', { className: 'eb-cards' }, group.cards.map((card, i) => renderCard(h, card, i))))))
}

function renderProblems(h, problems) {
  const summary = problems.length === 1 ? '1 file could not be read' : `${problems.length} files could not be read`
  return h('details', { className: 'eb-problems' },
    h('summary', null, summary),
    h('ul', null, problems.map((problem, index) => h('li', { key: index },
      h('div', null, problem.file),
      h('div', null, problem.reason)))))
}

function renderPlanView(h, view) {
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
    view.empty
      ? h('div', { className: 'eb-empty', key: 'empty' },
        h('p', null, `No specs or epics were found on ${view.branch}.`),
        h('p', null, EMPTY_PLAN_HINT))
      : h('div', { className: 'eb-columns', key: 'columns' }, view.columns.map((column) => renderColumn(h, column))),
    view.problems.length > 0 ? renderProblems(h, view.problems) : null,
  ]
}

function renderBody(h, view) {
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
      return renderPlanView(h, view)
  }
}

// Builds the page for a view (what `viewOf` returns) with h = createElement.
// Pure: no React, no hooks, no `window`. Every plan text is passed as a child.
export function renderBoard(h, view) {
  return h('div', { className: 'eb-root' },
    h('style', null, STYLE),
    h(`h${TITLE_LEVEL}`, { className: 'eb-title' }, 'Epic Board'),
    renderBody(h, view))
}

const PLAN_URL = '/apps/epic-board/api/plan'

// Builds the page component from the host's React. This is the only function that uses
// hooks. `env` may supply `fetch`, `document`, `setTimeout` and `clearTimeout` (tests pass
// fakes); each one defaults to the global and is looked up inside the effect, so importing
// this module and calling `createBoard` need no `window`.
export function createBoard(React, env = {}) {
  const { useReducer, useEffect, createElement: h } = React

  return function Board() {
    const [state, dispatch] = useReducer(reduce, initialState)

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

    return renderBoard(h, viewOf(state))
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
