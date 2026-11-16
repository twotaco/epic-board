// Tests for the project-switching pure functions, reducers and property tests.
import test from 'node:test'
import assert from 'node:assert/strict'

import { findAll, textOf, forSeeds, forSeedsAsync } from './support.mjs'
import {
  readProjects,
  resolveProject,
  projectOptions,
  loadProject,
  saveProject,
  projectQuery,
  initialProjects,
  projectsReduce,
  initialState,
  reduce,
  initialChats,
  chatsReduce,
  initialUi,
  uiReduce,
  makeBackend,
  createBoard,
} from '../../ui/index.mjs'

// ---- readProjects ----

test('readProjects: a good list', () => {
  const result = readProjects([{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }])
  assert.deepEqual(result, [{ id: 'alpha', name: 'Alpha', worktree: true }, { id: 'beta', name: 'Beta', worktree: true }])
})

test('readProjects: worktree field: absent defaults to true, false stays false', () => {
  const result = readProjects([
    { id: 'a', name: 'A' },
    { id: 'b', name: 'B', worktree: false },
    { id: 'c', name: 'C', worktree: true },
  ])
  assert.deepEqual(result, [
    { id: 'a', name: 'A', worktree: true },
    { id: 'b', name: 'B', worktree: false },
    { id: 'c', name: 'C', worktree: true },
  ])
})

test('readProjects: an empty list', () => {
  assert.deepEqual(readProjects([]), [])
})

test('readProjects: not a list', () => {
  assert.equal(readProjects(null), null)
  assert.equal(readProjects({}), null)
  assert.equal(readProjects('x'), null)
})

test('readProjects: duplicate id', () => {
  assert.equal(readProjects([{ id: 'a', name: 'A' }, { id: 'a', name: 'B' }]), null)
})

test('readProjects: id that does not match the pattern', () => {
  assert.equal(readProjects([{ id: 'A_bad!', name: 'X' }]), null)
  assert.equal(readProjects([{ id: '', name: 'X' }]), null)
  assert.equal(readProjects([{ id: 'a'.repeat(65), name: 'X' }]), null)
})

test('readProjects: name that is not text', () => {
  assert.equal(readProjects([{ id: 'ok', name: 42 }]), null)
  assert.equal(readProjects([{ id: 'ok', name: null }]), null)
})

// ---- resolveProject ----

test('resolveProject: saved id in the list', () => {
  const projects = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  assert.deepEqual(resolveProject(projects, 'b'), { id: 'b', name: 'B' })
})

test('resolveProject: saved id not in the list falls back to first', () => {
  const projects = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  assert.deepEqual(resolveProject(projects, 'gone'), { id: 'a', name: 'A' })
})

test('resolveProject: null saved id returns first', () => {
  const projects = [{ id: 'a', name: 'A' }]
  assert.deepEqual(resolveProject(projects, null), { id: 'a', name: 'A' })
})

test('resolveProject: empty list returns null', () => {
  assert.equal(resolveProject([], 'a'), null)
  assert.equal(resolveProject([], null), null)
})

// ---- projectOptions ----

test('projectOptions: null for 0 projects', () => {
  assert.equal(projectOptions([]), null)
})

test('projectOptions: null for 1 project', () => {
  assert.equal(projectOptions([{ id: 'a', name: 'A' }]), null)
})

test('projectOptions: options for 2+ projects', () => {
  const projects = [{ id: 'a', name: 'Alpha' }, { id: 'b', name: 'Beta' }]
  assert.deepEqual(projectOptions(projects), [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }])
})

// ---- loadProject / saveProject ----

test('loadProject: no storage', () => {
  assert.equal(loadProject(undefined), null)
  assert.equal(loadProject(null), null)
})

test('loadProject: storage that throws on read', () => {
  assert.equal(loadProject({ getItem() { throw new Error('blocked') } }), null)
})

test('loadProject: stored value that is not text', () => {
  assert.equal(loadProject({ getItem: () => 42 }), null)
  assert.equal(loadProject({ getItem: () => null }), null)
})

test('loadProject: stored value', () => {
  assert.equal(loadProject({ getItem: () => 'my-proj' }), 'my-proj')
})

test('saveProject: no storage', () => {
  assert.equal(saveProject(undefined, 'x'), false)
})

test('saveProject: storage that throws on write', () => {
  assert.equal(saveProject({ setItem() { throw new Error('full') } }, 'x'), false)
})

test('saveProject: saves the id', () => {
  const writes = []
  const storage = { setItem: (k, v) => writes.push([k, v]) }
  assert.equal(saveProject(storage, 'my-proj'), true)
  assert.deepEqual(writes, [['epic-board.project', 'my-proj']])
})

// ---- projectQuery ----

