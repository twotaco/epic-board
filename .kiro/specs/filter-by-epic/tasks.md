# Implementation Plan

## Overview

The work is two task groups. Each group is one pull request on its own branch, named `story/filter-by-epic-g1` and `story/filter-by-epic-g2`, cut from the latest main after the previous group's pull request is merged. Each group lands green on its own and leaves the app working. Every group ends with a sub-task that runs the tests and reports the counts run, passed and skipped. Tick each task in this file in the same branch, and tick nothing in the earlier specs. The backend does not change and neither `app.json` nor any dependency is touched.

Start this story after the "Start a story" story has landed on main, because the groups change files that story created or changed (`ui/index.mjs`, `tests/ui/render.test.mjs`, `tests/ui/board.test.mjs`).

Group 1 is the page's logic, including saving and restoring the choice, with no change to what the page draws. Group 2 draws the dropdown, wires it and the saved choice into the page, and checks the whole.

## Tasks

- [ ] 1. Page logic: options, filter and view
  - [ ] 1.1 Add `filterOptions` and `filterPlan` to `ui/index.mjs`
    - Export both, as the design says. `filterPlan` never mutates its argument and returns the plan itself for `all` or for a key no group has
    - Group keys are computed as `columnsOf` computes them, in one shared helper so the two cannot drift apart
    - Do not change `columnsOf`, `progressOf` or any chat function
    - _Requirements: 1.2, 1.3, 2.1, 2.2, 2.6_
  - [ ] 1.2 Give `viewOf` a second parameter `filterKey = 'all'`
    - A `plan` view gains `filter: {key, options}` and builds `columns` from `filterPlan`; `empty`, `problems` and `failedFetch` come from the whole plan
    - A stored key that is not among the options gives the effective key `all`
    - Check that every existing call of `viewOf` and every existing test passes unchanged
    - _Requirements: 1.4, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3_
  - [ ] 1.3 Add `loadChoice` and `saveChoice` to `ui/index.mjs`
    - Export `FILTER_STORAGE_KEY` (`'epic-board.filter'`), `loadChoice(storage)` and `saveChoice(storage, key)` as the design says: neither throws, neither reads `window`, a missing storage, a throwing call or a non-text value gives `all` on a read and `false` on a write
    - _Requirements: 3.5, 3.6, 3.8_
  - [ ] 1.4 Write `tests/ui/filter.test.mjs`
    - Cases for `filterOptions`: order, a group with no card skipped, "No epic" last, two epics with one name, no groups
    - Cases for `filterPlan`: `all`, one epic, "No epic", an unknown key, no mutation, card `id`s and chat-relevant fields kept, a spec under two epics appearing once
    - Cases for `viewOf`: counts per column under a filter, a column with no card, the key falling back to `all`, `empty` ignoring the filter, problems and notices not filtered
    - One `forSeeds` property: for random plans and keys, the filtered cards are exactly the chosen group's cards and `all` equals the unfiltered columns
    - Storage tests with a fake storage and a throwing one: `save: saveChoice writes the key under epic-board.filter`, `save: all is saved too`, `save: a throwing setItem does not throw`, `restore: loadChoice returns the saved key`, `restore: nothing saved gives all`, `restore: no storage gives all`, `restore: a throwing getItem gives all`, `restore: a non-text value gives all`, `fallback: a saved epic missing from the plan shows all epics and resets the Saved_Choice`
    - _Requirements: 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.2, 3.5, 3.6, 3.7, 3.8_
  - [ ] 1.5 Run the tests and report the counts
    - Run `python3 -m unittest discover -s tests -t .` and report run, passed and skipped. `tests/test_ui.py` runs the page tests with Node; report it as skipped when Node is missing, not as a pass
    - _Requirements: 4.3_

- [ ] 2. Page: the dropdown, the state and the check
  - [ ] 2.1 Draw the dropdown in `ui/index.mjs`
    - Add `renderFilter` and call it from `renderPlanView` directly after the header, when the plan is not empty; add `filter` to `NO_ACTIONS` and a few `.eb-filter` lines to `STYLE`
    - The label is "Epic", tied to the `select` by `htmlFor` and `id`; plan text is passed as children only
    - Extend `tests/ui/render.test.mjs`: the label, the first option, the selected value, one option per entry, `onChange` calling `actions.filter`, no dropdown while loading, on an error or on the empty board, notices and problems still drawn
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.5_
  - [ ] 2.2 Hold, save and restore the choice in `createBoard`
    - `useState(() => loadChoice(storage))` for the key, with `storage` taken from `env.storage` or `window.localStorage` inside a `try`; pass the key to `viewOf`; give `renderBoard` a `filter` action that sets the key and calls `saveChoice`; an effect for a `plan` view sets the key and the Saved_Choice back to `all` when the view's effective key differs
    - Leave both pollers, the start flow and the resume flow as they are
    - Extend `tests/ui/board.test.mjs` (add `useState` to the fake React in `tests/ui/support.mjs` if it lacks one, and a fake `storage` to `env`): `board: choosing an epic saves it`, `board: a saved epic is restored on load`, `board: a missing saved epic falls back to all epics`, a board with a throwing storage still filters in memory, nothing reset before the first plan; choosing an epic shows only its cards; a new plan keeps the choice; a new plan without the epic goes back to all and stays there when the epic returns; a failed plan poll keeps the filter working; a chat poll and a start leave the choice alone
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 4.1, 4.2_
  - [ ] 2.3 Check `app.json` and the backend are untouched
    - Run `git diff origin/main --stat` and confirm no file under `backend/`, no `app.json` and no `config.json` changed, and that the existing `app.json` test still shows no `storage` permission
    - _Requirements: 4.1, 4.2_
  - [ ] 2.4 Check it in a browser or on the host
    - Open the board on a project with two epics and a "No epic" group. Choose each option and check the columns, the counts and a card's chat state; wait for a plan refresh and check the choice stays; reload the page and check the choice comes back; remove or rename the saved epic and reload, and check the board shows all epics. Check that `localStorage` works in the host's page. Report what was checked, or that it could not be checked
    - _Requirements: 1.1, 1.3, 2.2, 2.3, 2.4, 3.1, 3.5, 3.6, 3.7_
  - [ ] 2.5 Run the tests and report the counts
    - Run `python3 -m unittest discover -s tests -t .` and report run, passed and skipped, with the page tests named separately
    - _Requirements: 4.3_

## Task dependency graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4"] },
    { "id": 3, "tasks": ["1.5"] },
    { "id": 4, "tasks": ["2.1"] },
    { "id": 5, "tasks": ["2.2"] },
    { "id": 6, "tasks": ["2.3", "2.4"] },
    { "id": 7, "tasks": ["2.5"] }
  ]
}
```
