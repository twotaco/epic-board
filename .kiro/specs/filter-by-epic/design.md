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

- `filter`: `{key, options, show}`, where `options = filterOptions(plan)`, `key` is the effective key (`all` when the stored key is not among the options, Requirement 3.2) and `show` is `!empty && options.length >= 3` (Requirements 1.1, 1.4, 1.6).

The single-epic edge is settled here. With one option besides "All epics" the dropdown is hidden. The effective key is still worked out as above, so a saved key that is that one epic stays saved and gives the board of that one group, which equals the board for `all`. A saved key that is not among the options is reset to `all` as before. Nothing else is reset, so when a second epic appears the dropdown returns with the saved choice in place (Requirement 1.7).
- `columns`: built from `filterPlan(plan, effectiveKey)`.

`empty` stays computed from the whole plan, so an empty plan still shows the empty board and no dropdown (Requirement 1.4). `problems`, `failedFetch` and the other fields are not filtered (Requirement 2.5).

### `renderFilter(h, filter, actions)` and `renderPlanView`

`renderFilter` returns a `div.eb-filter` holding a `label` (`htmlFor="eb-epic-filter"`, text "Epic") and a `select` (`id="eb-epic-filter"`, `value` the key, `onChange` calling `actions.filter(event.target.value)`) with one `option` per entry. `renderPlanView` puts it directly after `eb-header`, and only when `view.filter.show` is true (`view.empty` is false and `options.length >= 3`, that is "All epics" and at least two more). `NO_ACTIONS` gains `filter: () => {}`. `STYLE` gains a few lines for `.eb-filter`. All text is passed as children, as the board design requires.

### `loadChoice(storage)` and `saveChoice(storage, key)`

`FILTER_STORAGE_KEY = 'epic-board.filter'`. `loadChoice(storage)` returns the saved text, or `'all'` when `storage` is undefined, the read throws, or the value is not a non-empty string. `saveChoice(storage, key)` writes the key and swallows any throw, returning whether it worked. Neither throws, and neither reads `window`: the page passes `env.storage ?? window.localStorage`, looked up inside a `try` (reading `window.localStorage` can itself throw), so importing the module and the tests need no `window`. Requirement 3.5, 3.6, 3.8.

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
| Only one group has cards (one epic, or only "No epic") | No dropdown; the board shows that group |
| One group has cards and the saved key is that group | No dropdown; same board as `all`; Saved_Choice kept |
| One group has cards and the saved key is another epic | No dropdown; all epics shown; Saved_Choice reset to `all` |
| A second epic gains cards while the first is saved | Dropdown appears, showing the first epic |
| Two epics, or one epic plus "No epic" | Dropdown with three options |
| Plan poller fails after a first plan | Filter keeps working on the last plan |
| A story is started under a filter | The card shows its chat state as before; the filter is unchanged |

## Testing

Page tests (Node's test runner, `tests/ui/*.test.mjs`):

- `tests/ui/filter.test.mjs` (new): `filterOptions` (order, skipping empty groups, "No epic" last, same-name epics); `filterPlan` (`all` returns the same plan, one group, unknown key, no mutation, card `id`s kept); `columnsOf(filterPlan(...))` counts; `viewOf` effective key falls back to `all` and `empty` ignores the filter; a property test with `forSeeds` over random plans: the filtered cards are exactly the cards of the chosen group, and `all` equals the unfiltered columns.
- `tests/ui/filter.test.mjs` also tests `filter.show` (`view: filter.show is false with one epic`, `view: filter.show is true with two epics`, `view: filter.show is false on the empty plan`) and holds the storage tests, with a fake storage object (a `Map` behind `getItem` and `setItem`) and one that throws:
  - `save: saveChoice writes the key under epic-board.filter`, `save: all is saved too`, `save: a throwing setItem does not throw`
  - `restore: loadChoice returns the saved key`, `restore: nothing saved gives all`, `restore: no storage gives all`, `restore: a throwing getItem gives all`, `restore: a non-text value gives all`
  - `fallback: a saved epic missing from the plan shows all epics and resets the Saved_Choice`
- `tests/ui/render.test.mjs` (extended): the dropdown is drawn with a label tied to the select, "All epics" first, selected value, one option per entry, an `onChange` that calls `actions.filter` with the value; `render: dropdown hidden with one epic`, `render: dropdown hidden with only the No epic group`, `render: dropdown shown with two or more`; it is not drawn while loading, on an error or on the empty board; the problems list and notices stay under a filter.
- `tests/ui/board.test.mjs` (extended): with the fake React and a fake `storage` in `env`, choosing an epic shows only its cards and saves its key (`board: choosing an epic saves it`); a board built with a saved key starts on that epic, with no write (`board: a saved epic is restored on load`); a saved epic that the first plan lacks shows all epics and writes `all` (`board: a missing saved epic falls back to all epics`); no board is drawn and nothing is reset before the first plan; a new plan keeps the choice; a new plan without the epic goes back to all and stays there when the epic returns; a failed poll keeps the filter working; a chat poll or a start does not change the choice; a board with a throwing storage still filters in memory; `board: no dropdown and a kept saved choice with a single epic`, `board: a saved choice that is not the single epic is reset`, `board: the dropdown appears with the saved choice when a second epic arrives`.

Python tests: none are added, because the backend does not change. `python3 -m unittest discover -s tests -t .` still runs in full, and `tests/test_ui.py` runs the page tests through Node.

## Open Questions

- Whether the host's page sandbox allows `localStorage`. The manual check in the last task group reads it on a real host. The page works without it (Requirement 3.8).