test('projectQuery: null returns empty string', () => {
  assert.equal(projectQuery(null), '')
  assert.equal(projectQuery(undefined), '')
})

test('projectQuery: id with characters that need encoding', () => {
  assert.equal(projectQuery('my project'), '?project=my%20project')
  assert.equal(projectQuery('a/b'), '?project=a%2Fb')
})

test('projectQuery: simple id', () => {
  assert.equal(projectQuery('my-proj'), '?project=my-proj')
})

// ---- projectsReduce ----

test('projectsReduce: initial state', () => {
  assert.deepEqual(initialProjects, { phase: 'loading', projects: null, currentId: null })
})

test('projectsReduce: projects-read with savedId in list', () => {
  const projects = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const state = projectsReduce(initialProjects, { kind: 'projects-read', projects, savedId: 'b' })
  assert.equal(state.phase, 'ready')
  assert.equal(state.currentId, 'b')
})

test('projectsReduce: projects-read with no savedId falls back to first', () => {
  const projects = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const state = projectsReduce(initialProjects, { kind: 'projects-read', projects, savedId: null })
  assert.equal(state.phase, 'ready')
  assert.equal(state.currentId, 'a')
})

test('projectsReduce: projects-failed sets failed phase', () => {
  const state = projectsReduce(initialProjects, { kind: 'projects-failed' })
  assert.equal(state.phase, 'failed')
  assert.equal(state.projects, null)
})

test('projectsReduce: switch to current id returns same state reference', () => {
  const projects = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const ready = projectsReduce(initialProjects, { kind: 'projects-read', projects, savedId: 'a' })
  const result = projectsReduce(ready, { kind: 'switch', id: 'a' })
  assert.equal(result, ready, 'same state reference when switching to current id')
})

test('projectsReduce: switch to a different id', () => {
  const projects = [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }]
  const ready = projectsReduce(initialProjects, { kind: 'projects-read', projects, savedId: 'a' })
  const result = projectsReduce(ready, { kind: 'switch', id: 'b' })
  assert.equal(result.currentId, 'b')
})

test('projectsReduce: switch to id not in list returns same state', () => {
  const projects = [{ id: 'a', name: 'A' }]
  const ready = projectsReduce(initialProjects, { kind: 'projects-read', projects, savedId: 'a' })
  const result = projectsReduce(ready, { kind: 'switch', id: 'gone' })
  assert.equal(result, ready)
})

test('projectsReduce: unknown action returns same state', () => {
  const result = projectsReduce(initialProjects, { kind: 'unknown' })
  assert.equal(result, initialProjects)
})

// ---- reset in plan, chats and ui reducers ----

test('reduce: reset returns initialState', () => {
  const withPlan = reduce(initialState, { kind: 'plan', plan: { groups: [] } })
  assert.notEqual(withPlan, initialState)
  assert.deepEqual(reduce(withPlan, { kind: 'reset' }), initialState)
})

test('chatsReduce: reset returns initialChats', () => {
  const withFailure = chatsReduce(initialChats, { kind: 'failure' })
  assert.notEqual(withFailure, initialChats)
  assert.deepEqual(chatsReduce(withFailure, { kind: 'reset' }), initialChats)
})

test('uiReduce: reset returns initialUi', () => {
  const withAsk = uiReduce(initialUi, { kind: 'ask', cardId: 'x' })
  assert.notEqual(withAsk, initialUi)
  assert.deepEqual(uiReduce(withAsk, { kind: 'reset' }), initialUi)
})

// ---- makeBackend with projectId ----

const BACKEND = '/apps/epic-board/api'
const captureBackend = (id) => {
  const calls = []
  const fetchFn = (url, options) => {
    calls.push([url, options])
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  }
  return { calls, backend: makeBackend(fetchFn, id) }
}

test('makeBackend: null id adds nothing to paths', async () => {
  const { calls, backend } = captureBackend(null)
  await backend.get('/chats').catch(() => {})
  assert.equal(calls[0][0], `${BACKEND}/chats`)
})

test('makeBackend: id adds ?project= query to /chats', async () => {
  const { calls, backend } = captureBackend('my-proj')
  await backend.get('/chats').catch(() => {})
  assert.equal(calls[0][0], `${BACKEND}/chats?project=my-proj`)
})

test('makeBackend: id adds query to /chats/<name>/started', async () => {
  const { calls, backend } = captureBackend('my-proj')
  await backend.post('/chats/abc123/started', {}).catch(() => {})
  assert.equal(calls[0][0], `${BACKEND}/chats/abc123/started?project=my-proj`)
})

test('makeBackend: id adds query to /chats/<name>', async () => {
  const { calls, backend } = captureBackend('my-proj')
  await backend.del('/chats/abc123').catch(() => {})
  assert.equal(calls[0][0], `${BACKEND}/chats/abc123?project=my-proj`)
})

