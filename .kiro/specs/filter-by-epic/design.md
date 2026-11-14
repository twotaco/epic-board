# Design Document

## Overview

This story adds an epic dropdown to the board page. It builds on "Show the board" (`.kiro/specs/show-the-board/`, "the board design") and "Start a story" (`.kiro/specs/start-a-story/`, "the start design"), and does not repeat them. It is a page-only change in `ui/index.mjs`, with new page tests. The backend gains nothing, `app.json` stays as it is, and no dependency is added.

The plan the page reads already holds every group (`plan.groups`, each `{epic, cards}`), so the filter is a function from `(plan, filterKey)` to a smaller plan. The page holds `filterKey` in a `useState`, started from and saved to the browser's `localStorage`. Nothing is sent to the backend or to Crew.

### Why on the page

A filter on the backend would need a query on the `plan` route, a new cache key in the holder and a refetch on every change. The plan is small, the page has it already, and a page filter reacts at once. The price is that the choice is per browser. `localStorage` needs no `app.json` permission (the `storage` permission of the start spec is a different thing and stays undeclared), and it needs no backend route.

## Components

### `filterOptions(plan)`

Returns `[{key: 'all', label: 'All epics'}, ...]`. One entry per group of `plan.groups` that has at least one card, in the plan's order: key `group.epic.file` and label `group.epic.name`, or key `no-epic` and label `No epic` for the group whose `epic` is `null`. Requirement 1.2, 1.3.

### `filterPlan(plan, key)`

Returns the plan itself when `key` is `all`. Otherwise returns `{...plan, groups: plan.groups.filter(sameKey)}` where a group's key is computed as `columnsOf` computes it (`group.epic ? group.epic.file : 'no-epic'`). A key that matches no group returns the plan itself. The function does not mutate its argument. Requirement 2.1, 2.2, 2.6.

The columns are then built by `columnsOf(filtered)`, which keeps the three columns and counts only the cards it is given (Requirement 2.3). Because `filterPlan` only removes whole groups, a card keeps its `id`, so the chat state of a card, which the page finds by `id`, does not change (Requirement 2.4).

### `viewOf(state, filterKey = 'all')`

`viewOf` keeps its current answer and, for a `plan` view, adds:

- `filter`: `{key, options}`, where `options = filterOptions(plan)` and `key` is the effective key (`all` when the stored key is not among the options, Requirement 3.2).
- `columns`: built from `filterPlan(plan, effectiveKey)`.

`empty` stays computed from the whole plan, so an empty plan still shows the empty board and no dropdown (Requirement 1.4). `problems`, `failedFetch` and the other fields are not filtered (Requirement 2.5).

### `renderFilter(h, filter, actions)` and `renderPlanView`

`renderFilter(h, filter, actions, Select)` returns a `div.eb-filter` holding the control. When `Select` is a component it draws Crew's `Select` with `aria-label="Epic"`, `value` the key, `options` (`{value, label}` per entry) and an `onChange` that passes the chosen key to `actions.filter`. Otherwise it draws a native `select` with `aria-label="Epic"`, `value` the key, one `option` per entry and an `onChange` calling `actions.filter(event.target.value)`. Both carry the accessible name "Epic" and neither draws a visible label, so there is no `htmlFor` tie. The `onChange` of the host `Select` is adapted to take either the chosen value or an event (`typeof arg === 'string' ? arg : arg?.target?.value`), because the host's signature was not seen (Open Questions). `renderPlanView` puts it directly after `eb-header`, and only when `view.empty` is false. `renderBoard(h, view, actions, parts = {})` gains a fourth argument whose `Select` goes to `renderFilter`; it defaults to none, so every existing call is unchanged. `NO_ACTIONS` gains `filter: () => {}`. `STYLE` gains a few lines for `.eb-filter`. All text is passed as children, as the board design requires.

### `loadChoice(storage)` and `saveChoice(storage, key)`

`FILTER_STORAGE_KEY = 'epic-board.filter'`. `loadChoice(storage)` returns the saved text, or `'all'` when `storage` is undefined, the read throws, or the value is not a non-empty string. `saveChoice(storage, key)` writes the key and swallows any throw, returning whether it worked. Neither throws, and neither reads `window`: the page passes `env.storage ?? window.localStorage`, looked up inside a `try` (reading `window.localStorage` can itself throw), so importing the module and the tests need no `window`. Requirement 3.5, 3.6, 3.8.

### `hostSelect()`

Next to `hostApiHook`, and read the same way: `hostSelect()` returns `window.__kirocrew_modules?.['@kirocrew/ui']?.Select` when it is a function or an object (a React component), inside a `try` and behind `typeof window !== 'undefined'`, and `null` otherwise. It never throws and needs no `window`. `createBoard` calls `(env.Select !== undefined ? env.Select : hostSelect())` inside the component, as it does for `useAppApi`, and passes the result as `parts.Select`. Tests pass `env.Select` or `parts.Select`, so they need no `window`. Requirement 1.5.

