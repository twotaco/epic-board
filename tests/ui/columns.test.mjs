// Property 4: Grouping puts each card in one column.
// Validates: Requirements 2.1, 2.2, 2.6
import test from 'node:test'
import assert from 'node:assert/strict'

import { columnsOf } from '../../ui/index.mjs'
import { forSeeds } from './support.mjs'

const ITERATIONS = 150
const STATUSES = ['planned', 'in progress', 'done']
const COLUMN_TITLES = ['Planned', 'In progress', 'Done']

// A random plan. Epic groups come first, each with its own file; a group with no
// epic may come last, as in the real plan. Some groups are empty, and some stories
// are listed under two epic groups with a status of their own in each.
function randomPlan(r) {
  const epicCount = r.int(0, 5)
  const groups = []
  for (let g = 0; g < epicCount; g += 1) {
    groups.push({ epic: { name: `Epic ${g}`, file: `epic-${g}.md` }, cards: [] })
  }
  if (r.bool(0.6)) groups.push({ epic: null, cards: [] })

  const newCard = (group, status, story) => ({
    id: `${groups.indexOf(group)}:${group.cards.length}`,
    name: `Story ${story}`,
    status,
    spec: r.bool(0.8) ? `spec-${story}` : null,
    tasks: null,
    epic: group.epic ? group.epic.name : null,
    description: '',
  })

  let story = 0
  for (const group of groups) {
    const size = r.bool(0.2) ? 0 : r.int(1, 8)
    for (let i = 0; i < size; i += 1) {
      group.cards.push(newCard(group, r.pick(STATUSES), story))
      story += 1
    }
  }
  // List some stories under a second epic group as well.
  const epicGroups = groups.filter((group) => group.epic)
  if (epicGroups.length >= 2) {
    const copies = r.int(0, 4)
    for (let c = 0; c < copies; c += 1) {
      const from = r.pick(epicGroups)
      if (from.cards.length === 0) continue
      const source = r.pick(from.cards)
      const to = r.pick(epicGroups.filter((group) => group !== from))
      const storyNumber = Number(source.name.slice('Story '.length))
      to.cards.splice(r.int(0, to.cards.length), 0, newCard(to, r.pick(STATUSES), storyNumber))
    }
  }
  // Ids come from the final position, so every card object is told apart.
  groups.forEach((group, g) => group.cards.forEach((card, i) => { card.id = `${g}:${i}` }))
  return { repository: '/x', branch: 'main', groups, problems: [] }
}

// The effective column of a card given the started set.
function effectiveColumn(card, started) {
  return card.status === 'planned' && started.has(card.id) ? 'in progress' : card.status
}

function idsOf(column) {
  return column.groups.flatMap((group) => group.cards.map((card) => card.id))
}

test('Property 4: every card is in the one column of its status (or In progress if started)', () => {
  forSeeds('grouping puts each card in one column', ITERATIONS, (r) => {
    const plan = randomPlan(r)
    // Randomly mark some card ids as started.
    const allIds = plan.groups.flatMap((group) => group.cards.map((card) => card.id))
    const started = new Set(allIds.filter(() => r.bool(0.4)))
    const columns = columnsOf(plan, started)

    // The three columns, in order.
    assert.deepEqual(columns.map((column) => column.title), COLUMN_TITLES)
    assert.deepEqual(columns.map((column) => column.key), STATUSES)

    // Every card (each group's own copy) appears exactly once over all columns,
    // and in the column that matches its effective column.
    const seen = new Map()
    for (const column of columns) {
      for (const id of idsOf(column)) seen.set(id, (seen.get(id) ?? 0) + 1)
      for (const group of column.groups) {
        for (const card of group.cards) {
          assert.equal(effectiveColumn(card, started), column.key, `card ${card.id} in the wrong column`)
        }
      }
    }
    for (const group of plan.groups) {
      for (const card of group.cards) assert.equal(seen.get(card.id), 1, `card ${card.id} appears ${seen.get(card.id) ?? 0} times`)
    }
    const total = plan.groups.reduce((sum, group) => sum + group.cards.length, 0)
    assert.equal(seen.size, total)
    assert.equal(columns.reduce((sum, column) => sum + idsOf(column).length, 0), total)

    // A card in two epic groups appears once under each group.
    const names = new Map()
    for (const group of plan.groups) {
      for (const card of group.cards) names.set(card.name, (names.get(card.name) ?? 0) + 1)
    }
    for (const [name, times] of names) {
      const shown = columns.flatMap((column) => column.groups.flatMap((group) => group.cards)).filter((card) => card.name === name)
      assert.equal(shown.length, times, `${name} shown ${shown.length} times, listed ${times} times`)
    }
  })
})

