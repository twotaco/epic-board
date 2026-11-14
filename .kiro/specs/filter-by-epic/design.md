# Design Document

## Overview

This story adds an epic dropdown to the board page. It builds on "Show the board" (`.kiro/specs/show-the-board/`, "the board design") and "Start a story" (`.kiro/specs/start-a-story/`, "the start design"), and does not repeat them. It is a page-only change in `ui/index.mjs`, with new page tests. The backend gains nothing, `app.json` stays as it is, and no dependency is added.

The plan the page reads already holds every group (`plan.groups`, each `{epic, cards}`), so the filter is a function from `(plan, filterKey)` to a smaller plan. The page holds `filterKey` in a `useState`. Nothing is sent to the backend or to Crew.

### Why on the page

A filter on the backend would need a query on the `plan` route, a new cache key in the holder and a refetch on every change. The plan is small, the page has it already, and a page filter reacts at once. The price is that the choice is lost on reload (Open Question in the requirements).

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

`renderFilter` returns a `div.eb-filter` holding a `label` (`htmlFor="eb-epic-filter"`, text "Epic") and a `select` (`id="eb-epic-filter"`, `value` the key, `onChange` calling `actions.filter(event.target.value)`) with one `option` per entry. `renderPlanView` puts it directly after `eb-header`, and only when `view.empty` is false. `NO_ACTIONS` gains `filter: () => {}`. `STYLE` gains a few lines for `.eb-filter`. All text is passed as children, as the board design requires.

### The page

`createBoard` adds `const [filterKey, setFilterKey] = useState('all')`. It calls `viewOf(state, filterKey)` and gives `renderBoard` the action `filter: setFilterKey`. When `viewOf` reports an effective key different from the stored one, an effect sets the stored key back to `all` (Requirement 3.2). The pollers, the start flow and the resume flow do not touch `filterKey` (Requirement 3.4). `useState` comes from the same `React` object as `useReducer`; the test fakes in `tests/ui/support.mjs` get a `useState` if they lack one.

## Edge cases

| Case | Result |
| --- | --- |
| Chosen epic has no card in a column | The column stays, with count 0 and its usual empty look |
| Chosen epic's file disappears on the next poll | Board shows all epics, dropdown shows "All epics", stored key reset |
| Two epics share a name | Two options with the same label and different keys; each picks its own group |
| Only the "No epic" group has cards | The dropdown has "All epics" and "No epic" |
| Plan poller fails after a first plan | Filter keeps working on the last plan |
| A story is started under a filter | The card shows its chat state as before; the filter is unchanged |

## Testing

Page tests (Node's test runner, `tests/ui/*.test.mjs`):

- `tests/ui/filter.test.mjs` (new): `filterOptions` (order, skipping empty groups, "No epic" last, same-name epics); `filterPlan` (`all` returns the same plan, one group, unknown key, no mutation, card `id`s kept); `columnsOf(filterPlan(...))` counts; `viewOf` effective key falls back to `all` and `empty` ignores the filter; a property test with `forSeeds` over random plans: the filtered cards are exactly the cards of the chosen group, and `all` equals the unfiltered columns.
- `tests/ui/render.test.mjs` (extended): the dropdown is drawn with a label tied to the select, "All epics" first, selected value, one option per entry, an `onChange` that calls `actions.filter` with the value; it is not drawn while loading, on an error or on the empty board; the problems list and notices stay under a filter.
- `tests/ui/board.test.mjs` (extended): with the fake React, choosing an epic shows only its cards; a new plan keeps the choice; a new plan without the epic goes back to all; a failed poll keeps the filter working; a chat poll or a start does not change the choice.

Python tests: none are added, because the backend does not change. `python3 -m unittest discover -s tests -t .` still runs in full, and `tests/test_ui.py` runs the page tests through Node.

## Open Questions

- Whether the choice should survive a reload, and where (address bar or the host's storage). Left out on purpose (requirements, Open Questions).
