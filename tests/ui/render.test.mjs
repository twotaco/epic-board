// renderBoard and STYLE: structure, roles, literal text, card content, states, theme.
// Validates: Requirements 1.3, 1.4, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 8.1, 8.3,
//            9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 10.1, 10.2, 10.3, 10.4
//
// Views are built the way the page builds them: classify -> reduce -> viewOf.
// The trees are made with the `h` of support.mjs, so they hold {type, props, children}.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  STYLE, TITLE_LEVEL, chatHref, classify, columnsOf, initialChats, initialState, progressOf, reduce, renderBoard, renderPanel, renderShell, viewOf,
} from '../../ui/index.mjs'
import { baseSeed, findAll, forSeeds, h, textOf, walk } from './support.mjs'

const ITERATIONS = 120
const STATUSES = ['planned', 'in progress', 'done']
const COMMIT = '9f2c1d4e8a7b6c5d4e3f2a1b0c9d8e7f6a5b4c3d'
const UNREACHABLE_NOTICE = 'Could not reach the backend. Showing the plan from the last update.'

// ---- Builders: plan bodies as the backend sends them ----

function card(name, status, spec, tasks, epic, description = '') {
  return { name, status, spec, tasks, epic, description }
}

function groupsOfExample() {
  return [
    {
      epic: { name: 'Epic Board', file: 'epic-board.md' },
      cards: [
        card('Read the plan from main', 'done', 'read-the-plan-from-main', { done: 12, total: 12 }, 'Epic Board', 'The backend returns the plan as data.'),
        card('Show the board', 'in progress', 'show-the-board', { done: 2, total: 9 }, 'Epic Board', 'Replaces the placeholder page.'),
        card('Start a story', 'planned', null, null, 'Epic Board', ''),
      ],
    },
    {
      epic: { name: 'Hardening', file: 'hardening.md' },
      cards: [
        card('Show the board', 'planned', 'show-the-board', { done: 2, total: 9 }, 'Hardening', 'Listed again here.'),
        card('Add retries', 'planned', 'add-retries', { done: 0, total: 0 }, 'Hardening', ''),
      ],
    },
    {
      epic: null,
      cards: [
        card('Loose spec', 'planned', 'loose-spec', null, null, 'Only in standalone.md.'),
        card('One task only', 'done', 'one-task', { done: 1, total: 1 }, null, ''),
      ],
    },
  ]
}

function planBody(over = {}) {
  return {
    repository: '/Users/me/projects/example',
    branch: 'main',
    ref: 'origin/main',
    commit: COMMIT,
    fetch: { ok: true },
    groups: groupsOfExample(),
    problems: [],
    age_seconds: 42,
    refreshing: false,
    ...over,
  }
}

function problemsOf(n) {
  return Array.from({ length: n }, (_, i) => ({
    file: `.kiro/specs/spec-${i}/tasks.md`,
    reason: `Line ${i + 1}: a task has no checkbox (${'x'.repeat(10 * (i + 1))})`,
  }))
}

function errorBody(settings = true) {
  const error = { code: 'repository_not_configured', message: 'No repository is set.' }
  if (settings) error.settings = ['EPIC_BOARD_REPOSITORY', '/Users/me/.kiro/epic-board.json']
  return { error }
}

// ---- Views, built through the page's own functions ----

function planView(plan, { unreachable = false } = {}) {
  let state = reduce(initialState, classify(200, plan))
  if (unreachable) state = reduce(state, classify(200, null))
  return viewOf(state)
}

const loadingView = () => viewOf(initialState)
const unreachableView = () => viewOf(reduce(initialState, classify(200, null)))
const errorView = (settings = true) => viewOf(reduce(initialState, classify(409, errorBody(settings))))

// Every combination of plan overlays, for plans with cards, without a card and with an empty group.
function allViews() {
  const views = [
    { name: 'loading', view: loadingView() },
    { name: 'unreachable, no plan', view: unreachableView() },
    { name: 'error with settings', view: errorView(true) },
    { name: 'error without settings', view: errorView(false) },
    {
      name: 'error then unreachable',
      view: viewOf(reduce(reduce(initialState, classify(409, errorBody())), classify(200, null))),
    },
  ]
  const fetches = [{ ok: null }, { ok: true }, { ok: false, reason: 'fatal: unable to access origin' }, { ok: false }]
  const shapes = {
    cards: () => groupsOfExample(),
    'no groups': () => [],
    'empty epic group': () => [{ epic: { name: 'Empty', file: 'empty.md' }, cards: [] }],
  }
  for (const fetch of fetches) {
    for (const unreachable of [false, true]) {
      for (const refreshing of [false, true]) {
        for (const problems of [0, 1, 3]) {
          for (const [shape, groups] of Object.entries(shapes)) {
            const plan = planBody({ fetch, refreshing, problems: problemsOf(problems), groups: groups() })
            views.push({
              name: `plan fetch=${JSON.stringify(fetch)} unreachable=${unreachable} refreshing=${refreshing} problems=${problems} ${shape}`,
              view: planView(plan, { unreachable }),
              plan,
              unreachable,
            })
          }
        }
      }
    }
  }
  return views
}

const render = (view) => renderBoard(h, view)

// ---- Tree helpers ----

const isElement = (node) => node !== null && typeof node === 'object'
const HEADING = /^h([1-6])$/

function elements(tree) {
  return findAll(tree, () => true)
}

function headingLevels(tree) {
  const levels = []
  walk(tree, (node) => {
    const match = isElement(node) && typeof node.type === 'string' ? HEADING.exec(node.type) : null
    if (match) levels.push(Number(match[1]))
  })
  return levels
}

// Text of a subtree without the style sheet.
function visibleText(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (!isElement(node) || node.type === 'style') return ''
  return node.children.map(visibleText).join('')
}

// The `li` of the cards: every `li` outside a `details`.
function cardItems(tree) {
  const items = []
  const visit = (node) => {
    if (!isElement(node) || node.type === 'details') return
    if (node.type === 'li') items.push(node)
    node.children.forEach(visit)
  }
  visit(tree)
  return items
}

// Cards in the order the page shows them: column by column, group by group.
function shownCards(plan) {
  return columnsOf(plan).flatMap((column) => column.groups.flatMap((group) => group.cards))
}

const withText = (tree, text) => findAll(tree, (node) => node.children.length === 1 && node.children[0] === text)
const rolesOf = (tree) => findAll(tree, (node) => node.props.role !== undefined).map((node) => node.props.role)

// Checks that hold for every view: no control, one disclosure at most, heading levels, no raw HTML.
function assertStructure(tree, label, { cardControls = false } = {}) {
  // 1.3 (as start-a-story edited it, set-up-projects added the header button): nothing responds to a
  // click or key but the one summary, the controls of Requirements 2, 7 and 8 (all inside a card),
  // and the Projects button in the header row. A view with no chats has only the Projects button.
  const interactive = elements(tree).filter((node) => {
    const keys = Object.keys(node.props)
    return ['a', 'button', 'input', 'select', 'textarea', 'label', 'form'].includes(node.type)
      || keys.some((key) => /^on[A-Z]/.test(key) || key === 'href' || key === 'tabIndex' || key === 'contentEditable')
      || ['button', 'link', 'checkbox', 'menuitem', 'tab', 'switch'].includes(node.props.role)
  })
  const insideCards = new Set(findAll(tree, (node) => node.type === 'li' && /(^| )eb-card( |$)/.test(node.props.className ?? '')).flatMap((li) => elements(li)))
  // The epic dropdown (epic filter, Requirement 1.1) is the one control outside a card.
  const insideFilter = new Set(findAll(tree, (node) => node.props.className === 'eb-filter').flatMap((box) => elements(box)))
  // The Panel's header holds its "Close" button (work-in-the-chat). Nothing else in the Panel is the page's own control.
  // The Panel's own container is focusable by script only (tabindex -1) and does nothing when used.
  const insidePanelHead = new Set(findAll(tree, (node) => node.props.className === 'eb-panel-head' || node.props['data-eb-panel'] !== undefined)
    .flatMap((box) => (box.props['data-eb-panel'] !== undefined ? [box] : elements(box))))
  // The board header holds the Projects button (set-up-projects, Requirement 4.1).
  const insideHeader = new Set(findAll(tree, (node) => node.props.className === 'eb-header').flatMap((box) => elements(box)))
  assert.deepEqual(interactive.filter((node) => !insideCards.has(node) && !insideFilter.has(node) && !insidePanelHead.has(node) && !insideHeader.has(node)), [], `${label}: interactive element outside a card`)
  if (!cardControls) assert.deepEqual(interactive.filter((node) => !insideFilter.has(node) && !insidePanelHead.has(node) && !insideHeader.has(node)), [], `${label}: a view with no chats has no control`)
  const details = findAll(tree, (node) => node.type === 'details')
  const summaries = findAll(tree, (node) => node.type === 'summary')
  assert.ok(details.length <= 1, `${label}: more than one details`)
  assert.equal(summaries.length, details.length, `${label}: summary count`)
  for (const node of details) assert.equal(node.props.open, undefined, `${label}: details is open`)

  // 1.4: plan text is never HTML.
  for (const node of elements(tree)) {
    assert.equal(node.props.dangerouslySetInnerHTML, undefined, `${label}: dangerouslySetInnerHTML`)
    assert.equal(node.props.innerHTML, undefined, `${label}: innerHTML`)
  }

  // 10.2: the title first, no level skipped.
  const levels = headingLevels(tree)
  assert.equal(levels[0], TITLE_LEVEL, `${label}: first heading is the title`)
  assert.equal(levels.filter((level) => level === TITLE_LEVEL).length, 1, `${label}: one title`)
  levels.forEach((level, i) => {
    if (i > 0) assert.ok(level <= levels[i - 1] + 1, `${label}: level ${level} after ${levels[i - 1]}`)
    assert.ok(level >= TITLE_LEVEL && level <= TITLE_LEVEL + 2, `${label}: level ${level} out of range`)
  })
}

// ---- Structure of every view ----

test('every view: no control or click handler, one details at most, only summary is interactive', () => {
  const all = allViews()
  assert.ok(all.length > 100)
  for (const { name, view } of all) assertStructure(render(view), name)
})

test('the title is h<TITLE_LEVEL>, columns one below it, groups two below, in every state', () => {
  assert.ok(Number.isInteger(TITLE_LEVEL) && TITLE_LEVEL >= 1 && TITLE_LEVEL + 2 <= 6)
  for (const { name, view } of allViews()) {
    const tree = render(view)
    const title = findAll(tree, (node) => node.type === `h${TITLE_LEVEL}`)
    assert.equal(title.length, 1, name)
    assert.equal(textOf(title[0]), 'Epic Board', name)

    const expected = [TITLE_LEVEL]
    if (view.kind === 'plan' && !view.empty) {
      for (const column of view.columns) {
        expected.push(TITLE_LEVEL + 1)
        for (let i = 0; i < column.groups.length; i += 1) expected.push(TITLE_LEVEL + 2)
      }
    }
    assert.deepEqual(headingLevels(tree), expected, name)
  }
})

test('column headings read Planned, In progress, Done with their counts; group headings follow the plan', () => {
  const plan = planBody()
  const tree = render(planView(plan))
  const columns = columnsOf(plan)
  const columnHeadings = findAll(tree, (node) => node.type === `h${TITLE_LEVEL + 1}`)
  assert.equal(columnHeadings.length, 3)
  columnHeadings.forEach((heading, i) => {
    const text = textOf(heading)
    assert.match(text, new RegExp(`^${columns[i].title}\\s*${columns[i].count}$`))
  })
  assert.deepEqual(columnHeadings.map((heading) => textOf(heading).replace(/\s*\d+$/, '')), ['Planned', 'In progress', 'Done'])
  // Planned: Epic Board, Hardening, then No epic. In progress: Epic Board. Done: Epic Board, No epic.
  const groupHeadings = findAll(tree, (node) => node.type === `h${TITLE_LEVEL + 2}`).map(textOf)
  assert.deepEqual(groupHeadings, ['Epic Board', 'Hardening', 'No epic', 'Epic Board', 'Epic Board', 'No epic'])
})

test('the roles in each view, and no alert but the two error states', () => {
  assert.deepEqual(rolesOf(render(loadingView())), ['status'])
  assert.deepEqual(textOf(findAll(render(loadingView()), (n) => n.props.role === 'status')[0]), 'Loading…')

  for (const view of [unreachableView(), viewOf(reduce(reduce(initialState, classify(409, errorBody())), classify(200, null)))]) {
    const tree = render(view)
    assert.deepEqual(rolesOf(tree), ['alert'])
    assert.equal(visibleText(findAll(tree, (n) => n.props.role === 'alert')[0]), 'Could not reach the backend.')
  }

  for (const view of [errorView(true), errorView(false)]) {
    const tree = render(view)
    assert.deepEqual(rolesOf(tree), ['alert'])
    const alert = findAll(tree, (n) => n.props.role === 'alert')[0]
    assert.ok(textOf(alert).includes('No repository is set.'))
  }

  for (const { name, view, plan, unreachable } of allViews().filter((entry) => entry.plan)) {
    const tree = render(view)
    const expected = []
    if (plan.fetch.ok === false) expected.push('status')
    if (unreachable) expected.push('status')
    assert.deepEqual(rolesOf(tree), expected, name)
    assert.equal(findAll(tree, (n) => n.props.role === 'alert').length, 0, name)
  }
})

// ---- Text from the plan is a literal child (1.4) ----

