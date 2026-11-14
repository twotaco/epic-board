// Property 1: At most one chat is open, and it is always one the page started.
// Validates: Requirements 1.3, 1.4, 2.1, 2.2, 2.3, 2.6
//
// Also covers isChatPanel, isPlainClick, panelViewOf and the open-chat and close-chat actions.
import test from 'node:test'
import assert from 'node:assert/strict'

import { cardViewOf, initialChats, initialUi, isChatPanel, isPlainClick, panelViewOf, uiReduce } from '../../ui/index.mjs'
import { forSeeds } from './support.mjs'

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
