// Tests for readFolders, initialSetup, setupReduce and renderSetupView.
import test from 'node:test'
import assert from 'node:assert/strict'

import { readFolders, initialSetup, setupReduce, renderSetupView } from '../../ui/index.mjs'

// Minimal vdom helper and traversal used in renderSetupView tests.
const h = (type, props, ...children) => ({ type, props: props ?? {}, children: children.flat().filter((c) => c != null) })
const findAll = (node, fn) => {
  if (!node || typeof node !== 'object' || !node.type) return []
  const acc = fn(node) ? [node] : []
  for (const child of node.children ?? []) acc.push(...findAll(child, fn))
  return acc
}
const textOf = (node) => {
  if (typeof node === 'string') return node
  if (!node || typeof node !== 'object') return ''
  return (node.children ?? []).map(textOf).join('')
}
const allText = (tree) => textOf(tree)
const buttons = (tree) => findAll(tree, (n) => n.type === 'button')
const inputs = (tree) => findAll(tree, (n) => n.type === 'input')

// ---- readFolders ----

test('readFolders: null for non-array body', () => {
  assert.equal(readFolders(null), null)
  assert.equal(readFolders({}), null)
  assert.equal(readFolders('x'), null)
})

test('readFolders: empty array returns empty array', () => {
  assert.deepEqual(readFolders([]), [])
})

test('readFolders: item with no project_dir and no parent is excluded', () => {
  const result = readFolders([{ id: 'f1', name: 'Folder', project_dir: null }])
  assert.deepEqual(result, [])
})

test('readFolders: item with project_dir is included', () => {
  const result = readFolders([{ id: 'f1', name: 'Folder', project_dir: '/home/x/proj' }])
  assert.deepEqual(result, [{ id: 'f1', name: 'Folder', project_dir: '/home/x/proj' }])
})

test('readFolders: item missing id or name is skipped', () => {
  const result = readFolders([
    { id: 'f1', project_dir: '/p' },        // no name
    { name: 'N', project_dir: '/p' },       // no id
    { id: 42, name: 'N', project_dir: '/p' }, // non-string id
  ])
  assert.deepEqual(result, [])
})

test('readFolders: hidden:true is excluded', () => {
  const result = readFolders([{ id: 'f1', name: 'H', project_dir: '/p', hidden: true }])
  assert.deepEqual(result, [])
})

test('readFolders: non-empty owner_app is excluded', () => {
  const result = readFolders([{ id: 'f1', name: 'O', project_dir: '/p', owner_app: 'kiro' }])
  assert.deepEqual(result, [])
})

test('readFolders: mate_home:true is excluded', () => {
  const result = readFolders([{ id: 'f1', name: 'M', project_dir: '/p', mate_home: true }])
  assert.deepEqual(result, [])
})

test('readFolders: item with no project_dir but parent has one is included with parent dir', () => {
  const result = readFolders([
    { id: 'parent', name: 'Parent', project_dir: '/parent/dir' },
    { id: 'child', name: 'Child', project_dir: null, parent_id: 'parent' },
  ])
  const child = result.find((r) => r.id === 'child')
  assert.ok(child, 'child included')
  assert.equal(child.project_dir, '/parent/dir')
})

test('readFolders: chain of two parents resolves to grandparent dir', () => {
  const result = readFolders([
    { id: 'grand', name: 'Grand', project_dir: '/grand/dir' },
    { id: 'mid', name: 'Mid', project_dir: null, parent_id: 'grand' },
    { id: 'child', name: 'Child', project_dir: null, parent_id: 'mid' },
  ])
  const child = result.find((r) => r.id === 'child')
  assert.ok(child, 'child included')
  assert.equal(child.project_dir, '/grand/dir')
})

test('readFolders: cycle hits hop limit and item is excluded', () => {
  const result = readFolders([
    { id: 'a', name: 'A', project_dir: null, parent_id: 'b' },
    { id: 'b', name: 'B', project_dir: null, parent_id: 'a' },
  ])
  assert.deepEqual(result, [])
})

test('readFolders: child excluded when parent is hidden', () => {
  const result = readFolders([
    { id: 'hidden-parent', name: 'HP', project_dir: '/p', hidden: true },
    { id: 'child', name: 'C', project_dir: null, parent_id: 'hidden-parent' },
  ])
  const child = result.find((r) => r.id === 'child')
  assert.ok(!child, 'child should be excluded when parent is hidden')
})