test('markup in names, descriptions, folders, messages, settings and problems is a literal child', () => {
  const B = '<b>x</b>'
  const S = '<script>alert(1)</script>'
  const plan = planBody({
    branch: `${B}-branch`,
    fetch: { ok: false, reason: `${S} reason` },
    problems: [{ file: `${B}/tasks.md`, reason: `${S} unreadable` }],
    groups: [
      { epic: { name: `${B} epic`, file: 'e.md' }, cards: [card(`${B} name`, 'planned', `${B}-folder`, { done: 1, total: 2 }, 'x', `${S} description`)] },
    ],
  })
  const planTree = render(planView(plan))
  const errorTree = render(viewOf(reduce(initialState, classify(409, {
    error: { code: `${B}code`, message: `${S} message`, settings: [`${B}SETTING`, `${S}`] },
  }))))

  const expectedStrings = [
    `${B}-branch`, `${S} reason`, `${B}/tasks.md`, `${S} unreadable`,
    `${B} epic`, `${B} name`, `${B}-folder`, `${S} description`,
  ]
  for (const text of expectedStrings) {
    assert.ok(withText(planTree, text).length >= 1, `not a literal child: ${text}`)
    assert.ok(textOf(planTree).includes(text))
  }
  for (const text of [`${B}code`, `${S} message`, `${B}SETTING`, S]) {
    assert.ok(withText(errorTree, text).length >= 1, `not a literal child: ${text}`)
  }
  for (const tree of [planTree, errorTree]) {
    assertStructure(tree, 'markup')
    for (const node of elements(tree)) {
      assert.ok(!['b', 'script', 'img', 'iframe'].includes(node.type), `element ${node.type} made from text`)
      for (const [key, value] of Object.entries(node.props)) {
        if (typeof value === 'string') assert.ok(!value.includes('<'), `markup in prop ${key}`)
      }
    }
    // The only child of the style element is the style sheet.
    const styles = findAll(tree, (node) => node.type === 'style')
    assert.equal(styles.length, 1)
    assert.deepEqual(styles[0].children, [STYLE])
  }
})

// ---- Cards ----

function assertCard(item, expected) {
  const progress = progressOf(expected)
  assert.equal(
    visibleText(item),
    expected.name + (expected.description ?? '') + (expected.spec ?? '') + progress.text,
    `card ${expected.name}: text`,
  )
  const bars = findAll(item, (node) => node.props['aria-hidden'] !== undefined)
  assert.equal(bars.length, progress.fraction === null ? 0 : 1, `card ${expected.name}: bar`)
  for (const bar of bars) assert.equal(bar.props['aria-hidden'], 'true')
}

test('cards show name, description when not empty, folder name and progress', () => {
  const plan = planBody()
  const tree = render(planView(plan))
  const items = cardItems(tree)
  const cards = shownCards(plan)
  assert.equal(items.length, cards.length)
  items.forEach((item, i) => {
    assert.equal(textOf(item).startsWith(cards[i].name), true, `card ${i} in order`)
    assertCard(item, cards[i])
  })

  const find = (name, epic) => items[cards.findIndex((c) => c.name === name && c.epic === epic)]

  // 3.1 and 3.2: description below the name, folder name as plain text, not a path.
  const show = find('Show the board', 'Epic Board')
  assert.equal(visibleText(show), 'Show the boardReplaces the placeholder page.show-the-board2 of 9 tasks')
  assert.ok(withText(show, 'show-the-board').length === 1)
  assert.ok(!textOf(show).includes('.kiro/specs'))
  const bar = findAll(show, (node) => node.props['aria-hidden'] === 'true')
  assert.equal(bar.length, 1)
  assert.ok(textOf(bar[0]) === '', 'the bar carries no text')
  const fill = bar[0].children[0]
  assert.ok(Math.abs(parseFloat(fill.props.style.width) - (2 / 9) * 100) < 1e-6)

  // 3.1: no description line for an empty description.
  const one = find('One task only', null)
  assert.equal(visibleText(one), 'One task onlyone-task1 of 1 task')

  // 3.3: no spec: "No spec yet", no folder line, no bar.
  const none = find('Start a story', 'Epic Board')
  assert.equal(visibleText(none), 'Start a storyNo spec yet')
  assert.equal(findAll(none, (node) => node.props['aria-hidden'] !== undefined).length, 0)

  // 3.5: no tasks yet, tasks that could not be read: no bar.
  const empty = find('Add retries', 'Hardening')
  assert.equal(visibleText(empty), 'Add retriesadd-retriesNo tasks yet')
  assert.equal(findAll(empty, (node) => node.props['aria-hidden'] !== undefined).length, 0)
  const unread = find('Loose spec', null)
  assert.equal(visibleText(unread), 'Loose specOnly in standalone.md.loose-specTasks could not be read')
  assert.equal(findAll(unread, (node) => node.props['aria-hidden'] !== undefined).length, 0)
})

test('a bar is drawn only with a fraction, and is hidden from assistive technology', () => {
  const plan = planBody({
    groups: [{
      epic: null,
      cards: [
        card('Zero of three', 'planned', 'a', { done: 0, total: 3 }, null),
        card('All done', 'done', 'b', { done: 3, total: 3 }, null),
        card('No spec', 'planned', null, null, null),
        card('No tasks', 'planned', 'c', { done: 0, total: 0 }, null),
        card('Unreadable', 'planned', 'd', null, null),
      ],
    }],
  })
  const tree = render(planView(plan))
  // The column's status dot is aria-hidden too (board-design), so the bars are found by their class.
  const bars = findAll(tree, (node) => node.props.className === 'eb-bar')
  assert.equal(bars.length, 2)
  for (const bar of bars) assert.equal(bar.props['aria-hidden'], 'true')
  const items = cardItems(tree)
  assert.equal(items.length, 5)
  // Document order is the Planned column, then Done: the first card, the three without a bar, then "All done".
  assert.deepEqual(items.map((item) => textOf(item).slice(0, 8)), ['Zero of ', 'No specN', 'No tasks', 'Unreadab', 'All done'])
  assert.deepEqual(items.map((item) => findAll(item, (n) => n.props['aria-hidden'] === 'true').length), [1, 0, 0, 0, 1])
  const widths = bars.map((bar) => bar.children[0].props.style.width)
  assert.deepEqual(widths, ['0%', '100%'])
})

test('a card with one task reads "1 of 1 task" and a card with three reads "tasks"', () => {
  const plan = planBody({
    groups: [{ epic: null, cards: [card('A', 'planned', 'a', { done: 1, total: 1 }, null), card('B', 'planned', 'b', { done: 1, total: 3 }, null)] }],
  })
  const tree = render(planView(plan))
  assert.equal(withText(tree, '1 of 1 task').length, 1)
  assert.equal(withText(tree, '1 of 3 tasks').length, 1)
})

test('"Nothing here" shows once for each column without cards', () => {
  const onlyPlanned = planBody({ groups: [{ epic: null, cards: [card('A', 'planned', 'a', null, null)] }] })
  assert.equal(withText(render(planView(onlyPlanned)), 'Nothing here').length, 2)
  assert.equal(withText(render(planView(planBody())), 'Nothing here').length, 0)
  const onlyDone = planBody({ groups: [{ epic: { name: 'E', file: 'e.md' }, cards: [card('A', 'done', 'a', null, 'E')] }] })
  const tree = render(planView(onlyDone))
  assert.equal(withText(tree, 'Nothing here').length, 2)
  // Each "Nothing here" sits in the column of an empty status, after its heading.
  const order = []
  walk(tree, (node) => {
    if (!isElement(node)) return
    if (node.type === `h${TITLE_LEVEL + 1}`) order.push(textOf(node).replace(/\s*\d+$/, ''))
    if (node.children.length === 1 && node.children[0] === 'Nothing here') order.push('Nothing here')
  })
  assert.deepEqual(order, ['Planned', 'Nothing here', 'In progress', 'Nothing here', 'Done'])
})

// ---- Header, refresh slot, notices ----

test('the header shows the branch, the first 7 characters of the commit and the age text', () => {
  const cases = [
    [null, 'Not yet updated from origin'],
    [5, 'Updated less than a minute ago'],
    [300, 'Updated 5 minutes ago'],
    [3600, 'Updated 1 hour ago'],
    [86400 * 3, 'Updated 3 days ago'],
  ]
  for (const [age, text] of cases) {
    const tree = render(planView(planBody({ age_seconds: age, branch: 'trunk' })))
    const shown = visibleText(tree)
    assert.ok(withText(tree, 'trunk').length >= 1)
    assert.ok(withText(tree, COMMIT.slice(0, 7)).length === 1, 'the commit shows as 7 characters')
    assert.ok(!shown.includes(COMMIT.slice(0, 8)), 'no more than 7 characters of the commit')
    assert.ok(withText(tree, text).length === 1, `age text ${text}`)
  }
})

test('"Checking for updates…" is always in the tree, hidden unless refreshing', () => {
  for (const refreshing of [true, false]) {
    for (const fetch of [{ ok: null }, { ok: true }, { ok: false, reason: 'r' }]) {
      for (const shape of [planBody().groups, []]) {
        const tree = render(planView(planBody({ refreshing, fetch, groups: shape })))
        const slots = withText(tree, 'Checking for updates…')
        assert.equal(slots.length, 1, `refreshing=${refreshing}`)
        assert.equal(slots[0].props.style?.visibility, refreshing ? 'visible' : 'hidden')
        assert.equal(slots[0].props.style?.display, undefined, 'the space is kept')
      }
    }
  }
  // A refreshing flag that is not `true` counts as false.
  const tree = render(planView(planBody({ refreshing: undefined })))
  assert.equal(withText(tree, 'Checking for updates…')[0].props.style.visibility, 'hidden')
})

test('the failed-fetch notice has a status role, the reason, the age text and "earlier copy"', () => {
  const tree = render(planView(planBody({ fetch: { ok: false, reason: 'fatal: unable to access origin' }, age_seconds: 125 })))
  const notices = findAll(tree, (node) => node.props.role === 'status')
  assert.equal(notices.length, 1)
  const text = textOf(notices[0])
  assert.ok(text.includes('fatal: unable to access origin'))
  assert.ok(text.includes('Updated 2 minutes ago'))
  assert.ok(text.includes('earlier copy'))
  assert.ok(text.toLowerCase().includes('fetch'))

  // No reason: the notice still says so, and shows the age.
  const noReason = render(planView(planBody({ fetch: { ok: false }, age_seconds: null })))
  const bare = textOf(findAll(noReason, (node) => node.props.role === 'status')[0])
  assert.ok(bare.includes('earlier copy'))
  assert.ok(bare.includes('Not yet updated from origin'))
  assert.ok(!bare.includes('undefined') && !bare.includes('null'))

  // No notice for ok true or null.
  for (const fetch of [{ ok: true }, { ok: null }]) {
    assert.deepEqual(rolesOf(render(planView(planBody({ fetch })))), [])
  }
})

test('the notice sits above the columns, and the problems disclosure sits below them', () => {
  for (const groups of [planBody().groups, []]) {
    const plan = planBody({ fetch: { ok: false, reason: 'r' }, problems: problemsOf(2), groups })
    const tree = render(planView(plan, { unreachable: true }))
    const sequence = []
    walk(tree, (node) => {
      if (!isElement(node)) return
      if (node.props.role === 'status' && textOf(node).includes('earlier copy')) sequence.push('failed')
      if (node.props.role === 'status' && textOf(node) === UNREACHABLE_NOTICE) sequence.push('unreachable')
      if (node.type === `h${TITLE_LEVEL + 1}` && !sequence.includes('body')) sequence.push('body')
      if (node.children.length === 1 && typeof node.children[0] === 'string' && node.children[0].startsWith('No specs or epics were found')) sequence.push('body')
      if (node.type === 'details') sequence.push('problems')
    })
    assert.deepEqual(sequence, ['failed', 'unreachable', 'body', 'problems'])
  }
})

test('the unreachable notice and the unreachable state', () => {
  const withNotice = render(planView(planBody(), { unreachable: true }))
  const notices = findAll(withNotice, (node) => node.props.role === 'status')
  assert.equal(notices.length, 1)
  assert.equal(textOf(notices[0]), UNREACHABLE_NOTICE)
  // The board stays in place under the notice.
  assert.equal(cardItems(withNotice).length, shownCards(planBody()).length)

  // No plan was ever shown: the error state, with no code and no board.
  const tree = render(unreachableView())
  assert.equal(visibleText(tree), 'Epic BoardCould not reach the backend.')
  assert.equal(findAll(tree, (node) => node.type === `h${TITLE_LEVEL + 1}`).length, 0)
  assert.equal(findAll(tree, (node) => node.type === 'code').length, 0)
  assert.equal(findAll(tree, (node) => node.type === 'details').length, 0)
})

test('"Loading…" shows with no columns, no header and no notice', () => {
  const tree = render(loadingView())
  assert.equal(visibleText(tree), 'Epic BoardLoading…')
  assert.equal(findAll(tree, (node) => node.type === `h${TITLE_LEVEL + 1}`).length, 0)
  assert.equal(withText(tree, 'Checking for updates…').length, 0)
})

test('the empty plan shows its text in place of the columns', () => {
  for (const groups of [[], [{ epic: { name: 'Empty', file: 'empty.md' }, cards: [] }], [{ epic: null, cards: [] }]]) {
    const tree = render(planView(planBody({ branch: 'develop', groups })))
    assert.equal(withText(tree, 'No specs or epics were found on develop.').length, 1)
    const hint = findAll(tree, (node) => node.children.length === 1 && typeof node.children[0] === 'string' && node.children[0].includes('.kiro/specs/'))
    assert.equal(hint.length, 1)
    assert.ok(textOf(hint[0]).includes('docs/epics/'))
    assert.equal(findAll(tree, (node) => node.type === `h${TITLE_LEVEL + 1}`).length, 0, 'no columns')
    assert.equal(withText(tree, 'Nothing here').length, 0)
    assert.equal(cardItems(tree).length, 0)
  }
  // A plan with a card does not show it.
  assert.equal(withText(render(planView(planBody())), 'No specs or epics were found on main.').length, 0)
})

test('the empty plan still shows the failed-fetch notice and the problems disclosure', () => {
  const tree = render(planView(planBody({ groups: [], fetch: { ok: false, reason: 'offline' }, problems: problemsOf(1) })))
  assert.ok(textOf(findAll(tree, (node) => node.props.role === 'status')[0]).includes('offline'))
  assert.equal(findAll(tree, (node) => node.type === 'details').length, 1)
})

// ---- The error state ----

