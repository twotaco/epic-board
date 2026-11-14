// Helpers for the page tests. Defines no tests.
// Standard Node only: no dependencies.

const DEFAULT_SEED = 20240601

// A small seeded PRNG (mulberry32).
export function rng(seed) {
  let state = seed >>> 0
  const next = () => {
    state = (state + 0x6d2b79f5) >>> 0
    let t = state
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
  return {
    seed,
    next,
    // An integer from lo to hi, both included.
    int: (lo, hi) => lo + Math.floor(next() * (hi - lo + 1)),
    pick: (array) => array[Math.floor(next() * array.length)],
    bool: (p = 0.5) => next() < p,
  }
}

// The first seed to use: EB_SEED when it is set to a number, else a fixed one.
export function baseSeed() {
  const value = Number(process.env.EB_SEED)
  return process.env.EB_SEED !== undefined && process.env.EB_SEED !== '' && Number.isFinite(value)
    ? value
    : DEFAULT_SEED
}

// Runs fn(rng, seed) once per seed, for `iterations` seeds starting at the base seed.
// A throw is re-thrown naming the property, the seed and the original message,
// so the failure can be replayed with EB_SEED=<seed> and one iteration.
export function forSeeds(name, iterations, fn) {
  const start = baseSeed()
  for (let i = 0; i < iterations; i += 1) {
    const seed = start + i
    try {
      fn(rng(seed), seed)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      const error = new Error(`property "${name}" failed with seed ${seed} (EB_SEED=${seed}): ${message}`)
      error.cause = failure
      throw error
    }
  }
}

// forSeeds for an async fn(rng, seed): runs the seeds one after another and rejects naming the seed.
export async function forSeedsAsync(name, iterations, fn) {
  const start = baseSeed()
  for (let i = 0; i < iterations; i += 1) {
    const seed = start + i
    try {
      await fn(rng(seed), seed)
    } catch (failure) {
      const message = failure instanceof Error ? failure.message : String(failure)
      const error = new Error(`property "${name}" failed with seed ${seed} (EB_SEED=${seed}): ${message}`)
      error.cause = failure
      throw error
    }
  }
}

// An h for inspecting trees: returns {type, props, children}.
// Children are flattened one level, and null, undefined and false are removed.
export function h(type, props, ...children) {
  return {
    type,
    props: props ?? {},
    children: children.flat(1).filter((child) => child !== null && child !== undefined && child !== false),
  }
}

// Calls fn on the node and every node below it, in document order.
// Strings and numbers are passed to fn too.
export function walk(tree, fn) {
  fn(tree)
  if (tree !== null && typeof tree === 'object') {
    for (const child of tree.children ?? []) walk(child, fn)
  }
}

// Every element (not text) in the tree for which predicate is true.
export function findAll(tree, predicate) {
  const found = []
  walk(tree, (node) => {
    if (node !== null && typeof node === 'object' && predicate(node)) found.push(node)
  })
  return found
}

// All the text in the tree, in document order.
export function textOf(tree) {
  let text = ''
  walk(tree, (node) => {
    if (typeof node === 'string' || typeof node === 'number') text += String(node)
  })
  return text
}