test('readFolders: empty string owner_app is not excluded', () => {
  const result = readFolders([{ id: 'f1', name: 'F', project_dir: '/p', owner_app: '' }])
  assert.equal(result.length, 1)
})

// ---- initialSetup ----

test('initialSetup has closed phase and null fields', () => {
  assert.equal(initialSetup.phase, 'closed')
  assert.equal(initialSetup.folders, null)
  assert.equal(initialSetup.setupInfo, null)
  assert.deepEqual(initialSetup.checks, {})
  assert.deepEqual(initialSetup.names, {})
  assert.equal(initialSetup.saveError, null)
})

// ---- setupReduce ----

test('setupReduce: setup-open resets to opening phase', () => {
  const prev = { ...initialSetup, phase: 'ready', saveError: 'oops' }
  const next = setupReduce(prev, { kind: 'setup-open' })
  assert.equal(next.phase, 'opening')
  assert.equal(next.saveError, null)
  assert.deepEqual(next.checks, {})
})

test('setupReduce: setup-loaded transitions to ready and pre-fills matching folders', () => {
  const folders = [
    { id: 'f1', name: 'Alpha', project_dir: '/a' },
    { id: 'f2', name: 'Beta', project_dir: '/b' },
  ]
  const setupInfo = { source: 'config', config_has_projects: false, projects: [
    { folder_id: 'f1', name: 'Alpha Renamed' },
  ]}
  const next = setupReduce({ ...initialSetup, phase: 'opening' },
                           { kind: 'setup-loaded', folders, setupInfo })
  assert.equal(next.phase, 'ready')
  assert.equal(next.checks['f1'], true)
  assert.equal(next.names['f1'], 'Alpha Renamed')
  assert.equal(next.checks['f2'], false)
  assert.equal(next.names['f2'], '')
})

test('setupReduce: setup-loaded with no matching folder leaves it unticked', () => {
  const folders = [{ id: 'f99', name: 'NoMatch', project_dir: '/x' }]
  const setupInfo = { projects: [] }
  const next = setupReduce(initialSetup, { kind: 'setup-loaded', folders, setupInfo })
  assert.equal(next.checks['f99'], false)
  assert.equal(next.names['f99'], '')
})

test('setupReduce: setup-load-failed sets error phase', () => {
  const next = setupReduce(initialSetup, { kind: 'setup-load-failed', message: 'timeout' })
  assert.equal(next.phase, 'error')
  assert.equal(next.saveError, 'timeout')
})

test('setupReduce: setup-check toggles the check without clearing name', () => {
  const state = {
    ...initialSetup,
    phase: 'ready',
    checks: { f1: true },
    names: { f1: 'My Project' },
  }
  const next = setupReduce(state, { kind: 'setup-check', folderId: 'f1', checked: false })
  assert.equal(next.checks['f1'], false)
  assert.equal(next.names['f1'], 'My Project')  // name preserved
})

test('setupReduce: setup-name sets the name for a folder', () => {
  const state = { ...initialSetup, phase: 'ready', names: { f1: '' } }
  const next = setupReduce(state, { kind: 'setup-name', folderId: 'f1', value: 'New Name' })
  assert.equal(next.names['f1'], 'New Name')
})

test('setupReduce: setup-saving sets saving phase and clears saveError', () => {
  const state = { ...initialSetup, phase: 'ready', saveError: 'previous error' }
  const next = setupReduce(state, { kind: 'setup-saving' })
  assert.equal(next.phase, 'saving')
  assert.equal(next.saveError, null)
})

test('setupReduce: setup-save-failed returns to ready with error', () => {
  const state = { ...initialSetup, phase: 'saving' }
  const next = setupReduce(state, { kind: 'setup-save-failed', message: 'server down' })
  assert.equal(next.phase, 'ready')
  assert.equal(next.saveError, 'server down')
})

test('setupReduce: setup-close returns to initialSetup', () => {
  const state = { ...initialSetup, phase: 'ready', checks: { f1: true } }
  const next = setupReduce(state, { kind: 'setup-close' })
  assert.equal(next.phase, 'closed')
  assert.deepEqual(next.checks, {})
})

test('setupReduce: unknown action returns state unchanged', () => {
  const state = { ...initialSetup, phase: 'ready' }
  const next = setupReduce(state, { kind: 'unknown-action' })
  assert.equal(next, state)
})

// ---- renderSetupView ----

test('renderSetupView: closed phase returns null', () => {
  assert.equal(renderSetupView(h, initialSetup, {}), null)
})

