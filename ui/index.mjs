// Epic Board placeholder page: shows what the backend read from main.
// Replaced by the "Show the board" story. Uses the host's React.

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

// The host's React is looked up on first use, so importing this module needs no `window`.
function createPlaceholder(React) {
  const { useState, useEffect, createElement: h } = React

  return function EpicBoard() {
    const [plan, setPlan] = useState(null)
    const [error, setError] = useState('')

    useEffect(() => {
      let timer = null
      let stopped = false
      const load = () => {
        fetch('/apps/epic-board/api/plan', { credentials: 'same-origin' })
          .then(async (response) => {
            const body = await response.json().catch(() => null)
            if (stopped) return
            if (response.status === 202 && body?.pending === true) {
              timer = setTimeout(load, 2000)
              return
            }
            if (!response.ok) throw new Error(body?.error?.message ?? `Request failed with status ${response.status}`)
            setPlan(body)
          })
          .catch((failure) => { if (!stopped) setError(String(failure?.message ?? failure)) })
      }
      load()
      return () => {
        stopped = true
        if (timer !== null) clearTimeout(timer)
      }
    }, [])

    return h('div', { style: { padding: 24, overflowY: 'auto', height: '100%' } },
      h('h2', null, 'Epic Board'),
      error ? h('pre', { style: { color: '#c33', whiteSpace: 'pre-wrap' } }, error)
        : !plan ? h('p', null, 'Loading…')
        : h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12 } }, [
          `repository: ${plan.repository}`,
          `branch: ${plan.branch} (${plan.ref})`,
          `commit: ${plan.commit}`,
          plan.fetch.ok !== false ? 'fetch: ok' : `fetch failed, showing an earlier copy: ${plan.fetch.reason}`,
          ...plan.groups.map((group) => `${group.epic ? group.epic.name : 'No epic'}: ${group.cards.length} cards`),
          `problems: ${plan.problems.length ? JSON.stringify(plan.problems) : 'none'}`,
        ].join('\n')))
  }
}

let built = null

export default function EpicBoardPage(props) {
  if (built === null) {
    const React = window.__kirocrew_modules.react
    built = { React, Component: createPlaceholder(React) }
  }
  return built.React.createElement(built.Component, props)
}