test('the error view shows the message, the code and each setting as code text, in order', () => {
  const tree = render(errorView(true))
  const shown = visibleText(tree)
  assert.ok(shown.includes('No repository is set.'))
  assert.ok(shown.includes('repository_not_configured'))
  const codes = findAll(tree, (node) => node.type === 'code')
  assert.deepEqual(codes.map(textOf), ['EPIC_BOARD_REPOSITORY', '/Users/me/.kiro/epic-board.json'])
  assert.equal(findAll(tree, (node) => node.type === `h${TITLE_LEVEL + 1}`).length, 0, 'no columns')

  const bare = render(errorView(false))
  assert.equal(findAll(bare, (node) => node.type === 'code').length, 0)
  assert.ok(visibleText(bare).includes('repository_not_configured'))

  // The message and the code are two separate pieces of text.
  assert.ok(withText(tree, 'No repository is set.').length === 1)
  assert.ok(withText(tree, 'repository_not_configured').length === 1)
})

// ---- The problems disclosure ----

test('the disclosure counts the files and lists every problem untruncated, in order', () => {
  assert.equal(findAll(render(planView(planBody())), (node) => node.type === 'details').length, 0)

  for (const n of [1, 2, 7]) {
    const problems = problemsOf(n)
    problems[n - 1] = { file: `.kiro/specs/${'long-folder-'.repeat(40)}/tasks.md`, reason: `${'very long reason '.repeat(200)}END` }
    const tree = render(planView(planBody({ problems })))
    const details = findAll(tree, (node) => node.type === 'details')
    assert.equal(details.length, 1)
    assert.equal(details[0].props.open, undefined)
    const summary = findAll(details[0], (node) => node.type === 'summary')
    assert.equal(summary.length, 1)
    assert.equal(textOf(summary[0]), n === 1 ? '1 file could not be read' : `${n} files could not be read`)
    assert.equal(details[0].children[0], summary[0], 'the summary comes first')

    const text = textOf(details[0])
    let from = 0
    for (const problem of problems) {
      const fileAt = text.indexOf(problem.file, from)
      assert.ok(fileAt >= from, `file ${problem.file.slice(0, 30)} listed in order`)
      const reasonAt = text.indexOf(problem.reason, fileAt + problem.file.length)
      assert.ok(reasonAt >= 0, 'reason listed whole after its file')
      from = reasonAt + problem.reason.length
    }
    assert.equal(findAll(details[0], (node) => node.type === 'li').length, n)
    assert.ok(text.includes('END'))
  }
})

// ---- STYLE ----

const NAMED_COLOURS = new Set(`aliceblue antiquewhite aqua aquamarine azure beige bisque black blanchedalmond blue blueviolet brown
burlywood cadetblue chartreuse chocolate coral cornflowerblue cornsilk crimson cyan darkblue darkcyan darkgoldenrod darkgray
darkgreen darkgrey darkkhaki darkmagenta darkolivegreen darkorange darkorchid darkred darksalmon darkseagreen darkslateblue
darkslategray darkslategrey darkturquoise darkviolet deeppink deepskyblue dimgray dimgrey dodgerblue firebrick floralwhite
forestgreen fuchsia gainsboro ghostwhite gold goldenrod gray green greenyellow grey honeydew hotpink indianred indigo ivory
khaki lavender lavenderblush lawngreen lemonchiffon lightblue lightcoral lightcyan lightgoldenrodyellow lightgray lightgreen
lightgrey lightpink lightsalmon lightseagreen lightskyblue lightslategray lightslategrey lightsteelblue lightyellow lime
limegreen linen magenta maroon mediumaquamarine mediumblue mediumorchid mediumpurple mediumseagreen mediumslateblue
mediumspringgreen mediumturquoise mediumvioletred midnightblue mintcream mistyrose moccasin navajowhite navy oldlace olive
olivedrab orange orangered orchid palegoldenrod palegreen paleturquoise palevioletred papayawhip peachpuff peru pink plum
powderblue purple rebeccapurple red rosybrown royalblue saddlebrown salmon sandybrown seagreen seashell sienna silver skyblue
slateblue slategray slategrey snow springgreen steelblue tan teal thistle tomato turquoise violet wheat white whitesmoke
yellow yellowgreen`.split(/\s+/))

const COLOUR_PROPERTY = /^(color|background(-color|-image)?|border(-[a-z]+)*|outline(-[a-z]+)*|box-shadow|text-shadow|fill|stroke|caret-color|accent-color|text-decoration(-color)?|column-rule(-color)?)$/

// A colour value the page may give `color`: currentColor, inherit, or a theme token whose second argument is currentColor.
const TOKEN_COLOUR = /^(currentColor|inherit|var\(--[a-z-]+,\s*currentColor\))$/

// Returns what is wrong with a style sheet's colours and focus rules, as a list of messages.
// A grey of the page's own is allowed only in a rule whose selector has the fallback marker `.eb-fb`.
function themeProblems(css) {
  const problems = []
  if (/#[0-9a-f]{3,8}\b/i.test(css)) problems.push('hex colour')
  for (const rule of css.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const [, selector, body] = rule
    for (const match of body.matchAll(/\b(rgba?|hsla?|hwb|lab|lch|oklab|oklch|color|color-mix)\(([^)]*)\)/gi)) {
      const [, fn, args] = match
      const grey = /^\s*128\s*,\s*128\s*,\s*128\s*,\s*(\d*\.?\d+)\s*$/.exec(args)
      const alpha = grey ? Number(grey[1]) : NaN
      if (!/^rgba?$/i.test(fn) || !grey || !(alpha > 0 && alpha < 1)) problems.push(`colour function ${match[0]}`)
      else if (!selector.includes('.eb-fb')) problems.push(`grey outside a fallback rule: ${selector.trim()}`)
    }
  }
  for (const match of css.matchAll(/([a-z-]+)\s*:\s*([^;{}]+?)\s*(?=;|\})/gi)) {
    const [, property, value] = match
    const name = property.toLowerCase()
    if (name === 'background-color') problems.push(`${name} property`)
    if (name === 'color' && !TOKEN_COLOUR.test(value.trim())) problems.push(`${name} property: ${value}`)
    if (COLOUR_PROPERTY.test(name)) {
      const bare = value.replace(/\b(rgba?|hsla?)\([^)]*\)/gi, ' ')
      for (const token of bare.split(/[\s,()]+/)) {
        if (NAMED_COLOURS.has(token.toLowerCase())) problems.push(`named colour ${token} in ${name}`)
      }
    }
    if (/^outline(-style|-width)?$/.test(name) && /^(none|hidden|0(px)?)(\s|$)/i.test(value.trim())) problems.push(`${name}: ${value}`)
  }
  return problems
}

function blockBody(css, header) {
  const start = css.indexOf(header)
  if (start < 0) return null
  const open = css.indexOf('{', start)
  let depth = 0
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === '{') depth += 1
    if (css[i] === '}') {
      depth -= 1
      if (depth === 0) return css.slice(open + 1, i)
    }
  }
  return null
}

test('the theme scan finds bad colours and focus rules, so a clean result means something', () => {
  const bad = [
    '.a { color: red; }',
    '.a { background-color: transparent; }',
    '.a { background: #fff; }',
    '.a { background: #ffffff }',
    '.a { border: 1px solid rgb(0, 0, 0); }',
    '.a { border: 1px solid rgba(0, 0, 0, 0.5); }',
    '.a { background: rgba(128, 128, 128, 1); }',
    '.a { background: rgba(128, 128, 128, 0); }',
    '.a { border-color: Tomato; }',
    '.a { background: hsl(0, 0%, 50%); }',
    '.a { outline: none; }',
    '.a:focus { outline: 0; }',
    '.a { outline-style: none; }',
    '.a { background: rgba(128, 128, 128, 0.1); }',
    '.a { color: var(--muted); }',
    '.a { color: var(--muted, red); }',
  ]
  for (const css of bad) assert.notDeepEqual(themeProblems(css), [], css)
  const good = '.a.eb-fb { border: 1px solid currentColor; background: rgba(128, 128, 128, 0.1); outline: 2px solid currentColor; color-scheme: normal; }'
    + ' .b { border: 1px solid var(--border, currentColor); color: var(--muted, currentColor); background: var(--card, transparent); }'
  assert.deepEqual(themeProblems(good), [])
})

test('STYLE has no opaque colour, no colour literal outside the fallback rules and no outline removal', () => {
  assert.equal(typeof STYLE, 'string')
  assert.ok(STYLE.length > 100)
  assert.deepEqual(themeProblems(STYLE), [])
  assert.ok(!/outline\s*:\s*(none|0)/i.test(STYLE))
  assert.ok(!/(^|[^-\w])background-color\s*:/i.test(STYLE))
  // Every colour STYLE uses is currentColor, a theme token or, in a fallback rule, a translucent grey.
  for (const match of STYLE.matchAll(/rgba\(([^)]*)\)/g)) {
    assert.match(match[1], /^128, 128, 128, 0?\.\d+$/)
  }
})

test('no element carries an inline colour, background or outline', () => {
  for (const { name, view } of allViews().slice(0, 40)) {
    for (const node of elements(render(view))) {
      const style = node.props.style
      if (style === undefined) continue
      for (const key of Object.keys(style)) assert.ok(!/color|background|outline|border/i.test(key), `${name}: inline ${key}`)
    }
  }
})

test('STYLE has the notice, filter, folder and setup rules, in tokens, with the error tone on its own class', () => {
  for (const selector of ['.eb-notice', '.eb-notice-error', '.eb-error', '.eb-filters', '.eb-filter', '.eb-setup', '.eb-folder', '.eb-folder-label', '.eb-folder-dir', '.eb-folder-name', '.eb-setup-actions']) {
    assert.ok(new RegExp(`(^|\\n|, )${selector.replace('.', '\\.')}[ ,{]`).test(STYLE), `a rule for ${selector}`)
  }
  assert.match(STYLE, /\.eb-notice\s*\{[^}]*border:\s*1px solid var\(--border, currentColor\)[^}]*background:\s*var\(--bg-elevated, transparent\)/)
  assert.match(STYLE, /\.eb-notice-error\s*\{[^}]*var\(--danger, currentColor\)[^}]*var\(--danger-subtle, transparent\)[^}]*color:\s*var\(--danger-text, currentColor\)/)
  assert.doesNotMatch(STYLE, /\.eb-error[^{]*\{[^}]*var\(--/, 'the fallback error keeps its own look')
  assert.match(STYLE, /\.eb-card-spec, \.eb-folder-dir\s*\{[^}]*var\(--mono, monospace\)/)
  assert.match(STYLE, /\.eb-folder-label input\s*\{[^}]*accent-color:\s*var\(--accent, currentColor\)/)
})

test('STYLE stacks the columns, puts them side by side from 720px in a container query, with a media query fallback', () => {
  assert.ok(STYLE.includes('container-type: inline-size'))
  const root = /\.eb-root\s*\{([^}]*)\}/.exec(STYLE)
  assert.ok(root && root[1].includes('container-type: inline-size'), 'the root is the size container')

  const base = /\.eb-columns\s*\{([^}]*)\}/.exec(STYLE)
  assert.ok(base, 'a base rule for the columns')
  assert.ok(base[1].includes('display: grid'))
  assert.ok(/grid-template-columns:\s*(minmax\(0,\s*1fr\)|1fr)\s*;/.test(base[1]), 'one column by default')

  const container = blockBody(STYLE, '@container (min-width: 720px)')
  assert.ok(container !== null, '@container (min-width: 720px)')
  assert.match(container, /\.eb-columns\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)

  const supports = blockBody(STYLE, '@supports not (container-type: inline-size)')
  assert.ok(supports !== null, '@supports fallback')
  const media = blockBody(supports, '@media (min-width: 720px)')
  assert.ok(media !== null, '@media (min-width: 720px) inside the fallback')
  assert.match(media, /\.eb-columns\s*\{[^}]*grid-template-columns:\s*repeat\(3,\s*minmax\(0,\s*1fr\)\)/)

  // The wide rules come after the base rule, so they win.
  assert.ok(STYLE.indexOf('@container (min-width: 720px)') > STYLE.indexOf('.eb-columns {'))
  assert.ok(STYLE.indexOf('@supports not') > STYLE.indexOf('.eb-columns {'))
  // The media queries inside fallbacks: the columns' (720px) and the panel's (1000px, work-in-the-chat). The third
  // is the body's gutter from 768px, which matches Tailwind's `md` in PageHeader (board-design design, "Styles").
  assert.equal(STYLE.split('@media').length - 1, 3)
  assert.match(blockBody(STYLE, '@media (min-width: 768px)') ?? '', /\.eb-body\s*\{[^}]*padding:\s*0 24px/)
  assert.equal(STYLE.split('@supports not (container-type: inline-size)').length - 1, 2)
})