// ---- Property 6: A switch resets exactly what it should ----
// A switch sets plan, chats and ui back to their initial values and changes only the project.

test('Property 6: a switch resets plan, chats and ui states exactly (100 iterations)', () => {
  const minPlan = { groups: [], branch: 'main', commit: 'abc', age_seconds: 0, refreshing: false, fetch: { ok: true }, problems: [] }
  const minRecords = { chats: [], folder: { id: 'f1', reason: null }, recordsError: null }
  const projects = [{ id: 'alpha', name: 'Alpha' }, { id: 'beta', name: 'Beta' }]

  forSeeds('switch resets plan, chats and ui', 100, (r) => {
    // Build a non-trivial plan state
    let planState = initialState
    for (let s = 0; s < r.int(1, 4); s += 1) {
      const k = r.pick(['plan', 'error', 'pending', 'failure'])
      planState = reduce(planState, k === 'plan' ? { kind: 'plan', plan: minPlan } : { kind: k })
    }

    // Build a non-trivial chats state
    let chatsState = initialChats
    for (let s = 0; s < r.int(1, 4); s += 1) {
      const k = r.pick(['failure', 'records'])
      chatsState = chatsReduce(chatsState, k === 'records' ? { kind: 'records', ...minRecords } : { kind: k })
    }

    // Build a non-trivial ui state
    let uiState = initialUi
    for (let s = 0; s < r.int(1, 3); s += 1) {
      uiState = uiReduce(uiState, { kind: r.pick(['ask', 'cancel']), cardId: 'some-card' })
    }

    // After reset, all should return to initial
    assert.deepEqual(reduce(planState, { kind: 'reset' }), initialState)
    assert.deepEqual(chatsReduce(chatsState, { kind: 'reset' }), initialChats)
    assert.deepEqual(uiReduce(uiState, { kind: 'reset' }), initialUi)

    // After switch, projectsReduce keeps projects and changes only currentId
    const readyProjects = projectsReduce(initialProjects, { kind: 'projects-read', projects, savedId: 'alpha' })
    const afterSwitch = projectsReduce(readyProjects, { kind: 'switch', id: 'beta' })
    assert.equal(afterSwitch.projects, readyProjects.projects)
    assert.equal(afterSwitch.phase, 'ready')
    assert.equal(afterSwitch.currentId, 'beta')
  })
})

// ---- Fake React for component property tests ----

const PLAN_URL = '/apps/epic-board/api/plan'
const PROJECTS_URL = '/apps/epic-board/api/projects'

const flush = async () => {
  for (let i = 0; i < 3; i += 1) await new Promise((resolve) => setImmediate(resolve))
}

function makeClock() {
  let now = 0
  let timers = []
  return {
    now: () => now,
    setTimeout(fn, ms) {
      const h = { fn, at: now + ms }
      timers.push(h)
      return h
    },
    clearTimeout(h) {
      timers = timers.filter((t) => t !== h)
    },
    advance(ms) {
      const target = now + ms
      for (;;) {
        const due = timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at)
        if (due.length === 0) break
        const t = due[0]
        timers = timers.filter((x) => x !== t)
        now = t.at
        t.fn()
      }
      now = target
    },
  }
}

function mountWith(fetchFn) {
  const clock = makeClock()
  const hooks = []
  let cursor = 0
  let pending = []
  let rendering = false
  let again = false
  let unmounted = false
  let tree = null

  const React = {
    useReducer(reducer, initial) {
      const index = cursor++
      if (hooks[index] === undefined) {
        const slot = { state: initial, reducer }
        slot.dispatch = (action) => {
          if (unmounted) return
          slot.state = slot.reducer(slot.state, action)
          doRender()
        }
        hooks[index] = slot
      }
      hooks[index].reducer = reducer
      return [hooks[index].state, hooks[index].dispatch]
    },
    useState(initial) {
      const index = cursor++
      if (hooks[index] === undefined) {
        const slot = { state: typeof initial === 'function' ? initial() : initial }
        slot.set = (value) => { if (unmounted) return; slot.state = value; doRender() }
        hooks[index] = slot
      }
      return [hooks[index].state, hooks[index].set]
    },
    useRef(initial) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { current: initial }
      return hooks[index]
    },
    useEffect(fn, deps) {
      const index = cursor++
      if (hooks[index] === undefined) hooks[index] = { ran: false, cleanup: null, deps: undefined }
      const slot = hooks[index]
      const changed = !slot.ran || deps === undefined || deps.some((dep, i) => !Object.is(dep, slot.deps?.[i]))
      if (changed) pending.push({ slot, fn, deps })
    },
    Component: class { constructor(props) { this.props = props } },
    createElement: (type, props, ...children) => ({
      type,
      props: props ?? {},
      children: children.flat(Infinity).filter((c) => c !== null && c !== undefined && c !== false),
    }),
  }

  const Board = createBoard(React, {
    fetch: fetchFn,
    document: { hidden: false, addEventListener: () => {}, removeEventListener: () => {} },
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
    now: clock.now,
    useAppApi: () => null,
    storage: undefined,
    Select: null,
  })

  function doRender() {
    if (rendering) { again = true; return }
    rendering = true
    do {
      again = false
      cursor = 0
      pending = []
      tree = Board({})
      for (const { slot, fn, deps } of pending) {
        if (typeof slot.cleanup === 'function') slot.cleanup()
        slot.ran = true
        slot.deps = deps
        const result = fn()
        slot.cleanup = typeof result === 'function' ? result : null
      }
    } while (again)
    rendering = false
  }

  doRender()

  return {
    clock,
    tree: () => tree,
    text: () => textOf(tree),
    unmount() {
      unmounted = true
      for (const slot of hooks) if (typeof slot.cleanup === 'function') slot.cleanup()
    },
  }
}

