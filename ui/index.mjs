// Epic Board placeholder page: shows what the backend read from main.
// Replaced by the "Show the board" story. Uses the host's React.
const React = window.__kirocrew_modules.react
const { useState, useEffect, createElement: h } = React

export default function EpicBoard() {
  const [plan, setPlan] = useState(null)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/apps/epic-board/api/plan', { credentials: 'same-origin' })
      .then(async (response) => {
        const body = await response.json().catch(() => null)
        if (!response.ok) throw new Error(body?.error?.message ?? `Request failed with status ${response.status}`)
        setPlan(body)
      })
      .catch((failure) => setError(String(failure?.message ?? failure)))
  }, [])

  return h('div', { style: { padding: 24, overflowY: 'auto', height: '100%' } },
    h('h2', null, 'Epic Board'),
    error ? h('pre', { style: { color: '#c33', whiteSpace: 'pre-wrap' } }, error)
      : !plan ? h('p', null, 'Loading…')
      : h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12 } }, [
        `repository: ${plan.repository}`,
        `branch: ${plan.branch} (${plan.ref})`,
        `commit: ${plan.commit}`,
        plan.fetch.ok ? 'fetch: ok' : `fetch failed, showing an earlier copy: ${plan.fetch.reason}`,
        ...plan.groups.map((group) => `${group.epic ? group.epic.name : 'No epic'}: ${group.cards.length} cards`),
        `problems: ${plan.problems.length ? JSON.stringify(plan.problems) : 'none'}`,
      ].join('\n')))
}
