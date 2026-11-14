// Property 1: At most one chat is open, and it is always one the page started.
// Validates: Requirements 1.3, 1.4, 2.1, 2.2, 2.3, 2.6
//
// Property 2: The mark, the Panel and the chat agree.
// Validates: Requirements 1.2, 1.5, 2.4, 2.5, 3.5
//
// Also covers isChatPanel, isPlainClick, panelViewOf and the open-chat and close-chat actions.
import test from 'node:test'
import assert from 'node:assert/strict'

import {
  cardViewOf, initialChats, initialUi, isChatPanel, isPlainClick, panelViewOf, renderBoard, renderPanel, renderShell, uiReduce, viewOf,
} from '../../ui/index.mjs'
import { findAll, forSeeds, h, textOf } from './support.mjs'

const view = { columns: [{ key: 'planned', groups: [{ key: 'e.md', cards: [{ id: 'e.md#A', name: 'Story A' }] }] }] }

test('isChatPanel accepts what React can mount and nothing else', () => {
  assert.equal(isChatPanel(() => null), true)
  assert.equal(isChatPanel({ $$typeof: Symbol.for('react.memo'), type: () => null }), true)
  for (const value of [null, undefined, 'ChatPanel', 3, {}, { render: () => null }]) assert.equal(isChatPanel(value), false)
})

test('isPlainClick is the primary button with no modifier and not handled', () => {
  assert.equal(isPlainClick({ button: 0 }), true)
  for (const mod of ['ctrlKey', 'metaKey', 'shiftKey', 'altKey', 'defaultPrevented']) assert.equal(isPlainClick({ button: 0, [mod]: true }), false, mod)
  for (const button of [1, 2]) assert.equal(isPlainClick({ button }), false, `button ${button}`)
})

test('panelViewOf names the card, falls back to Chat, and is null without a panel or an open chat', () => {
  const ui = { open: { cardId: 'e.md#A', key: 'k1' } }
  assert.deepEqual(panelViewOf(view, ui, true), { cardId: 'e.md#A', key: 'k1', title: 'Story A' })
  assert.deepEqual(panelViewOf(view, { open: { cardId: 'gone', key: 'k2' } }, true), { cardId: 'gone', key: 'k2', title: 'Chat' })
  assert.deepEqual(panelViewOf({ columns: null }, ui, true).title, 'Chat')
  assert.equal(panelViewOf(view, ui, false), null)
  assert.equal(panelViewOf(view, initialUi, true), null)
})

test('open-chat sets the pair, keeps the same state for the same key and switches for another', () => {
  const one = uiReduce(initialUi, { kind: 'open-chat', cardId: 'a', key: 'k1' })
  assert.deepEqual(one.open, { cardId: 'a', key: 'k1' })
  assert.equal(uiReduce(one, { kind: 'open-chat', cardId: 'a', key: 'k1' }), one)
  assert.deepEqual(uiReduce(one, { kind: 'open-chat', cardId: 'b', key: 'k2' }).open, { cardId: 'b', key: 'k2' })
})

test('close-chat closes, honours the key guard and asks for focus only when told to', () => {
  const one = uiReduce(initialUi, { kind: 'open-chat', cardId: 'a', key: 'k1' })
  assert.equal(uiReduce(one, { kind: 'close-chat', key: 'other' }), one)
  assert.deepEqual(uiReduce(one, { kind: 'close-chat', key: 'k1' }), { ...initialUi, open: null })
  const focused = uiReduce(one, { kind: 'close-chat', focus: true })
  assert.deepEqual([focused.open, focused.focus], [null, { cardId: 'a' }])
  assert.equal(uiReduce(initialUi, { kind: 'close-chat', focus: true }), initialUi)
})