test('STYLE lets grid items shrink and card text wrap', () => {
  assert.match(STYLE, /\.eb-column\s*\{[^}]*min-width:\s*0/)
  assert.match(STYLE, /\.eb-card\s*\{[^}]*min-width:\s*0/)
  assert.match(STYLE, /\.eb-card\s*\{[^}]*overflow-wrap:\s*anywhere/)
  assert.match(STYLE, /\.eb-notice[^{]*\{[^}]*overflow-wrap:\s*anywhere/)
  assert.match(STYLE, /\.eb-problems li\s*\{[^}]*overflow-wrap:\s*anywhere/)
})

test('every class the page uses is prefixed eb-, and the layout classes have rules in STYLE', () => {
  const used = new Set()
  for (const { view } of allViews()) {
    for (const node of elements(render(view))) {
      if (node.props.className) for (const name of String(node.props.className).split(/\s+/)) used.add(name)
    }
  }
  assert.ok(used.has('eb-root') && used.has('eb-columns') && used.has('eb-column') && used.has('eb-card'))
  for (const name of used) {
    assert.ok(name.startsWith('eb-'), `${name} is prefixed`)
  }
  for (const name of ['eb-root', 'eb-columns', 'eb-column', 'eb-card', 'eb-notice', 'eb-error', 'eb-problems', 'eb-bar', 'eb-bar-fill']) {
    assert.ok(used.has(name), `${name} is used`)
    assert.match(STYLE, new RegExp(`\\.${name}(?![\\w-])`), `${name} has a rule`)
  }
  // The style sheet is inside the root element.
  const tree = render(loadingView())
  assert.equal(tree.props.className, 'eb-root')
  assert.equal(tree.children[0].type, 'style')
})

// ---- Generated: every card renders once for each group it is in ----

function randomPlan(r) {
  const groups = []
  const groupCount = r.int(0, 5)
  for (let g = 0; g < groupCount; g += 1) {
    const cards = []
    const size = r.bool(0.25) ? 0 : r.int(1, 6)
    for (let i = 0; i < size; i += 1) {
      const spec = r.bool(0.8) ? `spec-${g}-${i}` : null
      const tasks = spec === null ? null : r.pick([null, { done: 0, total: 0 }, { done: r.int(0, 5), total: 5 }, { done: 1, total: 1 }])
      cards.push(card(`⟦${g}.${i}⟧`, r.pick(STATUSES), spec, tasks, null, r.bool(0.5) ? `Description ${g}.${i} <b>x</b>` : ''))
    }
    groups.push({ epic: r.bool(0.75) ? { name: `Epic ${g}`, file: `epic-${g}.md` } : null, cards })
  }
  // A story listed under several groups appears once for each of them.
  const listedIn = groups.length > 0 ? r.int(0, groups.length) : 0
  const targets = groups.map((group, index) => index).filter(() => r.bool(listedIn / Math.max(1, groups.length)))
  for (const index of targets) groups[index].cards.splice(r.int(0, groups[index].cards.length), 0, card('⟦shared⟧', r.pick(STATUSES), 'shared', { done: 1, total: 2 }, null, ''))
  return planBody({
    groups,
    problems: [],
    fetch: r.pick([{ ok: null }, { ok: true }, { ok: false, reason: 'offline' }]),
    refreshing: r.bool(),
    age_seconds: r.bool(0.3) ? null : r.int(0, 300000),
  })
}

test('generated plans: each card renders once for each group it is in, and the li count is the card count', (t) => {
  const start = baseSeed()
  t.diagnostic(`seeds ${start}..${start + ITERATIONS - 1} (replay one with EB_SEED=<seed>)`)
  forSeeds('every card renders once per group', ITERATIONS, (r) => {
    const plan = randomPlan(r)
    const unreachable = r.bool(0.3)
    const view = planView(plan, { unreachable })
    const tree = render(view)
    assertStructure(tree, 'generated')

    const total = plan.groups.reduce((sum, group) => sum + group.cards.length, 0)
    const items = cardItems(tree)
    assert.equal(items.length, total, 'li count')
    assert.equal(findAll(tree, (node) => node.type === 'li').length, total, 'every li is a card')

    if (total === 0) {
      assert.equal(withText(tree, 'No specs or epics were found on main.').length, 1)
      return
    }
    // For each card name, the number of li equals the number of groups listing it.
    const listed = new Map()
    for (const group of plan.groups) for (const c of group.cards) listed.set(c.name, (listed.get(c.name) ?? 0) + 1)
    for (const [name, times] of listed) {
      const shown = items.filter((item) => textOf(item).startsWith(name))
      assert.equal(shown.length, times, `${name} shown ${shown.length} times, listed ${times}`)
    }
    // Each li matches the card at its place in the columns, with its text and bar.
    const cards = shownCards(plan)
    assert.equal(cards.length, total)
    items.forEach((item, i) => assertCard(item, cards[i]))

    // Headings and "Nothing here" follow the columns.
    const columns = columnsOf(plan)
    assert.equal(withText(tree, 'Nothing here').length, columns.filter((column) => column.count === 0).length)
    assert.equal(findAll(tree, (node) => node.type === `h${TITLE_LEVEL + 2}`).length, columns.reduce((sum, column) => sum + column.groups.length, 0))
    assert.equal(withText(tree, 'Checking for updates…')[0].props.style.visibility, plan.refreshing ? 'visible' : 'hidden')
  })
})
// ---- Cards with chats (start-a-story Requirements 2, 4, 6, 7, 8 and 9) ----
// Validates: Requirements 2.1, 2.2, 2.3, 2.4, 2.6, 4.6, 6.4, 6.8, 7.1, 7.2, 7.3, 7.4, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5
const CARD_ID = 'e.md#Story'
const chatCard = (extra = {}) => ({ id: CARD_ID, name: 'Story', status: 'planned', spec: null, tasks: null, epic: 'E', description: '', ...extra })
function chatsView({ card: cardOver = {}, chats = {}, ui = {}, failed = false, extraCards = [] } = {}) {
  const groups = [{ epic: { name: 'E', file: 'e.md' }, cards: [chatCard(cardOver), ...extraCards] }]
  const view = planView(planBody({ groups }))
  return {
    ...view,
    chats: { ...initialChats, folder: { id: 'f_1', reason: null }, loaded: true, at: 100000, failed, ...chats },
    ui,
  }
}
const withChat = (key = 'k1', entry = { state: 'your-turn' }, over = {}) => ({
  records: [{ card_id: CARD_ID, name: key, key, created: 't' }], byKey: { [key]: entry }, ...over,
})
const missing = (at, since = 0, key = 'k1') => withChat(key, { state: 'missing' }, { missingSince: { [key]: since }, at })
// Records what the controls call.
function recorder() {
  const calls = []
  const actions = Object.fromEntries(['ask', 'cancel', 'start', 'close', 'sendBrief', 'resume', 'startAgain', 'openChat'].map((name) => [name, (...args) => calls.push([name, ...args])]))
  return { calls, actions }
}
const renderWith = (view, actions) => renderBoard(h, view, actions)
const theCard = (tree) => findAll(tree, (node) => node.type === 'li' && /(^| )eb-card( |$)/.test(node.props.className ?? ''))[0]
const buttons = (node) => findAll(node, (n) => n.type === 'button')
const links = (node) => findAll(node, (n) => n.type === 'a')
const labelOf = (node) => textOf(node)
const byLabel = (node, text) => buttons(node).find((button) => labelOf(button) === text)

test('a startable card has its name as the one button, with the card id, and nothing else to press', () => {
  const { calls, actions } = recorder()
  const li = theCard(renderWith(chatsView(), actions))
  assert.equal(li.props['data-mode'], 'startable')
  const main = findAll(li, (n) => n.props.className === 'eb-card-main')
  assert.equal(main.length, 1)
  assert.equal(main[0].type, 'button')
  assert.equal(main[0].props.type, 'button')
  assert.equal(main[0].props['data-card-id'], CARD_ID)
  assert.equal(textOf(main[0]), 'Story')
  assert.deepEqual([buttons(li).length, links(li).length], [1, 0])
  assert.equal(findAll(li, (n) => n.props.role !== undefined).length, 0)
  main[0].props.onClick()
  assert.deepEqual(calls, [['ask', CARD_ID]])
})

test('the question: the text, a Start and a Cancel button, a group with a label, and Escape cancels', () => {
  const { calls, actions } = recorder()
  const li = theCard(renderWith(chatsView({ ui: { asking: CARD_ID } }), actions))
  assert.equal(li.props['data-mode'], 'question')
  const group = findAll(li, (n) => n.props.role === 'group')
  assert.equal(group.length, 1)
  assert.equal(typeof group[0].props['aria-label'], 'string')
  assert.ok(group[0].props['aria-label'].length > 0)
  assert.ok(textOf(group[0]).includes('Start a conductor on this story?'))
  assert.deepEqual(buttons(group[0]).map(labelOf), ['Start', 'Cancel'])
  assert.equal(buttons(li).length, 3, 'the card button, Start and Cancel')
  byLabel(group[0], 'Start').props.onClick()
  byLabel(group[0], 'Cancel').props.onClick()
  group[0].props.onKeyDown({ key: 'Escape' })
  group[0].props.onKeyDown({ key: 'Enter' })
  group[0].props.onKeyDown({ key: 'a' })
  assert.deepEqual(calls, [['start', CARD_ID, 'Story'], ['cancel', CARD_ID], ['cancel', CARD_ID]])
})

test('start question mode line: "Works in its own worktree" when projectWorktree is true (the default)', () => {
  const li = theCard(renderWith({ ...chatsView({ ui: { asking: CARD_ID } }), projectWorktree: true }))
  const group = findAll(li, (n) => n.props.role === 'group')
  assert.ok(textOf(group[0]).includes('Works in its own worktree'))
  assert.ok(!textOf(group[0]).includes('shared checkout'))
})

test('start question mode line: "Works in the shared checkout" when projectWorktree is false', () => {
  const li = theCard(renderWith({ ...chatsView({ ui: { asking: CARD_ID } }), projectWorktree: false }))
  const group = findAll(li, (n) => n.props.role === 'group')
  assert.ok(textOf(group[0]).includes('Works in the shared checkout'))
  assert.ok(!textOf(group[0]).includes('own worktree'))
})

test('a failed start shows the step and the reason, with a status role, above the question', () => {
  const steps = { reserve: 'Could not reserve the chat', create: 'Could not create the chat', send: 'Could not send the brief', save: 'Could not save the chat' }
  for (const [step, text] of Object.entries(steps)) {
    const ui = { asking: CARD_ID, flows: { [CARD_ID]: { kind: 'failed', step, reason: 'API 500: boom' } } }
    const li = theCard(renderWith(chatsView({ ui })))
    const note = findAll(li, (n) => n.props.role === 'status')
    assert.equal(note.length, 1, step)
    assert.equal(textOf(note[0]), `${text}: API 500: boom`)
    assert.deepEqual(buttons(findAll(li, (n) => n.props.role === 'group')[0]).map(labelOf), ['Start', 'Cancel'], 'the question is offered again')
  }
})

test('a start in progress shows Starting… with a status role and no button or link', () => {
  const ui = { asking: CARD_ID, flows: { [CARD_ID]: { kind: 'starting', step: 'create' } } }
  const li = theCard(renderWith(chatsView({ ui })))
  assert.equal(li.props['data-mode'], 'starting')
  assert.deepEqual([buttons(li).length, links(li).length], [0, 0])
  const status = findAll(li, (n) => n.props.role === 'status')
  assert.deepEqual(status.map(textOf), ['Starting…'])
})

test('with no Crew folder the question is replaced by the text, the two setting names as code, and Close', () => {
  const { calls, actions } = recorder()
  const view = chatsView({ ui: { asking: CARD_ID }, chats: { folder: { id: null, reason: 'folder_id must be text and not empty.' } } })
  const li = theCard(renderWith(view, actions))
  assert.equal(li.props['data-mode'], 'blocked')
  const group = findAll(li, (n) => n.props.role === 'group')[0]
  const text = textOf(group)
  assert.ok(text.includes('No Crew folder is set for this project.'))
  assert.ok(text.includes('folder_id must be text and not empty.'))
  assert.deepEqual(findAll(group, (n) => n.type === 'code').map(textOf), ['EPIC_BOARD_FOLDER', 'folder_id'])
  assert.ok(!text.includes('Start a conductor on this story?'))
  assert.deepEqual(buttons(group).map(labelOf), ['Close'])
  buttons(group)[0].props.onClick()
  group.props.onKeyDown({ key: 'Escape' })
  assert.deepEqual(calls, [['close', CARD_ID], ['close', CARD_ID]])
})

test('with no Crew folder and no reason the text still shows, and an unreadable file shows the backend message', () => {
  const none = theCard(renderWith(chatsView({ ui: { asking: CARD_ID }, chats: { folder: { id: null, reason: null } } })))
  assert.ok(textOf(none).includes('No Crew folder is set for this project.'))
  const records = { recordsError: { code: 'chats_unreadable', message: '/x/chats.json cannot be read as the board\'s file of chats.' }, folder: { id: null, reason: null } }
  const li = theCard(renderWith(chatsView({ ui: { asking: CARD_ID }, chats: records })))
  const group = findAll(li, (n) => n.props.role === 'group')[0]
  assert.ok(textOf(group).includes('/x/chats.json cannot be read as the board\'s file of chats.'))
  assert.equal(findAll(group, (n) => n.type === 'code').length, 0)
  assert.deepEqual(buttons(group).map(labelOf), ['Close'])
})

test('a card with a started chat is a link with the chat address, in every column, and offers no question', () => {
  for (const status of STATUSES) {
    const { calls, actions } = recorder()
    const view = chatsView({ card: { status }, chats: withChat('epic-board-3fa91c0e', { state: 'needs-you' }), ui: { asking: CARD_ID } })
    const li = theCard(renderWith(view, actions))
    assert.equal(li.props['data-mode'], 'chat', status)
    const anchors = links(li)
    assert.equal(anchors.length, 1)
    assert.equal(anchors[0].props.href, '/chat?sid=epic-board-3fa91c0e')
    assert.equal(anchors[0].props.className, 'eb-card-main')
    assert.equal(anchors[0].props['data-card-id'], CARD_ID)
    assert.equal(textOf(anchors[0]), 'Story')
    assert.equal(buttons(li).length, 0, 'the link is the only control')
    assert.deepEqual(findAll(li, (n) => n.props.role === 'group'), [])
    assert.deepEqual(calls, [])
  }
})

test('the state word is shown for each state, with the state in an attribute, and not before it has been read', () => {
  const words = { 'needs-you': 'Needs you', working: 'Working', interrupted: 'Interrupted', 'your-turn': 'Your turn', stalled: 'Stalled' }
  for (const [state, word] of Object.entries(words)) {
    const li = theCard(renderWith(chatsView({ chats: withChat('k1', { state }) })))
    const marks = findAll(li, (n) => /(^| )eb-chat-state( |$)/.test(n.props.className ?? ''))
    assert.equal(marks.length, 1, state)
    assert.equal(textOf(marks[0]), word)
    assert.equal(marks[0].props['data-state'], state)
  }
  const unread = theCard(renderWith(chatsView({ chats: withChat('k1', undefined, { byKey: {} }) })))
  assert.equal(findAll(unread, (n) => /(^| )eb-chat-state( |$)/.test(n.props.className ?? '')).length, 0)
  assert.equal(links(unread).length, 1, 'the link shows before the state is known')
})

test('a Review state word is a link to its pull request that opens safely, and the other words are plain text', () => {
  const review = { number: 7, url: 'https://github.com/o/r/pull/7', failed: true }
  const li = theCard(renderWith(chatsView({ chats: withChat('k1', { state: 'review', review }) })))
  const [mark] = findAll(li, (n) => /(^| )eb-chat-state( |$)/.test(n.props.className ?? ''))
  assert.equal(textOf(mark), 'Checks failed #7')
  assert.equal(mark.props['data-state'], 'review')
  const inside = findAll(mark, (n) => n.type === 'a')
  assert.deepEqual(inside.map((a) => [a.props.href, a.props.target, a.props.rel]), [[review.url, '_blank', 'noopener noreferrer']])
  const plain = theCard(renderWith(chatsView({ chats: withChat('k1', { state: 'your-turn' }) })))
  assert.equal(findAll(plain, (n) => /(^| )eb-chat-state( |$)/.test(n.props.className ?? '')).flatMap((m) => findAll(m, (n) => n.type === 'a')).length, 0)
})

test('the link is built only from the percent-encoded key', () => {
  for (const key of ['a b/c', 'é日?#', 'x&token=1', 'k"><b>']) {
    const li = theCard(renderWith(chatsView({ chats: withChat(key) })))
    const href = links(li)[0].props.href
    assert.equal(href, chatHref(key))
    assert.ok(/^\/chat\?sid=[A-Za-z0-9%._~-]*$/.test(href), href)
    assert.ok(!/token|&/.test(href.slice('/chat?sid='.length)) || /%26/.test(href))
  }
})

test('restoring: the text with a status role, and no link or button', () => {
  const li = theCard(renderWith(chatsView({ chats: missing(30000) })))
  assert.equal(li.props['data-mode'], 'restoring')
  assert.deepEqual(findAll(li, (n) => n.props.role === 'status').map(textOf), ['Restoring chat…'])
  assert.deepEqual([buttons(li).length, links(li).length], [0, 0])
})

test('not open: the text and Resume chat, which resumes by key; still no link', () => {
  const { calls, actions } = recorder()
  const li = theCard(renderWith(chatsView({ chats: missing(60000) }), actions))
  assert.equal(li.props['data-mode'], 'not-open')
  assert.deepEqual(findAll(li, (n) => n.props.role === 'status').map(textOf), ['This chat is not open.'])
  assert.deepEqual(buttons(li).map(labelOf), ['Resume chat'])
  assert.equal(links(li).length, 0)
  buttons(li)[0].props.onClick()
  assert.deepEqual(calls, [['resume', 'k1']])
})

test('resuming and a failed resume: the texts, the reason, and Start again by record name', () => {
  const { calls, actions } = recorder()
  const resuming = theCard(renderWith(chatsView({ chats: missing(60000), ui: { resumes: { k1: { kind: 'resuming' } } } }), actions))
  assert.deepEqual(findAll(resuming, (n) => n.props.role === 'status').map(textOf), ['Resuming…'])
  assert.equal(buttons(resuming).length, 0)
  const failed = theCard(renderWith(chatsView({ chats: missing(60000), ui: { resumes: { k1: { kind: 'failed', reason: 'API 404: gone' } } } }), actions))
  assert.deepEqual(findAll(failed, (n) => n.props.role === 'status').map(textOf), ['The chat could not be resumed.'])
  assert.ok(textOf(failed).includes('API 404: gone'))
  assert.deepEqual(buttons(failed).map(labelOf), ['Start again'])
  buttons(failed)[0].props.onClick()
  assert.deepEqual(calls, [['startAgain', 'k1', CARD_ID]])
})

test('a Done card with no chat has no button, no link and no role', () => {
  const li = theCard(renderWith(chatsView({ card: { status: 'done' }, ui: { asking: CARD_ID } })))
  assert.equal(li.props['data-mode'], 'plain')
  assert.deepEqual([buttons(li).length, links(li).length], [0, 0])
  assert.deepEqual(findAll(li, (n) => n.props.role !== undefined), [])
  assert.deepEqual(findAll(li, (n) => n.props['data-card-id'] !== undefined), [])
})

test('a card has at most one main control, and it is the label of the name', () => {
  const everyMode = [
    chatsView(), chatsView({ ui: { asking: CARD_ID } }), chatsView({ chats: withChat() }), chatsView({ card: { status: 'done' } }),
    chatsView({ chats: missing(0) }), chatsView({ chats: missing(60000) }),
    chatsView({ ui: { asking: CARD_ID }, chats: { folder: { id: null, reason: null } } }),
    chatsView({ ui: { flows: { [CARD_ID]: { kind: 'starting', step: 'send' } } } }),
  ]
  for (const view of everyMode) {
    const li = theCard(renderWith(view))
    const main = findAll(li, (n) => n.props.className === 'eb-card-main')
    assert.ok(main.length <= 1)
    const name = findAll(li, (n) => n.props.className === 'eb-card-name')[0]
    for (const node of main) assert.ok(findAll(name, (n) => n === node).length === 1, 'the main control is in the name')
  }
})

test('every mode keeps the board\'s structure: one title, no heading added, levels unbroken, only status and group roles', () => {
  const views = [
    chatsView(), chatsView({ ui: { asking: CARD_ID } }), chatsView({ chats: withChat('k1', { state: 'working' }) }),
    chatsView({ card: { status: 'done' } }), chatsView({ chats: missing(0) }), chatsView({ chats: missing(60000) }),
    chatsView({ ui: { asking: CARD_ID, flows: { [CARD_ID]: { kind: 'failed', step: 'send', reason: 'x' } } } }),
    chatsView({ ui: { flows: { [CARD_ID]: { kind: 'starting', step: 'create' } } } }),
    chatsView({ ui: { asking: CARD_ID }, chats: { folder: { id: null, reason: null } } }),
    chatsView({ chats: missing(60000), ui: { resumes: { k1: { kind: 'failed', reason: 'x' } } } }),
    chatsView({ failed: true, chats: withChat() }),
  ]
  for (const view of views) {
    const without = headingLevels(renderBoard(h, { ...view, chats: undefined, ui: undefined }))
    const tree = renderWith(view)
    assertStructure(tree, view.chats.failed ? 'chats failed' : theCard(tree).props['data-mode'], { cardControls: true })
    assert.deepEqual(headingLevels(tree), without, 'no heading is added')
    for (const role of rolesOf(tree)) assert.ok(['status', 'group'].includes(role), `role ${role}`)
    assert.ok(!rolesOf(tree).includes('alert'))
  }
})

test('the notice for a failed chat read has a status role, the board stays, and it is gone after a good read', () => {
  const notice = 'Could not read chat status. Showing the last known states.'
  const failed = renderWith(chatsView({ failed: true, chats: withChat('k1', { state: 'working' }) }))
  const found = findAll(failed, (n) => n.props.role === 'status' && textOf(n).includes(notice))
  assert.equal(found.length, 1)
  assert.equal(found[0].props.className, 'eb-notice')
  assert.equal(findAll(failed, (n) => /(^| )eb-chat-state( |$)/.test(n.props.className ?? '')).length, 1, 'the last known states stay')
  assert.equal(findAll(failed, (n) => n.props.className === 'eb-columns').length, 1, 'the columns stay')
  const ok = renderWith(chatsView({ failed: false }))
  assert.equal(findAll(ok, (n) => textOf(n).includes(notice) && n.props.role === 'status').length, 0)
})

test('texts from the plan, the backend and Crew are literal children, never HTML', () => {
  const markup = '<img src=x onerror=alert(1)> **bold** &amp;'
  const views = [
    chatsView({ card: { name: markup, description: markup } }),
    chatsView({ card: { name: markup }, ui: { asking: CARD_ID, flows: { [CARD_ID]: { kind: 'failed', step: 'create', reason: markup } } } }),
    chatsView({ card: { name: markup }, ui: { asking: CARD_ID }, chats: { folder: { id: null, reason: markup } } }),
    chatsView({ card: { name: markup }, ui: { asking: CARD_ID }, chats: { folder: { id: null, reason: null }, recordsError: { code: 'chats_unreadable', message: markup } } }),
    chatsView({ card: { name: markup }, chats: missing(60000), ui: { resumes: { k1: { kind: 'failed', reason: markup } } } }),
    chatsView({ card: { name: markup }, chats: withChat('k1') }),
  ]
  for (const view of views) {
    const tree = renderWith(view)
    for (const node of elements(tree)) {
      assert.equal(node.props.dangerouslySetInnerHTML, undefined)
      assert.equal(node.props.innerHTML, undefined)
    }
    const li = theCard(tree)
    assert.ok(textOf(li).includes(markup), 'the text is there as written')
    assert.equal(findAll(li, (n) => n.type === 'img' || n.type === 'script' || n.type === 'b').length, 0)
  }
})

test('without actions the controls still exist and do nothing when used', () => {
  const view = chatsView({ ui: { asking: CARD_ID } })
  const li = theCard(renderBoard(h, view))
  for (const button of buttons(li)) assert.doesNotThrow(() => button.props.onClick())
  assert.doesNotThrow(() => findAll(li, (n) => n.props.role === 'group')[0].props.onKeyDown({ key: 'Escape' }))
})

test('a view with no chats draws the board as before: no control, no data-mode other than plain', () => {
  const tree = render(planView(planBody()))
  // The Projects button lives in eb-header; exclude it — it is always present (set-up-projects Req 4.1)
  const headerNodes = new Set(findAll(tree, (n) => n.props.className === 'eb-header').flatMap((box) => elements(box)))
  assert.deepEqual(buttons(tree).filter((b) => !headerNodes.has(b)).concat(links(tree)), [])
  for (const li of cardItems(tree)) assert.equal(li.props['data-mode'], 'plain')
})

test('the new classes have rules in STYLE, and the stretched control sits under the controls', () => {
  for (const name of ['eb-card-main', 'eb-chat-state', 'eb-chat-note', 'eb-chat-line', 'eb-question', 'eb-chat-controls']) {
    assert.match(STYLE, new RegExp(`\\.${name}(?![\\w-])`), `${name} has a rule`)
  }
  assert.match(STYLE, /\.eb-card\s*\{[^}]*position:\s*relative/)
  assert.match(STYLE, /\.eb-card-main::after\s*\{[^}]*position:\s*absolute[^}]*inset:\s*0/)
  assert.match(STYLE, /\.eb-question,\s*\.eb-chat-controls\s*\{[^}]*position:\s*relative[^}]*z-index:\s*1/)
  assert.match(STYLE, /\.eb-card-main:focus-visible\s*\{[^}]*outline:\s*2px solid currentColor/)
  assert.ok(!/outline\s*:\s*(none|0)/i.test(STYLE))
})