test('renderSetupView: opening phase shows Loading and a Close button', () => {
  const state = { ...initialSetup, phase: 'opening' }
  const tree = renderSetupView(h, state, {})
  assert.ok(allText(tree).includes('Loading'), 'shows Loading text')
  const btns = buttons(tree)
  assert.equal(btns.length, 1)
  assert.equal(btns[0].children[0], 'Close')
})

test('renderSetupView: error phase shows error text, Try again, and Close', () => {
  const state = { ...initialSetup, phase: 'error', saveError: 'Oops' }
  const tree = renderSetupView(h, state, {})
  assert.ok(allText(tree).includes('Oops'), 'shows error message')
  const btns = buttons(tree)
  assert.ok(btns.some((b) => b.children[0] === 'Try again'), 'Try again button')
  assert.ok(btns.some((b) => b.children[0] === 'Close'), 'Close button')
})

test('renderSetupView: error phase shows fallback message when saveError is null', () => {
  const state = { ...initialSetup, phase: 'error', saveError: null }
  const tree = renderSetupView(h, state, {})
  assert.ok(allText(tree).includes('Could not load folder list'), 'shows fallback message')
})

test('renderSetupView: ready with no folders shows no-folders message and Close only', () => {
  const state = { ...initialSetup, phase: 'ready', folders: [] }
  const tree = renderSetupView(h, state, {})
  assert.ok(allText(tree).includes('No Crew folders have a project directory'), 'shows no-folders message')
  const btns = buttons(tree)
  assert.equal(btns.length, 1)
  assert.equal(btns[0].children[0], 'Close')
})

test('renderSetupView: ready with two folders shows two checkboxes', () => {
  const state = {
    ...initialSetup, phase: 'ready',
    folders: [{ id: 'f1', name: 'Alpha', project_dir: '/a' }, { id: 'f2', name: 'Beta', project_dir: '/b' }],
    checks: { f1: false, f2: false }, names: { f1: '', f2: '' }, setupInfo: null,
  }
  const tree = renderSetupView(h, state, {})
  const checkboxes = inputs(tree).filter((i) => i.props.type === 'checkbox')
  assert.equal(checkboxes.length, 2)
})

test('renderSetupView: Save button disabled when nothing is ticked', () => {
  const state = {
    ...initialSetup, phase: 'ready',
    folders: [{ id: 'f1', name: 'Alpha', project_dir: '/a' }],
    checks: { f1: false }, names: { f1: '' }, setupInfo: null,
  }
  const tree = renderSetupView(h, state, {})
  const saveBtn = buttons(tree).find((b) => b.children[0] === 'Save')
  assert.ok(saveBtn, 'Save button present')
  assert.equal(saveBtn.props.disabled, true)
})

test('renderSetupView: Save button disabled when a ticked folder has an empty name', () => {
  const state = {
    ...initialSetup, phase: 'ready',
    folders: [{ id: 'f1', name: 'Alpha', project_dir: '/a' }],
    checks: { f1: true }, names: { f1: '' }, setupInfo: null,
  }
  const tree = renderSetupView(h, state, {})
  const saveBtn = buttons(tree).find((b) => b.children[0] === 'Save')
  assert.ok(saveBtn, 'Save button present')
  assert.equal(saveBtn.props.disabled, true)
})

test('renderSetupView: Save button enabled when one ticked folder has a non-empty name', () => {
  const state = {
    ...initialSetup, phase: 'ready',
    folders: [{ id: 'f1', name: 'Alpha', project_dir: '/a' }],
    checks: { f1: true }, names: { f1: 'My Project' }, setupInfo: null,
  }
  const tree = renderSetupView(h, state, {})
  const saveBtn = buttons(tree).find((b) => b.children[0] === 'Save')
  assert.ok(saveBtn, 'Save button present')
  assert.ok(!saveBtn.props.disabled, 'Save enabled')
})

test('renderSetupView: saving phase disables Save and shows Saving text, no Cancel', () => {
  const state = {
    ...initialSetup, phase: 'saving',
    folders: [{ id: 'f1', name: 'Alpha', project_dir: '/a' }],
    checks: { f1: true }, names: { f1: 'My Project' }, setupInfo: null,
  }
  const tree = renderSetupView(h, state, {})
  const saveBtn = buttons(tree).find((b) => allText(b).includes('Saving'))
  assert.ok(saveBtn, 'Saving button present')
  assert.equal(saveBtn.props.disabled, true)
  assert.ok(!buttons(tree).some((b) => b.children[0] === 'Cancel'), 'no Cancel while saving')
})

