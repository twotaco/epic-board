// Epic Board placeholder page: shows what the backend read from main.
// Replaced by the "Show the board" story. Uses the host's React.

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