// ---- The brief of a started chat (start-a-story Requirement 4, criterion 9) ----
// Validates: Requirements 4.7, 4.9, 9.2, 9.3
const briefView = (brief, over = {}) => chatsView({ chats: withChat('k1', { state: 'needs-you' }), ui: { briefs: { k1: brief } }, ...over })

test('while the brief is sent the card keeps its link and its state and says so with a status role, and has no button', () => {
  const li = theCard(renderWith(briefView({ kind: 'sending' })))
  assert.equal(li.props['data-mode'], 'chat')
  assert.equal(links(li)[0].props.href, '/chat?sid=k1')
  assert.deepEqual(findAll(li, (n) => /(^| )eb-chat-state( |$)/.test(n.props.className ?? '')).map(textOf), ['Needs you'])
  assert.deepEqual(findAll(li, (n) => n.props.role === 'status').map(textOf), ['Sending the brief…'])
  assert.equal(buttons(li).length, 0)
})

test('a brief that was not sent: the card keeps its link and state, shows the text and the reason, and a Send the brief again button', () => {
  const { calls, actions } = recorder()
  const li = theCard(renderWith(briefView({ kind: 'failed', reason: 'API 500: boom' }), actions))
  assert.equal(links(li)[0].props.href, '/chat?sid=k1')
  assert.deepEqual(findAll(li, (n) => /(^| )eb-chat-state( |$)/.test(n.props.className ?? '')).map(textOf), ['Needs you'])
  assert.deepEqual(findAll(li, (n) => n.props.role === 'status').map(textOf), ['The brief was not sent'])
  assert.ok(textOf(li).includes('API 500: boom'))
  assert.deepEqual(buttons(li).map(labelOf), ['Send the brief again'])
  assert.equal(findAll(li, (n) => n.props.role === 'alert').length, 0)
  buttons(li)[0].props.onClick()
  assert.deepEqual(calls, [['sendBrief', 'k1']])
})

test('inside Crew\'s Card the stretched link still covers the whole card (card-glow makes children positioned)', () => {
  // Crew 0.12.2: '.card-glow>*{position:relative;z-index:1}'. Ours must win on specificity (two classes over one).
  assert.match(blockBody(STYLE, '.eb-root .eb-card > * ') ?? '', /position:\s*static/)
  assert.match(blockBody(STYLE, '.eb-root .eb-card > * ') ?? '', /z-index:\s*auto/)
  // The card's own controls stay above the link.
  const controls = blockBody(STYLE, '.eb-root .eb-card > .eb-question, .eb-root .eb-card > .eb-chat-controls') ?? ''
  assert.match(controls, /position:\s*relative/)
  assert.match(controls, /z-index:\s*1/)
  // The static rule comes before the controls rule, so the controls win.
  assert.ok(STYLE.indexOf('.eb-root .eb-card > * ') < STYLE.indexOf('.eb-root .eb-card > .eb-question'))
})

test('the button of a failed brief sits in the controls layer above the stretched link', () => {
  const li = theCard(renderWith(briefView({ kind: 'failed', reason: 'x' })))
  const controls = findAll(li, (n) => n.props.className === 'eb-chat-controls')
  assert.equal(controls.length, 1)
  assert.deepEqual(buttons(controls[0]).map(labelOf), ['Send the brief again'])
  assert.match(STYLE, /\.eb-question,\s*\.eb-chat-controls\s*\{[^}]*position:\s*relative[^}]*z-index:\s*1/)
})

test('a failed brief with no reason shows the text and the button only', () => {
  const li = theCard(renderWith(briefView({ kind: 'failed', reason: '' })))
  assert.deepEqual(findAll(li, (n) => n.props.role === 'status').map(textOf), ['The brief was not sent'])
  assert.deepEqual(buttons(li).map(labelOf), ['Send the brief again'])
})

test('a card with no brief note, or whose chat is missing, shows no brief text', () => {
  for (const view of [chatsView({ chats: withChat('k1') }), chatsView({ chats: missing(60000), ui: { briefs: { k1: { kind: 'failed', reason: 'x' } } } })]) {
    const li = theCard(renderWith(view))
    assert.ok(!/Sending the brief|The brief was not sent|Send the brief again/.test(textOf(li)))
  }
})