test('renderSetupView: saveError shown with role=status when in ready phase', () => {
  const state = {
    ...initialSetup, phase: 'ready',
    folders: [{ id: 'f1', name: 'Alpha', project_dir: '/a' }],
    checks: { f1: false }, names: { f1: '' }, setupInfo: null,
    saveError: 'Save failed',
  }
  const tree = renderSetupView(h, state, {})
  const statusNodes = findAll(tree, (n) => n.props.role === 'status')
  assert.ok(statusNodes.some((n) => allText(n).includes('Save failed')), 'saveError shown as status')
})

test('renderSetupView: config.json notice shown when source=saved and config_has_projects', () => {
  const state = {
    ...initialSetup, phase: 'ready',
    folders: [{ id: 'f1', name: 'Alpha', project_dir: '/a' }],
    checks: { f1: false }, names: { f1: '' },
    setupInfo: { source: 'saved', config_has_projects: true, projects: [] },
  }
  const tree = renderSetupView(h, state, {})
  const statusNodes = findAll(tree, (n) => n.props.role === 'status')
  assert.ok(statusNodes.some((n) => allText(n).includes('config.json')), 'config.json notice shown')
})

test('renderSetupView: config.json notice NOT shown when source is not saved', () => {
  const state = {
    ...initialSetup, phase: 'ready',
    folders: [{ id: 'f1', name: 'Alpha', project_dir: '/a' }],
    checks: { f1: false }, names: { f1: '' },
    setupInfo: { source: 'config', config_has_projects: true, projects: [] },
  }
  const tree = renderSetupView(h, state, {})
  const statusNodes = findAll(tree, (n) => n.props.role === 'status')
  assert.ok(!statusNodes.some((n) => allText(n).includes('config.json')), 'no config.json notice')
})

test('renderSetupView: a ticked folder shows a text input; an unticked one does not', () => {
  const state = {
    ...initialSetup, phase: 'ready',
    folders: [
      { id: 'f1', name: 'Alpha', project_dir: '/a' },
      { id: 'f2', name: 'Beta', project_dir: '/b' },
    ],
    checks: { f1: true, f2: false }, names: { f1: 'My Project', f2: '' }, setupInfo: null,
  }
  const tree = renderSetupView(h, state, {})
  const textInputs = inputs(tree).filter((i) => i.props.type === 'text')
  assert.equal(textInputs.length, 1, 'one text input for the ticked folder')
  assert.equal(textInputs[0].props.value, 'My Project')
})

// ---- Board design, group 3: the Projects view with a kit ----

const Btn = () => null
const KIT = { Btn }
// The buttons of a tree, whether they are native or a Btn.
const pressables = (tree) => findAll(tree, (n) => n.type === 'button' || n.type === Btn)
const FOLDERS = [{ id: 'f1', name: 'Alpha', project_dir: '/a/alpha' }, { id: 'f2', name: 'Beta', project_dir: '/b/beta' }]
const readyState = (over = {}) => ({
  ...initialSetup, phase: 'ready', folders: FOLDERS, checks: { f1: true, f2: false }, names: { f1: 'Alpha', f2: '' }, setupInfo: null, ...over,
})
const classOf = (node) => String(node.props.className ?? '').split(' ')

test('the folder row: label with the checkbox and the name, the directory as text, the name field only when ticked', () => {
  for (const kit of [{}, KIT]) {
    const tree = renderSetupView(h, readyState(), {}, kit)
    const rows = findAll(tree, (n) => n.type === 'li')
    assert.deepEqual(rows.map((row) => row.props.className), ['eb-folder', 'eb-folder'])
    const [first, second] = rows
    assert.deepEqual(first.children.map((node) => node.props.className), ['eb-folder-label', 'eb-folder-dir', 'eb-folder-name'])
    assert.deepEqual(second.children.map((node) => node.props.className), ['eb-folder-label', 'eb-folder-dir'])
    assert.deepEqual(first.children[0].children.map((node) => node.type ?? node), ['input', 'Alpha'])
    assert.deepEqual(first.children[0].children[0].props.type, 'checkbox')
    assert.deepEqual(first.children[1].children, ['/a/alpha'])
    const field = first.children[2]
    assert.deepEqual([field.type, field.props.type, field.props['aria-label'], field.props.placeholder], ['input', 'text', 'Name for Alpha', 'Alpha'])
  }
})