// ---- Property 5: The page never shows another project's answer ----
// Tests that after switching to P2, a stale P1 plan answer does not appear on the board.

test('Property 5: a stale plan answer from an old project is never shown (100 iterations)', async () => {
  await forSeedsAsync('stale plan answer ignored after switch', 100, async (r) => {
    const projects = [{ id: 'p1', name: 'P1' }, { id: 'p2', name: 'P2' }]
    const projectsCalls = []
    const planCalls = []

    const fetchFn = (url, opts) => new Promise((resolve, reject) => {
      opts?.signal?.addEventListener?.('abort', () =>
        reject(Object.assign(new Error('aborted'), { name: 'AbortError' })))
      if (url === PROJECTS_URL) { projectsCalls.push({ resolve, reject }); return }
      if (url.includes('/api/plan')) { planCalls.push({ resolve, reject, url }); return }
      // chats: never resolve (not under test)
    })

    const page = mountWith(fetchFn)

    // Answer projects fetch → projects ready, P1's plan #0 starts
    assert.equal(projectsCalls.length, 1, 'projects called on mount')
    projectsCalls[0].resolve({ ok: true, status: 200, json: async () => projects })
    await flush()
    assert.ok(planCalls.length >= 1, 'plan starts after projects')

    // Answer P1's initial plan to reach plan state (select becomes visible)
    const p1InitialPlan = { branch: 'p1-branch', commit: 'p1commit', age_seconds: 1, refreshing: false, fetch: { ok: true }, problems: [], groups: [] }
    planCalls[0].resolve({ ok: true, status: 200, json: async () => p1InitialPlan })
    await flush()
    assert.ok(page.text().includes('p1-branch'), 'p1 initial plan shows')

    // Advance clock to trigger P1's retry (plan #1 starts, is now in flight = stale candidate)
    page.clock.advance(15001)
    assert.ok(planCalls.length >= 2, 'p1 retry starts after 15s')
    const p1StaleIdx = planCalls.length - 1

    // Switch to P2 via the project select (now visible in plan state)
    const selects = findAll(page.tree(), (n) => n.props?.['aria-label'] === 'Project')
    assert.equal(selects.length, 1, 'project dropdown present')
    selects[0].props.onChange({ target: { value: 'p2' } })
    await flush()

    // P2's plan is now in flight; P1's retry was aborted by the switch
    assert.ok(planCalls.length >= p1StaleIdx + 2, 'p2 plan starts after switch')
    const p2PlanIdx = planCalls.length - 1

    // Board is back in loading state after the reset; p1-branch must not show
    assert.ok(!page.text().includes('p1-branch'), 'p1 cleared after switch')

    // Optionally deliver P1's stale retry answer (live() guard blocks it)
    if (r.bool()) {
      planCalls[p1StaleIdx].resolve({ ok: true, status: 200, json: async () => p1InitialPlan })
      await flush()
      assert.ok(!page.text().includes('p1-branch'), 'stale p1 retry must not show')
    }

    // Deliver P2's plan → board should show it
    const p2Plan = { branch: 'p2-branch', commit: 'p2commit', age_seconds: 2, refreshing: false, fetch: { ok: true }, problems: [], groups: [] }
    planCalls[p2PlanIdx].resolve({ ok: true, status: 200, json: async () => p2Plan })
    await flush()

    assert.ok(page.text().includes('p2-branch'), 'p2 answer must show')
    assert.ok(!page.text().includes('p1-branch'), 'p1 must not show after p2')

    page.unmount()
  })
})