test('Property 1: at most one chat is open, and it is the last one opened and still started', () => {
  forSeeds('one open chat', 150, (r) => {
    const cards = ['a', 'b', 'c'].map((id) => ({ id, status: 'planned' }))
    let records = []
    let ui = initialUi
    let expected = null
    for (let step = r.int(1, 30); step > 0; step -= 1) {
      const card = r.pick(cards)
      const key = `k-${card.id}`
      switch (r.int(0, 4)) {
        case 0: // the page opens a chat only for a record it holds
          if (records.some((x) => x.key === key)) {
            ui = uiReduce(ui, { kind: 'open-chat', cardId: card.id, key })
            expected = { cardId: card.id, key }
          }
          break
        case 1: {
          const keyed = r.bool()
          ui = uiReduce(ui, keyed ? { kind: 'close-chat', key, focus: r.bool() } : { kind: 'close-chat', focus: r.bool() })
          if (!keyed || expected?.key === key) expected = null
          break
        }
        case 2:
          if (!records.some((x) => x.key === key)) records = [...records, { key, card_id: card.id, name: key }]
          break
        case 3: // a record goes away (a start again): the page closes that chat by key
          records = records.filter((x) => x.key !== key)
          ui = uiReduce(ui, { kind: 'close-chat', key })
          if (expected?.key === key) expected = null
          break
        default: // a read that drops records, or fails: nothing touches `open`
          records = r.bool() ? [] : records
          break
      }
      assert.deepEqual(ui.open, expected)
      const chats = { ...initialChats, records, byKey: Object.fromEntries(records.map((x) => [x.key, { state: 'idle' }])) }
      const marked = cards.filter((c) => cardViewOf(c, chats, ui, 0).open === true)
      assert.ok(marked.length <= 1)
      if (marked.length === 1) assert.equal(ui.open.cardId, marked[0].id)
      assert.equal(panelViewOf({ columns: [] }, ui, true) === null, ui.open === null)
    }
  })
})

test('Property 2: the mark, the Panel and the chat agree', () => {
  const Chat = () => null
  forSeeds('mark, panel and chat agree', 150, (r) => {
    const ids = ['a', 'b', 'c', 'd'].slice(0, r.int(1, 4))
    const cards = ids.map((id) => ({ id, name: `Card ${id}`, description: '', status: r.pick(['planned', 'in progress', 'done']), spec: null, tasks: null }))
    const plan = { branch: 'main', commit: 'abc', age_seconds: 1, fetch: { ok: true }, problems: [], groups: [{ epic: { file: 'e.md', name: 'E' }, cards }] }
    const state = { content: { type: 'plan', plan }, unreachable: false }
    const records = ids.filter(() => r.bool(0.6)).map((id) => ({ card_id: id, name: `k-${id}`, key: `k-${id}`, created: 't' }))
    const chats = { ...initialChats, records, byKey: Object.fromEntries(records.map((x) => [x.key, { state: r.pick(['idle', 'working', 'needs-you', 'missing']) }])), at: 0, loaded: true }
    const target = r.pick(ids)
    const ui = r.bool(0.7) ? { ...initialUi, open: { cardId: target, key: `k-${target}` } } : initialUi
    const hasPanel = r.bool(0.7)
    const view = { ...viewOf(state), chats, ui, panelAvailable: hasPanel }
    const panel = panelViewOf(view, ui, hasPanel)
    const board = renderBoard(h, view, {})
    const tree = renderShell(h, board, panel ? renderPanel(h, panel, h(Chat, { slotKey: panel.key, conversationOnly: true })) : null)

    assert.equal(findAll(tree, (n) => n.type === 'aside').length, panel === null ? 0 : 1)
    const chatEls = findAll(tree, (n) => n.type === Chat)
    assert.equal(chatEls.length, panel === null ? 0 : 1)
    if (panel) assert.deepEqual(chatEls[0].props, { slotKey: panel.key, conversationOnly: true })
    const marked = findAll(tree, (n) => n.type === 'li' && n.props['data-open'] === 'true')
    const words = findAll(tree, (n) => n.props.className === 'eb-chat-open')
    const current = findAll(tree, (n) => n.props['aria-current'] !== undefined)
    // The Open_Card is the card of the open key whenever a Panel shows and the card has a chat to open.
    const expected = panel && cardViewOf(cards.find((c) => c.id === panel.cardId), chats, ui, 0).open === true && chats.byKey[panel.key].state !== 'missing' ? 1 : 0
    assert.deepEqual([marked.length, words.length, current.length], [expected, expected, expected])
    for (const el of words) assert.equal(textOf(el), 'Chat open')
  })
})