test('Save is primary and not busy, Cancel is plain, both in one div.eb-setup-actions, and with no kit they are button.eb-fb', () => {
  const calls = []
  const actions = { saveSetup: () => calls.push('save'), closeSetup: () => calls.push('cancel') }
  const tree = renderSetupView(h, readyState(), actions, KIT)
  const [box] = findAll(tree, (n) => n.props.className === 'eb-setup-actions')
  assert.deepEqual(box.children.map((node) => [node.type === Btn, textOf(node)]), [[true, 'Save'], [true, 'Cancel']])
  const [save, cancel] = box.children
  assert.deepEqual(Object.keys(save.props).sort(), ['disabled', 'onClick', 'primary', 'type'])
  assert.deepEqual([save.props.primary, save.props.disabled, save.props.busy], [true, false, undefined])
  assert.deepEqual(Object.keys(cancel.props).sort(), ['onClick', 'type'])
  save.props.onClick()
  cancel.props.onClick()
  assert.deepEqual(calls, ['save', 'cancel'])
  const nothing = renderSetupView(h, readyState({ checks: {} }), actions, KIT)
  assert.equal(findAll(nothing, (n) => n.type === Btn)[0].props.disabled, true)
  const saving = renderSetupView(h, readyState({ phase: 'saving' }), actions, KIT)
  assert.deepEqual(pressables(saving).map((node) => [textOf(node), node.props.disabled, node.props.busy]), [['Saving…', true, undefined]])
  const plain = renderSetupView(h, readyState(), actions, {})
  assert.deepEqual(buttons(plain).map((node) => [textOf(node), node.props.className]), [['Save', 'eb-fb'], ['Cancel', 'eb-fb']])
})

test('Try again and Close are plain in every phase, with a kit and without', () => {
  const phases = [
    [{ ...initialSetup, phase: 'opening' }, ['Close']],
    [{ ...initialSetup, phase: 'error', saveError: 'Oops' }, ['Try again', 'Close']],
    [{ ...initialSetup, phase: 'ready', folders: [] }, ['Close']],
  ]
  for (const [state, labels] of phases) {
    const withKit = pressables(renderSetupView(h, state, {}, KIT))
    assert.deepEqual(withKit.map(textOf), labels)
    assert.ok(withKit.every((node) => node.type === Btn && node.props.primary === undefined && node.props.type === 'button'))
    const without = buttons(renderSetupView(h, state, {}, {}))
    assert.deepEqual(without.map(textOf), labels)
    assert.ok(without.every((node) => node.props.className === 'eb-fb'))
  }
})

test('the three notices keep the role status, take eb-notice (and eb-notice-error for the errors), and are no alert', () => {
  const config = readyState({ setupInfo: { source: 'saved', config_has_projects: true, projects: [] } })
  const cases = [
    [config, ['eb-notice']],
    [readyState({ saveError: 'Could not save' }), ['eb-notice', 'eb-notice-error']],
    [{ ...initialSetup, phase: 'error', saveError: 'Could not read' }, ['eb-notice', 'eb-notice-error']],
  ]
  for (const kit of [{}, KIT]) {
    for (const [state, classes] of cases) {
      const tree = renderSetupView(h, state, {}, kit)
      const notices = findAll(tree, (n) => classOf(n).includes('eb-notice'))
      assert.equal(notices.length, 1)
      assert.deepEqual([notices[0].type, notices[0].props.role, classOf(notices[0])], ['p', 'status', classes])
      assert.equal(findAll(tree, (n) => n.props.role === 'alert').length, 0)
    }
  }
})

test('the Projects view adds no heading and no ErrorNotice, with every kit component present', () => {
  const kit = Object.fromEntries(['Btn', 'Card', 'CardTitle', 'Badge', 'PageHeader', 'EmptyState', 'ErrorNotice', 'Select'].map((name) => [name, () => null]))
  for (const state of [readyState({ saveError: 'x' }), { ...initialSetup, phase: 'error', saveError: 'x' }, { ...initialSetup, phase: 'opening' }]) {
    const tree = renderSetupView(h, state, {}, kit)
    assert.equal(findAll(tree, (n) => /^h[1-6]$/.test(String(n.type))).length, 0)
    assert.equal(findAll(tree, (n) => n.type === kit.ErrorNotice).length, 0)
    assert.equal(findAll(tree, (n) => [kit.Card, kit.Badge, kit.Select].includes(n.type)).length, 0)
  }
})
