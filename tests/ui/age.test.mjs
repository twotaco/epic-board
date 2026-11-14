// Property 6: Age wording follows the age.
// Validates: Requirements 8.2
import test from 'node:test'
import assert from 'node:assert/strict'

import { ageText } from '../../ui/index.mjs'
import { forSeeds } from './support.mjs'

const UNIT_SECONDS = { minute: 60, hour: 3600, day: 86400 }
const RANK = { 'less than a minute': 0, minute: 1, hour: 2, day: 3 }

// Reads the unit and N out of the wording. Fails the test when the text has another shape.
function parse(text) {
  if (text === 'Updated less than a minute ago') return { unit: 'less than a minute', n: null, plural: false }
  const match = /^Updated (\d+) (minute|hour|day)(s?) ago$/.exec(text)
  assert.ok(match, `unexpected wording: ${JSON.stringify(text)}`)
  return { unit: match[2], n: Number(match[1]), plural: match[3] === 's' }
}

// An integer age from one of the four ranges, sometimes exactly on a range edge.
function anAge(r) {
  const ranges = [
    [0, 59],
    [60, 3599],
    [3600, 86399],
    [86400, 86400 * 4000], // days up to about eleven years
  ]
  const [lo, hi] = r.pick(ranges)
  if (r.bool(0.15)) return r.pick([lo, hi])
  return r.int(lo, hi)
}

test('Property 6: N is the age divided by the unit, rounded down; singular exactly when N is 1', () => {
  forSeeds('age wording follows the age', 200, (r) => {
    const age = anAge(r)
    const { unit, n, plural } = parse(ageText(age))
    if (age < 60) {
      assert.equal(unit, 'less than a minute', `age ${age}`)
      return
    }
    const expectedUnit = age < 3600 ? 'minute' : age < 86400 ? 'hour' : 'day'
    assert.equal(unit, expectedUnit, `age ${age}`)
    assert.equal(n, Math.floor(age / UNIT_SECONDS[unit]), `age ${age}`)
    assert.ok(n >= 1, `age ${age}`)
    assert.equal(plural, n !== 1, `age ${age}: ${n} ${unit}`)
  })
})

test('Property 6: for two ages, the larger never gets a smaller unit', () => {
  forSeeds('age unit is monotonic', 200, (r) => {
    const a = anAge(r)
    const b = anAge(r)
    const [small, large] = a <= b ? [a, b] : [b, a]
    const smallUnit = parse(ageText(small)).unit
    const largeUnit = parse(ageText(large)).unit
    assert.ok(
      RANK[largeUnit] >= RANK[smallUnit],
      `age ${small} gave "${smallUnit}" but the larger age ${large} gave "${largeUnit}"`,
    )
  })
})

test('Examples: exact wording', () => {
  const cases = [
    [null, 'Not yet updated from origin'],
    [undefined, 'Not yet updated from origin'],
    [0, 'Updated less than a minute ago'],
    [59, 'Updated less than a minute ago'],
    [60, 'Updated 1 minute ago'],
    [119, 'Updated 1 minute ago'],
    [120, 'Updated 2 minutes ago'],
    [3599, 'Updated 59 minutes ago'],
    [3600, 'Updated 1 hour ago'],
    [86399, 'Updated 23 hours ago'],
    [86400, 'Updated 1 day ago'],
    [172800, 'Updated 2 days ago'],
  ]
  for (const [age, text] of cases) {
    assert.equal(ageText(age), text, `age ${age}`)
  }
})