test('the reason of a failed brief is a literal child, never HTML', () => {
  const markup = '<img src=x onerror=alert(1)> **bold**'
  const tree = renderWith(briefView({ kind: 'failed', reason: markup }))
  assert.ok(textOf(theCard(tree)).includes(markup))
  assert.equal(findAll(tree, (n) => n.type === 'img' || n.type === 'script').length, 0)
  for (const node of elements(tree)) assert.equal(node.props.dangerouslySetInnerHTML, undefined)
})

test('the brief states keep the board\'s structure: one title, no heading added, only status and group roles', () => {
  for (const brief of [{ kind: 'sending' }, { kind: 'failed', reason: 'x' }]) {
    const view = briefView(brief)
    const tree = renderWith(view)
    assertStructure(tree, `brief ${brief.kind}`, { cardControls: true })
    assert.deepEqual(headingLevels(tree), headingLevels(renderBoard(h, { ...view, chats: undefined, ui: undefined })))
    for (const role of rolesOf(tree)) assert.ok(['status', 'group'].includes(role), role)
  }
})

// ---- The epic dropdown ----

const FakeSelect = () => null
const filterBox = (tree) => findAll(tree, (n) => n.props.className === 'eb-filter')
const labelled = (tree) => findAll(tree, (n) => n.props['aria-label'] === 'Epic')
const FILTER_LABELS = ['All epics', 'Epic Board', 'Hardening', 'No epic']

test('render: host Select used when present', () => {
  const calls = []
  const tree = renderBoard(h, planView(planBody(), {}), { filter: (key) => calls.push(key) }, { Select: FakeSelect })
  const [select] = findAll(tree, (n) => n.type === FakeSelect)
  assert.ok(select)
  assert.equal(select.props.value, 'all')
  // Crew's Select takes strings: values in `options`, labels in `optionLabels`. An object here crashes React.
  assert.deepEqual(select.props.options, ['all', 'epic-board.md', 'hardening.md', 'no-epic'])
  assert.deepEqual(select.props.optionLabels, FILTER_LABELS)
  select.props.onChange('hardening.md')
  select.props.onChange('no-epic')
  assert.deepEqual(calls, ['hardening.md', 'no-epic'])
  assert.equal(findAll(tree, (n) => n.type === 'select').length, 0)
})

test('render: native select when the ui module is missing', () => {
  const tree = renderBoard(h, planView(planBody()), {})
  assert.equal(findAll(tree, (n) => n.type === 'select').length, 1)
})

test('render: native select when Select is missing from the module', () => {
  const tree = renderBoard(h, planView(planBody()), {}, { Select: null })
  assert.equal(findAll(tree, (n) => n.type === 'select').length, 1)
})

test('render: aria-label Epic on the host Select', () => {
  const tree = renderBoard(h, planView(planBody()), {}, { Select: FakeSelect })
  assert.equal(labelled(tree).length, 1)
  assert.equal(labelled(tree)[0].type, FakeSelect)
})

test('render: aria-label Epic on the native select, with its value, options and onChange', () => {
  const calls = []
  const tree = renderBoard(h, planView(planBody()), { filter: (key) => calls.push(key) })
  const [select] = labelled(tree)
  assert.equal(select.type, 'select')
  assert.equal(select.props.value, 'all')
  assert.deepEqual(select.children.map((o) => textOf(o)), FILTER_LABELS)
  select.props.onChange({ target: { value: 'epic-board.md' } })
  assert.deepEqual(calls, ['epic-board.md'])
})

test('render: the dropdown sits after the header and before the columns, and follows the view key', () => {
  const view = viewOf(reduce(initialState, classify(200, planBody())), 'hardening.md')
  const tree = renderBoard(h, view, {})
  const classes = []
  for (const node of tree.children) if (node && node.props) classes.push(node.props.className)
  assert.ok(classes.indexOf('eb-header') < classes.indexOf('eb-filters'))
  assert.ok(classes.indexOf('eb-filters') < classes.indexOf('eb-columns'))
  assert.equal(labelled(tree)[0].props.value, 'hardening.md')
})

test('render: no dropdown while loading, on an error, unreachable, or on the empty board', () => {
  for (const view of [loadingView(), unreachableView(), errorView(), planView(planBody({ groups: [] }))]) {
    assert.equal(filterBox(renderBoard(h, view, {})).length, 0)
  }
})

test('render: notices and problems stay under a filter', () => {
  const body = planBody({ problems: problemsOf(2), fetch: { ok: false, reason: 'offline' } })
  const view = viewOf(reduce(reduce(initialState, classify(200, body)), classify(200, null)), 'hardening.md')
  const text = textOf(renderBoard(h, view, {}))
  assert.match(text, /Could not fetch from origin/)
  assert.match(text, /Could not reach the backend\. Showing the plan/)
  assert.match(text, /spec-1\/tasks\.md/)
  assert.doesNotMatch(text, /Read the plan from main/)
})

test('host: hostSelect finds Select', async () => {
  globalThis.window = { __kirocrew_modules: { '@kirocrew/ui': { Select: FakeSelect } } }
  try {
    const { hostSelect } = await import('../../ui/index.mjs')
    assert.equal(hostSelect(), FakeSelect)
  } finally {
    delete globalThis.window
  }
})

test('host: hostSelect gives null with no window', async () => {
  const { hostSelect } = await import('../../ui/index.mjs')
  assert.equal(hostSelect(), null)
})

test('host: hostSelect gives null when the module has no Select or the lookup throws', async () => {
  const { hostSelect } = await import('../../ui/index.mjs')
  globalThis.window = { __kirocrew_modules: { '@kirocrew/ui': {} } }
  try {
    assert.equal(hostSelect(), null)
    globalThis.window = { get __kirocrew_modules() { throw new Error('no') } }
    assert.equal(hostSelect(), null)
  } finally {
    delete globalThis.window
  }
})

// ---- The chat panel, the mark and the layout (work-in-the-chat, Requirements 1.5, 1.6, 2.4, 2.5, 3, 4.1, 6) ----
const FakeChat = () => null
const panelOf = (tree) => findAll(tree, (n) => n.type === 'aside')
const openView = (over = {}) => chatsView({
  chats: withChat('k1', { state: 'your-turn' }), ui: { open: { cardId: CARD_ID, key: 'k1' } }, ...over,
})
const withPanel = (view) => ({ ...view, panelAvailable: true })
const clickEvent = (over = {}) => {
  const event = { button: 0, defaultPrevented: false, prevented: 0, preventDefault() { this.prevented += 1 }, ...over }
  return event
}

test('the Panel is an aside with a label, a tabindex, the title, a Close button and the content in its body', () => {
  const closed = []
  const content = h(FakeChat, { slotKey: 'k1', conversationOnly: true })
  const tree = renderPanel(h, { title: 'Story', key: 'k1' }, content, { closeChat: () => closed.push(1) })
  assert.equal(tree.type, 'aside')
  assert.equal(tree.props['aria-label'], 'Chat: Story')
  assert.equal(tree.props.tabIndex, -1)
  assert.equal(tree.props['data-eb-panel'], 'true')
  assert.equal(textOf(findAll(tree, (n) => n.props.className === 'eb-panel-title')[0]), 'Story')
  const close = buttons(tree)
  assert.deepEqual(close.map(labelOf), ['Close'])
  assert.equal(close[0].props.type, 'button')
  close[0].props.onClick()
  assert.deepEqual(closed, [1])
  assert.deepEqual(findAll(tree, (n) => n.props.className === 'eb-panel-body')[0].children, [content])
  assert.deepEqual(findAll(tree, (n) => /^h[1-6]$/.test(String(n.type))), [], 'no heading')
  assert.doesNotThrow(() => renderPanel(h, { title: 'T', key: 'k' }, null).props)
})

test('the shell wraps the board in eb-shell > eb-split, in the same place with or without a Panel', () => {
  const board = render(loadingView())
  const closed = renderShell(h, board, null)
  assert.deepEqual([closed.props.className, closed.props['data-panel']], ['eb-shell', 'closed'])
  assert.equal(closed.children[0].props.className, 'eb-split')
  assert.equal(closed.children[0].children[0], board)
  assert.equal(closed.children[0].children.length, 1, 'no space kept for a Panel')
  const panel = renderPanel(h, { title: 'S', key: 'k' }, null)
  const open = renderShell(h, board, panel)
  assert.equal(open.props['data-panel'], 'open')
  assert.deepEqual(open.children[0].children, [board, panel])
})

test('the Open_Card, and only it, shows "Chat open", aria-current and data-open', () => {
  const other = { id: 'e.md#Other', name: 'Other', status: 'planned', spec: null, tasks: null, epic: 'E', description: '' }
  const chats = withChat('k1', { state: 'your-turn' }, { records: [
    { card_id: CARD_ID, name: 'k1', key: 'k1', created: 't' }, { card_id: other.id, name: 'k2', key: 'k2', created: 't' },
  ], byKey: { k1: { state: 'your-turn' }, k2: { state: 'your-turn' } } })
  const tree = renderWith(withPanel(chatsView({ chats, extraCards: [other], ui: { open: { cardId: CARD_ID, key: 'k1' } } })))
  const [first, second] = findAll(tree, (n) => n.type === 'li' && /(^| )eb-card( |$)/.test(n.props.className ?? ''))
  assert.equal(first.props['data-open'], 'true')
  assert.equal(links(first)[0].props['aria-current'], 'true')
  assert.equal(findAll(first, (n) => n.props.className === 'eb-chat-open').map(labelOf).join(), 'Chat open')
  assert.equal('data-open' in second.props, false)
  assert.equal('aria-current' in links(second)[0].props, false)
  assert.doesNotMatch(textOf(second), /Chat open/)
  const closed = renderWith(withPanel(chatsView({ chats })))
  assert.doesNotMatch(textOf(closed), /Chat open/)
  assert.equal(findAll(closed, (n) => 'data-open' in n.props).length, 0)
})

test('a plain click on the link opens the chat; anything else is left to the browser', () => {
  const { calls, actions } = recorder()
  const link = links(theCard(renderWith(withPanel(chatsView({ chats: withChat('k1') })), actions)))[0]
  const plain = clickEvent()
  link.props.onClick(plain)
  assert.equal(plain.prevented, 1)
  assert.deepEqual(calls, [['openChat', { cardId: CARD_ID, key: 'k1' }]])
  calls.length = 0
  for (const over of [{ ctrlKey: true }, { metaKey: true }, { shiftKey: true }, { altKey: true }, { button: 1 }, { button: 2 }, { defaultPrevented: true }]) {
    const event = clickEvent(over)
    link.props.onClick(event)
    assert.equal(event.prevented, 0, JSON.stringify(over))
  }
  assert.deepEqual(calls, [])
  // No host panel: the click is left alone and the link is unchanged.
  const bare = links(theCard(renderWith(chatsView({ chats: withChat('k1') }), actions)))[0]
  const event = clickEvent()
  bare.props.onClick(event)
  assert.deepEqual([event.prevented, calls], [0, []])
  assert.equal(bare.props.href, '/chat?sid=k1')
})

test('with no host panel nothing of the panel shows, and the card is as before', () => {
  const tree = renderWith(openView())
  assert.doesNotMatch(visibleText(tree), /Chat open|Close/)
  assert.equal(findAll(tree, (n) => n.type === 'aside' || 'data-open' in n.props || 'aria-current' in n.props).length, 0)
})

test('the panel adds no heading and keeps the heading levels', () => {
  const plain = headingLevels(renderWith(withPanel(chatsView({ chats: withChat('k1') }))))
  const shell = renderShell(h, renderWith(withPanel(openView())), renderPanel(h, { title: 'Story', key: 'k1' }, h(FakeChat, {})))
  assert.deepEqual(headingLevels(shell), plain)
  assertStructure(shell, 'with a panel', { cardControls: true })
})

test('a name with markup is literal text in the Panel and its label', () => {
  const name = '<img src=x onerror=alert(1)> **bold**'
  const tree = renderPanel(h, { title: name, key: 'k' }, null)
  assert.equal(tree.props['aria-label'], `Chat: ${name}`)
  assert.equal(findAll(tree, (n) => n.props.className === 'eb-panel-title')[0].children[0], name)
  assert.equal(findAll(tree, (n) => n.type === 'img').length, 0)
  const card = renderWith(withPanel(chatsView({ card: { name }, chats: withChat('k1'), ui: { open: { cardId: CARD_ID, key: 'k1' } } })))
  assert.equal(links(theCard(card))[0].children[0], name)
})

test('STYLE: the panel rules use no colour of their own, and the mark is currentColor', () => {
  assert.deepEqual(themeProblems(STYLE), [])
  assert.match(STYLE, /\.eb-card\[data-open='true'\]\s*\{[^}]*border-color:\s*currentColor[^}]*box-shadow:\s*0 0 0 1px currentColor/)
  assert.doesNotMatch(STYLE, /outline:\s*none/)
})

