// Epic Board spike: reads the epics through this app's backend, and opens a
// conductor chat from a card. Uses the host's React and app SDK.
const React = window.__kirocrew_modules.react
const { useAppApi } = window.__kirocrew_modules['@kirocrew/app-sdk']
const { useState, useEffect, createElement: h } = React

const APP = 'epic-board-spike'
const COLUMNS = ['planned', 'in progress', 'done']
const TEST_BRIEF = 'This is a test from the Epic Board spike. Do not change any files. '
  + 'Run `pwd`, then print the first line of docs/epics/README.md, report both, and stop.'

export default function EpicBoardSpike() {
  const api = useAppApi()
  const [board, setBoard] = useState(null)
  const [boardError, setBoardError] = useState('')
  const [folderId, setFolderId] = useState('')
  const [log, setLog] = useState([])
  const [folders, setFolders] = useState(null)
  const note = (line) => setLog((lines) => [...lines, `${new Date().toLocaleTimeString()}  ${line}`])

  useEffect(() => {
    fetch(`/apps/${APP}/api/board`, { credentials: 'same-origin' })
      .then(async (response) => {
        const text = await response.text()
        if (!response.ok) throw new Error(`${response.status} ${text.slice(0, 300)}`)
        setBoard(JSON.parse(text))
      })
      .catch((error) => setBoardError(String(error)))
  }, [])

  async function start(storyName, brief) {
    const slot = `epic-board-${Date.now()}`
    note(`Opening conductor chat ${slot} for "${storyName}"`)
    try {
      const body = { name: slot, agent: 'kirocrew-conductor' }
      if (folderId.trim()) body.folder_id = folderId.trim()
      const created = await api.post('/api/chat/slots', body)
      note(`Created: ${JSON.stringify(created).slice(0, 400)}`)
      try {
        await api.post('/api/chat', { slot, message: brief })
      } catch (error) {
        // The chat endpoint accepts the message but may not answer with JSON.
        if (!/accepted the request/.test(String(error?.message ?? error))) throw error
      }
      note('Sent the brief. Open the new chat in Sessions to watch it.')
    } catch (error) {
      note(`Failed: ${String(error?.message ?? error).slice(0, 400)}`)
    }
  }

  const stories = board ? board.epics.flatMap((epic) => epic.stories.map((story) => ({ ...story, epic: epic.title }))) : []
  const card = (story) => h('div', { key: story.epic + story.name, style: { border: '1px solid #8884', borderRadius: 8, padding: 8, marginBottom: 8 } },
    h('div', { style: { fontSize: 11, opacity: 0.7 } }, story.epic),
    h('div', { style: { fontWeight: 600 } }, story.name),
    story.progress && story.progress.total ? h('div', { style: { fontSize: 12 } }, `${story.progress.done} of ${story.progress.total} tasks`) : null,
    story.progress && story.progress.error ? h('div', { style: { fontSize: 12, color: '#c33' } }, story.progress.error) : null)

  return h('div', { style: { padding: 24, overflowY: 'auto', height: '100%' } },
    h('h2', null, 'Epic Board (spike)'),
    h('section', { style: { marginBottom: 16 } },
      h('h3', null, '1. Can the backend read the repo?'),
      boardError ? h('pre', { style: { color: '#c33', whiteSpace: 'pre-wrap' } }, boardError)
        : !board ? h('p', null, 'Loading…')
        : h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12 } },
          `repo: ${board.repo} at ${board.ref} (fetch: ${board.fetch})\nepics read: ${board.epics.length}, stories: ${stories.length}\nerrors: ${JSON.stringify(board.errors)}\nbackend: ${JSON.stringify(board.whoami)}`)),
    h('section', { style: { marginBottom: 16 } },
      h('h3', null, '2. Can a Start button open a conductor chat in the repo?'),
      h('button', { onClick: async () => {
        try { setFolders(await api.get('/api/chat/folders')) } catch (error) { setFolders({ error: String(error?.message ?? error) }) }
      } }, 'List folders'),
      folders ? h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12 } }, JSON.stringify(
        Array.isArray(folders) ? folders.map((f) => ({ id: f.id, name: f.name, project: f.project ?? f.project_dir ?? f.projectDir }))
          : Array.isArray(folders?.folders) ? folders.folders.map((f) => ({ id: f.id, name: f.name, project: f.project ?? f.project_dir ?? f.projectDir }))
          : folders, null, 1)) : null,
      h('br'),
      h('label', null, 'Folder id (optional): ',
        h('input', { value: folderId, onChange: (event) => setFolderId(event.target.value), style: { width: 320 } })),
      ' ',
      h('button', { onClick: () => start('Spike test', TEST_BRIEF) }, 'Start test chat'),
      h('pre', { style: { whiteSpace: 'pre-wrap', fontSize: 12 } }, log.join('\n') || 'Nothing sent yet.')),
    h('section', null,
      h('h3', null, '3. Board'),
      h('div', { style: { display: 'grid', gridTemplateColumns: 'repeat(3, 1fr)', gap: 12 } },
        COLUMNS.map((column) => h('div', { key: column },
          h('h4', { style: { textTransform: 'capitalize' } }, column),
          stories.filter((story) => story.status === column).map(card))))))
}