### The page

`createBoard` adds `const [filterKey, setFilterKey] = useState(() => loadChoice(storage))`, so the saved key is read once, on the first render. It calls `viewOf(state, filterKey)` and gives `renderBoard` the action `filter: (key) => { setFilterKey(key); saveChoice(storage, key) }`. An effect runs when `viewOf` reports an effective key different from the stored one, and only for a `plan` view: it sets the key and the Saved_Choice back to `all` (Requirements 3.2, 3.7). Because `viewOf` gives a plan view only once a plan has arrived, a saved epic is not judged before then. If a write fails, the choice still holds in `filterKey` for the visit (Requirement 3.8). The pollers, the start flow and the resume flow do not touch `filterKey` (Requirement 3.4). `useState` comes from the same `React` object as `useReducer`; the test fakes in `tests/ui/support.mjs` get a `useState` if they lack one.

## Edge cases

| Case | Result |
| --- | --- |
| Chosen epic has no card in a column | The column stays, with count 0 and its usual empty look |
| Chosen epic's file disappears on the next poll | Board shows all epics, dropdown shows "All epics", state and Saved_Choice reset |
| Saved epic is not in the first plan | Board shows all epics and the Saved_Choice is set to `all` |
| `localStorage` missing or throwing | Starts on `all`; the choice holds in memory for the visit; no error shown |
| Saved value is not a known key | Treated as a missing epic: all epics, Saved_Choice reset |
| Two epics share a name | Two options with the same label and different keys; each picks its own group |
| Only the "No epic" group has cards | The dropdown has "All epics" and "No epic" |
| Plan poller fails after a first plan | Filter keeps working on the last plan |
| A story is started under a filter | The card shows its chat state as before; the filter is unchanged |

## Testing

Page tests (Node's test runner, `tests/ui/*.test.mjs`):

- `tests/ui/filter.test.mjs` (new): `filterOptions` (order, skipping empty groups, "No epic" last, same-name epics); `filterPlan` (`all` returns the same plan, one group, unknown key, no mutation, card `id`s kept); `columnsOf(filterPlan(...))` counts; `viewOf` effective key falls back to `all` and `empty` ignores the filter; a property test with `forSeeds` over random plans: the filtered cards are exactly the cards of the chosen group, and `all` equals the unfiltered columns.
- `tests/ui/filter.test.mjs` also holds the storage tests, with a fake storage object (a `Map` behind `getItem` and `setItem`) and one that throws:
  - `save: saveChoice writes the key under epic-board.filter`, `save: all is saved too`, `save: a throwing setItem does not throw`
  - `restore: loadChoice returns the saved key`, `restore: nothing saved gives all`, `restore: no storage gives all`, `restore: a throwing getItem gives all`, `restore: a non-text value gives all`
  - `fallback: a saved epic missing from the plan shows all epics and resets the Saved_Choice`
- `tests/ui/render.test.mjs` (extended): `render: host Select used when present` (given a fake `Select`, it is the element drawn, with the key as `value`, "All epics" first, one option per entry, and its `onChange` calls `actions.filter` with the key, given a string or an event), `render: native select when the ui module is missing`, `render: native select when Select is missing from the module`, `render: aria-label Epic on the host Select`, `render: aria-label Epic on the native select`, and for the native one the selected value and an `onChange` that calls `actions.filter` with the value; `hostSelect` tests (`host: hostSelect finds Select`, `host: hostSelect gives null with no window`, `host: hostSelect gives null when the lookup throws`); it is not drawn while loading, on an error or on the empty board; the problems list and notices stay under a filter.
- `tests/ui/board.test.mjs` (extended): with the fake React and a fake `storage` in `env`, choosing an epic shows only its cards and saves its key (`board: choosing an epic saves it`); a board built with a saved key starts on that epic, with no write (`board: a saved epic is restored on load`); a saved epic that the first plan lacks shows all epics and writes `all` (`board: a missing saved epic falls back to all epics`); no board is drawn and nothing is reset before the first plan; a new plan keeps the choice; a new plan without the epic goes back to all and stays there when the epic returns; a failed poll keeps the filter working; a chat poll or a start does not change the choice; a board with a throwing storage still filters in memory.

Python tests: none are added, because the backend does not change. `python3 -m unittest discover -s tests -t .` still runs in full, and `tests/test_ui.py` runs the page tests through Node.

## Open Questions

- The props of Crew's `Select` (`options`, `value`, `onChange`, `aria-label`) were not seen in the Crew source available here. The app-development guide lists the `@kirocrew/ui` components but not `Select`'s props. The design follows the usual shape and adapts `onChange`; the manual check (task 2.4) confirms the control on a real host, and a wrong shape is fixed in `renderFilter` alone, since the native fallback does not depend on it.

- Whether the host's page sandbox allows `localStorage`. The manual check in the last task group reads it on a real host. The page works without it (Requirement 3.8).