test('STYLE: narrow covers the board with visibility hidden, wide sits beside it, in a container query and a media fallback', () => {
  assert.match(STYLE, /\.eb-shell\s*\{[^}]*container:\s*eb-shell \/ inline-size/)
  assert.match(STYLE, /\.eb-shell\[data-panel='open'\] \.eb-panel\s*\{\s*position:\s*absolute;\s*inset:\s*0/)
  assert.match(STYLE, /\.eb-shell\[data-panel='open'\] \.eb-root\s*\{\s*visibility:\s*hidden/)
  const wide = blockBody(STYLE, '@container eb-shell (min-width: 1000px)')
  assert.ok(wide !== null, 'the container query')
  const supports = blockBody(STYLE.slice(STYLE.lastIndexOf('@supports not')), '@supports not (container-type: inline-size)')
  const fallback = blockBody(supports, '@media (min-width: 1000px)')
  assert.ok(fallback !== null, 'the media fallback')
  for (const body of [wide, fallback]) {
    assert.match(body, /\.eb-split\s*\{[^}]*display:\s*flex/)
    assert.match(body, /\.eb-root\s*\{[^}]*visibility:\s*visible/)
    assert.match(body, /\.eb-panel\s*\{[^}]*position:\s*static[^}]*clamp\(380px, 40%, 640px\)/)
  }
})

// ---- Board design, group 2: the header, the column headers, the empty and error states, the filter row ----

// A fake Crew component: a function that draws nothing. The tree holds its props.
const fake = () => () => null
const FAKES = ['Btn', 'Card', 'CardTitle', 'Badge', 'PageHeader', 'EmptyState', 'ErrorNotice', 'Select']
const fakeKit = (names = FAKES) => Object.fromEntries(names.map((name) => [name, fake()]))
const renderKit = (view, kit) => renderBoard(h, view, {}, kit)
// `key` is not a prop in React, so it is left out when the props are compared.
const propsOf = (node) => Object.fromEntries(Object.entries(node.props).filter(([name]) => name !== 'key'))
const ofType = (tree, type) => findAll(tree, (node) => node.type === type)
const nativeSelects = (tree) => findAll(tree, (node) => node.type === 'select')
const PROJECTS = { options: [{ key: 'a', label: 'Alpha' }, { key: 'b', label: 'Beta' }], currentId: 'b' }

test('the header with PageHeader: the title is the h1, the subtitle is one line, the actions are the checking text and a plain Projects button', () => {
  for (const refreshing of [false, true]) {
    const kit = fakeKit()
    const view = planView(planBody({ refreshing }))
    const tree = renderKit(view, kit)
    const [header] = ofType(tree, kit.PageHeader)
    assert.ok(header, 'PageHeader is drawn')
    assert.deepEqual(Object.keys(header.props).sort(), ['actions', 'subtitle', 'title'])
    assert.equal(header.props.title.type, `h${TITLE_LEVEL}`)
    assert.equal(textOf(header.props.title), 'Epic Board')
    assert.equal(header.props.subtitle, `main · ${COMMIT.slice(0, 7)} · Updated less than a minute ago`)
    const [checking, projects] = header.props.actions
    assert.equal(checking.props.className, 'eb-checking')
    assert.equal(checking.props.style.visibility, refreshing ? 'visible' : 'hidden')
    assert.equal(textOf(checking), 'Checking for updates…')
    assert.equal(projects.type, kit.Btn)
    assert.equal(projects.props.primary, undefined, 'the Projects button is plain')
    assert.equal(projects.props['data-eb-setup-btn'], 'true')
    assert.equal(projects.props.type, 'button')
    assert.ok(['true', 'false'].includes(projects.props['aria-expanded']))
    assert.equal(textOf(projects), 'Projects')
    // Nothing of the header is drawn twice.
    assert.equal(findAll(tree, (node) => node.props.className === 'eb-header').length, 0)
    assert.equal(findAll(tree, (node) => node.type === `h${TITLE_LEVEL}`).length, 0, 'the h1 is a prop of PageHeader, drawn by the host')
  }
})

test('the header with PageHeader: the other states draw the title alone and no Projects button', () => {
  const kit = fakeKit()
  for (const view of [loadingView(), unreachableView(), errorView(), { ...loadingView(), unconfigured: true }]) {
    const tree = renderKit(view, kit)
    const [header] = ofType(tree, kit.PageHeader)
    assert.deepEqual(Object.keys(header.props), ['title'])
    assert.equal(findAll(tree, (node) => node.props['data-eb-setup-btn'] !== undefined).length, 0)
  }
})

test('the header without PageHeader is the earlier header, with a Btn or a native button for Projects', () => {
  for (const kit of [{}, fakeKit(['Btn'])]) {
    const tree = renderKit(planView(planBody()), kit)
    const [header] = findAll(tree, (node) => node.props.className === 'eb-header')
    assert.deepEqual(header.children.slice(0, 3).map((node) => node.props.className), ['eb-branch', 'eb-commit', 'eb-age'])
    assert.equal(header.children[3].props.className, 'eb-checking')
    const button = header.children[4]
    assert.equal(button.props['data-eb-setup-btn'], 'true')
    if (kit.Btn) assert.equal(button.type, kit.Btn)
    else assert.deepEqual([button.type, button.props.className], ['button', 'eb-fb'])
  }
})

test('the page takes its own gutter only when it has PageHeader', () => {
  assert.equal(render(loadingView()).props.className, 'eb-root')
  assert.equal(findAll(render(planView(planBody())), (node) => node.props.className === 'eb-body').length, 0)
  const tree = renderKit(loadingView(), fakeKit())
  assert.equal(tree.props.className, 'eb-root eb-has-header')
  assert.equal(tree.children.at(-1).props.className, 'eb-body')
})

test('the column header holds an aria-hidden dot, the name and the count, with the capitals in the style sheet', () => {
  const tree = render(planView(planBody()))
  const headings = findAll(tree, (node) => node.type === `h${TITLE_LEVEL + 1}`)
  assert.equal(headings.length, 3)
  headings.forEach((heading, i) => {
    const [dot, name, , count] = heading.children
    assert.deepEqual([dot.props.className, dot.props['aria-hidden'], dot.children], ['eb-dot', 'true', []])
    assert.equal(name.props.className, 'eb-column-name')
    assert.equal(name.children[0], ['Planned', 'In progress', 'Done'][i], 'the name is not in capitals')
    assert.equal(count.props.className, 'eb-count')
    assert.equal(textOf(heading), `${name.children[0]} ${count.children[0]}`)
  })
  assert.deepEqual(findAll(tree, (node) => node.props['data-column'] !== undefined).map((node) => node.props['data-column']), ['planned', 'in progress', 'done'])
  assert.match(STYLE, /\.eb-column-title\s*\{[^}]*text-transform:\s*uppercase/)
  assert.match(STYLE, /\.eb-column\s*\{[^}]*--eb-lane:\s*var\(--muted, currentColor\)/)
  assert.match(STYLE, /\.eb-column\[data-column='in progress'\]\s*\{[^}]*var\(--accent, currentColor\)/)
  assert.match(STYLE, /\.eb-column\[data-column='done'\]\s*\{[^}]*var\(--ok, currentColor\)/)
  assert.match(STYLE, /\.eb-dot\s*\{[^}]*width:\s*8px[^}]*height:\s*8px[^}]*border-radius:\s*50%/)
})

test('the empty plan with EmptyState: title, subtitle and, when the page has one, the icon', () => {
  const kit = fakeKit()
  const view = planView(planBody({ groups: [] }))
  const [empty] = ofType(renderKit(view, kit), kit.EmptyState)
  assert.deepEqual(propsOf(empty), { title: 'No specs or epics were found on main.', subtitle: 'Specs are read from .kiro/specs/ and epics from docs/epics/.' })
  const icon = { type: 'svg', props: {}, children: [] }
  const [withIcon] = ofType(renderKit({ ...view, icon }, kit), kit.EmptyState)
  assert.equal(withIcon.props.icon, icon)
  assert.deepEqual(Object.keys(propsOf(withIcon)).sort(), ['icon', 'subtitle', 'title'])
  // Without it: the two paragraphs, as before.
  const fallback = findAll(render(view), (node) => node.props.className === 'eb-empty')[0]
  assert.deepEqual(fallback.children.map((node) => node.type), ['p', 'p'])
})

test('the errors with ErrorNotice: the message, a footer with the code and the settings as code, no hand-off', () => {
  const kit = fakeKit()
  const [notice] = ofType(renderKit(errorView(true), kit), kit.ErrorNotice)
  assert.deepEqual(Object.keys(propsOf(notice)).sort(), ['footer', 'message'])
  assert.equal(notice.props.message, 'No repository is set.')
  assert.equal(textOf(notice.props.footer), 'repository_not_configuredEPIC_BOARD_REPOSITORY/Users/me/.kiro/epic-board.json')
  assert.deepEqual(findAll(notice.props.footer, (node) => node.type === 'code').map(textOf), ['EPIC_BOARD_REPOSITORY', '/Users/me/.kiro/epic-board.json'])
  const [bare] = ofType(renderKit(errorView(false), kit), kit.ErrorNotice)
  assert.equal(findAll(bare.props.footer, (node) => node.type === 'ul').length, 0)
  const [unreachable] = ofType(renderKit(unreachableView(), kit), kit.ErrorNotice)
  assert.deepEqual(propsOf(unreachable), { message: 'Could not reach the backend.' })
})

test('the roles: alert only on the two errors, without a kit and with one; status on the rest', () => {
  for (const kit of [{}, fakeKit(['PageHeader', 'Btn', 'EmptyState'])]) {
    const roles = (view) => rolesOf(renderKit(view, kit)).filter((role) => role === 'alert' || role === 'status')
    assert.deepEqual(roles(errorView()), ['alert'])
    assert.deepEqual(roles(unreachableView()), ['alert'])
    assert.deepEqual(roles(loadingView()), ['status'])
    assert.deepEqual(roles(planView(planBody({ fetch: { ok: false, reason: 'x' } }), { unreachable: true })), ['status', 'status'])
    assert.deepEqual(roles({ ...loadingView(), unconfigured: true }), ['status'])
  }
})

test('a kit with only some components draws those and the earlier markup for the rest, and the headings do not change', () => {
  const views = [planView(planBody()), planView(planBody({ groups: [] })), errorView(), unreachableView(), loadingView()]
  for (const view of views) {
    const none = headingLevels(renderKit(view, {}))
    for (const names of [['PageHeader'], ['EmptyState'], ['ErrorNotice'], ['Btn', 'Select'], FAKES]) {
      assert.deepEqual(headingLevels(renderKit(view, fakeKit(names))).filter((level) => level > TITLE_LEVEL), none.filter((level) => level > TITLE_LEVEL), names.join())
    }
  }
  const kit = fakeKit(['ErrorNotice'])
  assert.equal(ofType(renderKit(planView(planBody({ groups: [] })), kit), kit.ErrorNotice).length, 0)
  assert.equal(findAll(renderKit(planView(planBody({ groups: [] })), kit), (node) => node.props.className === 'eb-empty').length, 1)
  const header = fakeKit(['PageHeader'])
  assert.equal(findAll(renderKit(errorView(), header), (node) => node.props.className === 'eb-error').length, 1)
})

test('the filter row: both dropdowns are one Select with the same five props and no className, the project first', () => {
  const kit = fakeKit()
  const view = { ...planView(planBody()), projects: PROJECTS }
  const tree = renderKit(view, { ...kit })
  const [row] = findAll(tree, (node) => node.props.className === 'eb-filters')
  assert.deepEqual(row.children.map((box) => box.props.className), ['eb-filter', 'eb-filter'])
  const [project, epic] = row.children.map((box) => box.children[0])
  assert.equal(project.type, kit.Select)
  assert.equal(epic.type, kit.Select)
  for (const select of [project, epic]) {
    assert.deepEqual(Object.keys(select.props).sort(), ['aria-label', 'onChange', 'optionLabels', 'options', 'value'])
    assert.ok(select.props.options.every((option) => typeof option === 'string'))
  }
  assert.deepEqual([project.props['aria-label'], project.props.value, project.props.options, project.props.optionLabels], ['Project', 'b', ['a', 'b'], ['Alpha', 'Beta']])
  assert.equal(epic.props['aria-label'], 'Epic')
  assert.equal(epic.props.options[0], 'all')
  assert.equal(epic.props.optionLabels[0], 'All epics')
  const seen = []
  const wired = renderBoard(h, view, { switchProject: (id) => seen.push(['project', id]), filter: (key) => seen.push(['epic', key]) }, kit)
  const [p, e] = findAll(wired, (node) => node.props.className === 'eb-filter').map((box) => box.children[0])
  p.props.onChange('a')
  e.props.onChange('all')
  assert.deepEqual(seen, [['project', 'a'], ['epic', 'all']])
})

test('the filter row: the epic dropdown is hidden for an empty plan, and the project dropdown stays', () => {
  const kit = fakeKit()
  const view = { ...planView(planBody({ groups: [] })), projects: PROJECTS }
  const boxes = findAll(renderKit(view, kit), (node) => node.props.className === 'eb-filter')
  assert.deepEqual(boxes.map((box) => box.children[0].props['aria-label']), ['Project'])
  assert.equal(findAll(renderKit(planView(planBody({ groups: [] })), kit), (node) => node.props.className === 'eb-filters').length, 0)
})

test('the filter row without Select: two native selects that carry eb-fb, with the same names and options', () => {
  const view = { ...planView(planBody()), projects: PROJECTS }
  for (const kit of [{}, fakeKit(FAKES.filter((name) => name !== 'Select'))]) {
    const selects = nativeSelects(renderKit(view, kit))
    assert.deepEqual(selects.map((node) => [node.props['aria-label'], node.props.className]), [['Project', 'eb-fb'], ['Epic', 'eb-fb']])
    assert.deepEqual(selects[0].children.map((option) => [option.props.value, textOf(option)]), [['a', 'Alpha'], ['b', 'Beta']])
  }
})

test('the first-run notice: status, no alert, and "Set up projects" is primary with its accessible name', () => {
  const view = { ...loadingView(), unconfigured: true, setupState: { phase: 'closed' } }
  const kit = fakeKit()
  const [notice] = findAll(renderKit(view, kit), (node) => node.props.className === 'eb-notice')
  assert.equal(notice.props.role, 'status')
  assert.equal(textOf(notice.children[0]), 'Choose your projects')
  const button = notice.children[1]
  assert.equal(button.type, kit.Btn)
  assert.deepEqual(Object.keys(button.props).sort(), ['aria-expanded', 'aria-label', 'onClick', 'primary', 'type'])
  assert.deepEqual([button.props.primary, button.props['aria-label'], button.props['aria-expanded'], textOf(button)], [true, 'Set up projects', 'false', 'Set up projects'])
  assert.equal(rolesOf(renderKit(view, kit)).includes('alert'), false)
  const plain = findAll(render(view), (node) => node.props.className === 'eb-notice')[0].children[1]
  assert.deepEqual([plain.type, plain.props.className, plain.props['aria-label']], ['button', 'eb-fb', 'Set up projects'])
})