test('Property 4: counts, order, and no empty group', () => {
  forSeeds('count, order and empty groups', ITERATIONS, (r) => {
    const plan = randomPlan(r)
    const allIds = plan.groups.flatMap((group) => group.cards.map((card) => card.id))
    const started = new Set(allIds.filter(() => r.bool(0.4)))
    const columns = columnsOf(plan, started)

    for (const column of columns) {
      // count equals the number of cards in the column's groups
      assert.equal(column.count, column.groups.reduce((sum, group) => sum + group.cards.length, 0))

      // no group is empty
      for (const group of column.groups) assert.ok(group.cards.length > 0, 'a group has no cards')

      // groups and cards keep the plan's order: the expected column is built from the plan directly
      const expected = []
      plan.groups.forEach((group, g) => {
        const ids = group.cards
          .filter((card) => effectiveColumn(card, started) === column.key)
          .map((card) => card.id)
        if (ids.length > 0) expected.push({ g, ids })
      })
      assert.equal(column.groups.length, expected.length)
      column.groups.forEach((group, i) => {
        assert.deepEqual(group.cards.map((card) => card.id), expected[i].ids)
        const source = plan.groups[expected[i].g]
        if (source.epic) {
          assert.equal(group.name, source.epic.name)
          assert.equal(group.key, source.epic.file)
        } else {
          // The group with no epic: name null (the renderer words it "No epic") and its own key.
          assert.ok(group.name === null || group.name === 'No epic', `no-epic group named ${group.name}`)
          assert.equal(group.key, 'no-epic')
        }
      })

      // "No epic" is last in each column where it appears, and appears at most once
      const noEpic = column.groups.map((group, i) => (group.key === 'no-epic' ? i : -1)).filter((i) => i >= 0)
      assert.ok(noEpic.length <= 1)
      if (noEpic.length === 1) assert.equal(noEpic[0], column.groups.length - 1)
    }
  })
})

test('a column with no cards has count 0 and no groups ("Nothing here")', () => {
  const plan = {
    groups: [
      { epic: { name: 'Epic Board', file: 'epic-board.md' }, cards: [{ name: 'A', status: 'planned' }, { name: 'B', status: 'done' }] },
      { epic: null, cards: [{ name: 'C', status: 'planned' }] },
    ],
  }
  const [planned, inProgress, done] = columnsOf(plan)
  assert.equal(inProgress.title, 'In progress')
  assert.equal(inProgress.count, 0)
  assert.deepEqual(inProgress.groups, [])
  assert.equal(planned.count, 2)
  assert.deepEqual(planned.groups.map((group) => group.cards.map((card) => card.name)), [['A'], ['C']])
  assert.equal(done.count, 1)
})

test('an empty plan gives three empty columns', () => {
  const columns = columnsOf({ groups: [] })
  assert.deepEqual(columns.map((column) => column.title), COLUMN_TITLES)
  for (const column of columns) {
    assert.equal(column.count, 0)
    assert.deepEqual(column.groups, [])
  }
})

test('a plan whose only group has no cards gives three empty columns', () => {
  const columns = columnsOf({ groups: [{ epic: { name: 'Empty', file: 'empty.md' }, cards: [] }] })
  assert.equal(columns.length, 3)
  for (const column of columns) {
    assert.equal(column.count, 0)
    assert.deepEqual(column.groups, [])
  }
})

test('a card in two epic groups appears once under each, in its own status column', () => {
  const plan = {
    groups: [
      { epic: { name: 'One', file: 'one.md' }, cards: [{ name: 'Shared', status: 'planned' }] },
      { epic: { name: 'Two', file: 'two.md' }, cards: [{ name: 'Shared', status: 'done' }] },
    ],
  }
  const [planned, inProgress, done] = columnsOf(plan)
  assert.deepEqual(planned.groups.map((group) => group.name), ['One'])
  assert.deepEqual(done.groups.map((group) => group.name), ['Two'])
  assert.equal(inProgress.count, 0)
  assert.equal(planned.count + done.count, 2)
})

test('a planned started card is in In progress and counts there', () => {
  const plan = {
    groups: [
      { epic: { name: 'Epic', file: 'epic.md' }, cards: [
        { id: 'a', name: 'A', status: 'planned' },
        { id: 'b', name: 'B', status: 'planned' },
      ] },
    ],
  }
  const started = new Set(['a'])
  const [planned, inProgress, done] = columnsOf(plan, started)
  assert.equal(planned.count, 1)
  assert.equal(inProgress.count, 1)
  assert.equal(done.count, 0)
  assert.deepEqual(planned.groups[0].cards.map((card) => card.id), ['b'])
  assert.deepEqual(inProgress.groups[0].cards.map((card) => card.id), ['a'])
})

test('an in-progress card stays in In progress regardless of started', () => {
  const plan = {
    groups: [
      { epic: null, cards: [{ id: 'x', name: 'X', status: 'in progress' }] },
    ],
  }
  const started = new Set(['x'])
  const [, inProgress] = columnsOf(plan, started)
  assert.equal(inProgress.count, 1)
  assert.deepEqual(inProgress.groups[0].cards.map((c) => c.id), ['x'])
})

test('a done card stays in Done regardless of started', () => {
  const plan = {
    groups: [
      { epic: null, cards: [{ id: 'y', name: 'Y', status: 'done' }] },
    ],
  }
  const started = new Set(['y'])
  const [, , done] = columnsOf(plan, started)
  assert.equal(done.count, 1)
})

test('removing a started record returns a card to Planned', () => {
  const plan = {
    groups: [
      { epic: null, cards: [{ id: 'z', name: 'Z', status: 'planned' }] },
    ],
  }
  // With the record: card is in In progress.
  const [, inProgress1] = columnsOf(plan, new Set(['z']))
  assert.equal(inProgress1.count, 1)
  // Record removed: card goes back to Planned.
  const [planned2] = columnsOf(plan, new Set())
  assert.equal(planned2.count, 1)
})