test('every component gets only the props the design names', () => {
  const kit = fakeKit()
  const views = [planView(planBody()), planView(planBody({ groups: [] })), errorView(), unreachableView(), loadingView(), { ...loadingView(), unconfigured: true }]
  const allowed = {
    PageHeader: ['title', 'subtitle', 'actions'],
    Btn: ['type', 'aria-expanded', 'aria-label', 'data-eb-setup-btn', 'onClick', 'primary', 'key'],
    EmptyState: ['title', 'subtitle', 'icon', 'key'],
    ErrorNotice: ['message', 'footer', 'key'],
    Select: ['aria-label', 'value', 'options', 'optionLabels', 'onChange'],
  }
  for (const view of views) {
    for (const node of elements(renderKit({ ...view, projects: PROJECTS }, kit))) {
      const name = Object.keys(allowed).find((key) => kit[key] === node.type)
      if (name) for (const prop of Object.keys(node.props)) assert.ok(allowed[name].includes(prop), `${name} got ${prop}`)
    }
  }
})

// ---- Board design, group 3: the cards, the badges, the buttons and the panel's look ----

const cardIn = (tree) => findAll(tree, (node) => node.props?.['data-mode'] !== undefined)[0]
const inKit = (node, type) => findAll(node, (n) => n.type === type)
const startable = (kit, over = {}) => renderKit({ ...chatsView(over), panelAvailable: true }, kit)

test('a card with Card: li.eb-item holds a Card with the class and the data attributes; without Card the earlier li', () => {
  const kit = fakeKit()
  const view = { ...openView({ card: { spec: 'alpha', tasks: { done: 1, total: 2 }, description: 'about it' } }), panelAvailable: true }
  const tree = renderKit(view, kit)
  const [item] = findAll(tree, (node) => node.type === 'li')
  assert.equal(item.props.className, 'eb-item')
  const [card] = inKit(item, kit.Card)
  assert.deepEqual(propsOf(card), { className: 'eb-card', 'data-mode': 'chat', 'data-open': 'true' })
  const plain = findAll(renderKit(view, fakeKit(['Btn'])), (node) => node.type === 'li')[0]
  assert.equal(plain.props.className, 'eb-card eb-fb')
  assert.deepEqual([plain.props['data-mode'], plain.props['data-open']], ['chat', 'true'])
  const closed = findAll(renderKit(chatsView(), kit), (node) => node.type === 'li')[0]
  assert.equal('data-open' in propsOf(inKit(closed, kit.Card)[0]), false)
})

test('the card name is a CardTitle with role presentation and no heading, or the earlier div', () => {
  const kit = fakeKit()
  for (const view of [chatsView(), chatsView({ chats: withChat() }), chatsView({ card: { status: 'done' } })]) {
    const tree = renderKit(view, kit)
    const [title] = inKit(tree, kit.CardTitle)
    assert.deepEqual(propsOf(title), { className: 'eb-card-name', role: 'presentation' })
    assert.deepEqual(findAll(theCardOf(tree, kit), (n) => /^h[1-6]$/.test(String(n.type))), [])
    const [name] = findAll(renderKit(view, {}), (node) => node.props.className === 'eb-card-name')
    assert.equal(name.type, 'div')
  }
})
const theCardOf = (tree, kit) => findAll(tree, (node) => node.type === kit.Card)[0]

test('the card keeps the stretched link, the controls and data-card-id where the start spec puts them, with and without a kit', () => {
  for (const kit of [{}, fakeKit()]) {
    const tree = renderKit(chatsView(), kit)
    const [main] = findAll(tree, (node) => node.props.className === 'eb-card-main')
    assert.deepEqual([main.type, main.props['data-card-id']], ['button', CARD_ID])
    const [name] = findAll(tree, (node) => node.props.className === 'eb-card-name')
    assert.equal(findAll(name, (node) => node === main).length, 1)
  }
})

test('the progress badge is muted, or ok when every task is ticked; a card with no tasks has a plain meta line', () => {
  const kit = fakeKit()
  const badgeOf = (tasks, spec = 'alpha') => inKit(renderKit(chatsView({ card: { spec, tasks } }), kit), kit.Badge)
  const [some] = badgeOf({ done: 1, total: 2 })
  assert.deepEqual(propsOf(some), { variant: 'muted', className: 'eb-progress' })
  assert.equal(textOf(some), '1 of 2 tasks')
  assert.equal(badgeOf({ done: 2, total: 2 })[0].props.variant, 'ok')
  assert.deepEqual(badgeOf({ done: 0, total: 0 }), [])
  assert.deepEqual(badgeOf(null), [])
  assert.deepEqual(badgeOf(null, null), [])
  const [meta] = findAll(renderKit(chatsView({ card: { spec: null } }), kit), (node) => /(^| )eb-card-progress( |$)/.test(node.props.className ?? ''))
  assert.equal(meta.props.className, 'eb-card-progress eb-card-meta')
  assert.equal(textOf(meta), 'No spec yet')
  const without = findAll(renderKit(chatsView({ card: { spec: 'a', tasks: { done: 1, total: 2 } } }), {}), (node) => /(^| )eb-card-progress( |$)/.test(node.props.className ?? ''))
  assert.equal(textOf(without[0]), '1 of 2 tasks')
  const bar = findAll(renderKit(chatsView({ card: { spec: 'a', tasks: { done: 1, total: 2 } } }), kit), (node) => node.props.className === 'eb-bar')
  assert.equal(bar[0].props['aria-hidden'], 'true')
})

test('the state word is a Badge with the variant of its state, and the earlier span without one', () => {
  const kit = fakeKit()
  const variants = { 'needs-you': 'warn', interrupted: 'err', working: 'ok', stalled: 'warn', 'your-turn': 'muted' }
  for (const [state, variant] of Object.entries(variants)) {
    const [badge] = inKit(renderKit(chatsView({ chats: withChat('k1', { state }) }), kit), kit.Badge)
    assert.deepEqual(propsOf(badge), { variant, className: 'eb-chat-state', 'data-state': state }, state)
  }
  const review = (failed) => ({ state: 'review', review: { number: 7, url: 'https://github.com/o/r/pull/7', failed } })
  assert.equal(inKit(renderKit(chatsView({ chats: withChat('k1', review(false)) }), kit), kit.Badge)[0].props.variant, 'muted')
  const [failed] = inKit(renderKit(chatsView({ chats: withChat('k1', review(true)) }), kit), kit.Badge)
  assert.equal(failed.props.variant, 'err')
  assert.equal(textOf(failed), 'Checks failed #7')
  assert.equal(inKit(failed, 'a').length, 1, 'the word is still the link')
  const [span] = findAll(renderKit(chatsView({ chats: withChat('k1', { state: 'working' }) }), {}), (node) => node.props['data-state'] === 'working')
  assert.deepEqual([span.type, span.props.className], ['span', 'eb-chat-state eb-fb'])
})

test('every card button is a Btn, with Start primary and the rest plain, or a native button.eb-fb', () => {
  const kit = fakeKit()
  const cases = [
    [chatsView({ ui: { asking: CARD_ID } }), ['Start', 'Cancel']],
    [chatsView({ ui: { asking: CARD_ID }, chats: { folder: { id: null, reason: null } } }), ['Close']],
    [chatsView({ chats: missing(60000) }), ['Resume chat']],
    [chatsView({ chats: missing(60000), ui: { resumes: { k1: { kind: 'failed', reason: 'x' } } } }), ['Start again']],
    [chatsView({ chats: withChat(), ui: { briefs: { k1: { kind: 'failed', reason: 'x' } } } }), ['Send the brief again']],
  ]
  for (const [view, labels] of cases) {
    const found = findAll(renderKit(view, kit), (node) => node.type === kit.Btn && node.props['data-eb-setup-btn'] === undefined)
    assert.deepEqual(found.map(textOf), labels)
    for (const btn of found) {
      assert.equal(btn.props.type, 'button')
      assert.equal(btn.props.primary, textOf(btn) === 'Start' ? true : undefined)
      assert.equal(btn.props.busy, undefined)
      assert.deepEqual(Object.keys(btn.props).filter((p) => !['type', 'onClick', 'primary', 'data-eb-start'].includes(p)), [])
    }
    const native = findAll(renderKit(view, {}), (node) => node.type === 'button' && node.props['data-card-id'] === undefined && node.props['data-eb-setup-btn'] === undefined)
    assert.deepEqual(native.map(textOf), labels)
    assert.ok(native.every((node) => node.props.className === 'eb-fb'))
  }
})

test('a card button calls its action with and without a kit', () => {
  const { calls, actions } = recorder()
  const kit = fakeKit()
  const tree = renderBoard(h, chatsView({ ui: { asking: CARD_ID } }), actions, kit)
  for (const btn of findAll(tree, (node) => node.type === kit.Btn && node.props['data-eb-setup-btn'] === undefined)) btn.props.onClick()
  assert.deepEqual(calls, [['start', CARD_ID, 'Story'], ['cancel', CARD_ID]])
})

test('every card keeps the same words and headings with the whole kit', () => {
  const kit = fakeKit()
  const views = [chatsView(), chatsView({ ui: { asking: CARD_ID } }), chatsView({ chats: withChat('k1', { state: 'working' }) }), chatsView({ chats: missing(60000) })]
  for (const view of views) {
    const plain = textOf(renderKit(view, {}))
    const full = textOf(renderKit(view, kit))
    for (const word of ['Story', 'Start', 'Cancel', 'Working', 'Resume chat']) assert.equal(full.includes(word), plain.includes(word), word)
    assert.deepEqual(headingLevels(renderKit(view, kit)).filter((l) => l > TITLE_LEVEL), headingLevels(renderKit(view, {})).filter((l) => l > TITLE_LEVEL))
  }
})

test('the Panel with a kit: the same elements for a chat and for the Projects view, with a plain Btn for Close', () => {
  const kit = fakeKit()
  const closed = []
  for (const content of [h(FakeChat, { slotKey: 'k1', conversationOnly: true }), h('div', { className: 'eb-setup' })]) {
    const withKit = renderPanel(h, { title: 'T' }, content, { closeChat: () => closed.push(1) }, kit)
    const without = renderPanel(h, { title: 'T' }, content, { closeChat: () => closed.push(2) })
    assert.deepEqual(withKit.children.map((node) => node.props.className), ['eb-panel-head', 'eb-panel-body'])
    assert.deepEqual(withKit.children[0].children.map((node) => node.props.className ?? 'close'), ['eb-panel-title', 'close'])
    const [btn] = inKit(withKit, kit.Btn)
    assert.deepEqual(Object.keys(btn.props).sort(), ['onClick', 'type'])
    assert.equal(textOf(btn), 'Close')
    btn.props.onClick()
    const [native] = buttons(without)
    assert.deepEqual([native.props.className, textOf(native)], ['eb-fb', 'Close'])
  }
  assert.deepEqual(closed, [1, 1])
})

// The body of the first rule whose selector list holds `selector`.
const ruleOf = (selector) => {
  for (const rule of STYLE.matchAll(/([^{}@]+)\{([^{}]*)\}/g)) {
    if (rule[1].split(',').map((part) => part.trim()).includes(selector)) return rule[2]
  }
  return null
}

test('STYLE: the panel has the head bar, the border line and the page background, all as tokens', () => {
  assert.deepEqual(themeProblems(STYLE), [])
  const head = ruleOf('.eb-panel-head')
  assert.match(head, /background:\s*var\(--bg-elevated, transparent\)/)
  assert.match(head, /border-bottom:\s*1px solid var\(--border, currentColor\)/)
  assert.match(head, /padding:\s*0 8px/)
  assert.match(head, /min-height:\s*40px/)
  assert.doesNotMatch(head, /currentColor\s*;|solid currentColor/)
  const title = ruleOf('.eb-panel-title')
  assert.match(title, /font-size:\s*11\.5px/)
  assert.match(title, /font-weight:\s*600/)
  assert.doesNotMatch(title, /color/)
  assert.match(ruleOf('.eb-panel'), /background:\s*var\(--bg, transparent\)/)
  assert.doesNotMatch(ruleOf('.eb-panel'), /border/)
  assert.doesNotMatch(STYLE, /outline:\s*none/)
})

test('STYLE: the left border of the panel is a --border line, only in the two beside-the-board rules', () => {
  const lines = STYLE.split('\n').filter((line) => /border-left/.test(line))
  assert.equal(lines.length, 2)
  for (const line of lines) {
    assert.match(line, /\.eb-panel \{[^}]*border-left:\s*1px solid var\(--border, currentColor\)/)
    assert.match(line, /position: static/)
  }
  assert.match(blockBody(STYLE, '@container eb-shell (min-width: 1000px)'), /border-left:\s*1px solid var\(--border, currentColor\)/)
  assert.doesNotMatch(STYLE, /\.eb-panel[^{]*\{[^}]*border[^}]*solid currentColor/)
})

test('STYLE: no rule selects inside the panel body, and the body keeps its two lines', () => {
  const selectors = [...STYLE.matchAll(/([^{}@]+)\{/g)].flatMap((rule) => rule[1].split(',').map((part) => part.trim()))
  assert.deepEqual(selectors.filter((selector) => selector.includes('.eb-panel-body')), ['.eb-panel-body'])
  assert.equal(ruleOf('.eb-panel-body').trim(), 'flex: 1 1 0; min-height: 0;')
  assert.deepEqual(STYLE.match(/\.eb-panel-(head|title)[^{]*\{[^}]*\}/g).map((rule) => (rule.match(/font-size:\s*[\d.]+px/g) ?? []).join()), ['', 'font-size: 11.5px', ''])
})

test('STYLE: the fallback looks sit under .eb-fb, so a Crew component is never drawn over them', () => {
  for (const selector of ['.eb-chat-state.eb-fb', '.eb-panel-head button.eb-fb', '.eb-question button.eb-fb']) assert.ok(ruleOf(selector) !== null, selector)
  assert.doesNotMatch(STYLE, /(^|\n)\.eb-chat-state\s*[{,]/)
  assert.match(ruleOf('.eb-card-meta'), /font-size:\s*12px[^}]*var\(--muted, currentColor\)/)
  assert.match(ruleOf('.eb-card[data-open=\'true\']'), /border-color:\s*currentColor[^}]*box-shadow:\s*0 0 0 1px currentColor/)
  assert.match(ruleOf('.eb-card'), /position:\s*relative[^}]*margin-bottom:\s*0/)
  assert.match(ruleOf('.eb-card-description'), /-webkit-line-clamp:\s*3/)
})
