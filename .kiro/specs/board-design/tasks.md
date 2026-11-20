# Implementation Plan

## Overview

The work is four task groups. Each group is one pull request on its own branch, named `story/board-design-g1` to `story/board-design-g4`, cut from the latest main after the previous group's pull request is merged. Each group lands green on its own and leaves the app working. Every group ends with a sub-task that runs the tests and reports the counts run, passed and skipped. Tick each task in this file in the same branch, and tick nothing in the earlier specs. The page adds no dependency, and the backend does not change.

Start this story after "Work in the chat" (`.kiro/specs/work-in-the-chat/`) has been built and has landed on main, because both change the card's markup and the panel's button and mark, and this story's tasks are written against the code that story leaves.

Group 1 is the kit lookup and the fallback marker, with no change to what the page draws. Group 2 draws the header, the column headers and the empty and error states, and with them the filter row, the header's "Projects" button and the first-run notice. Group 3 draws the cards, the badges and the buttons, and with them the Projects panel and the look of the panel for the chat and the Projects view alike. Group 4 checks the whole on a Crew host, which is the only place the look, the tokens and the themes can be confirmed.

The projects parts (Requirement 6) are written against the code that "Switch projects" and "Set up projects" left on main: `renderProjects`, `renderFilters`, `renderSetupView`, `renderPanel`, the `eb-notice` markup and the `data-eb-setup-btn` button. Where a task names a function, read it first: if a name has changed, use the new name and keep the behaviour.

## Tasks

- [x] 1. Page: the kit, the fallback marker and the style sheet
  - [x] 1.1 Add the lookup to `ui/index.mjs`
    - `isComponent(value)`, `pickKit(module)` and `hostKit()` as the design gives them; make `isChatPanel` of the chat story and the lookup of `Select` of the Filter by epic story go through `isComponent` and `hostKit`, so there is one test and one reading of the module, with the rule of the Filter by epic spec unchanged
    - `renderBoard(h, view, actions, kit = {})` takes the kit and passes it down to the functions that draw a part; with an empty kit the tree is what it is today
    - `createBoard` reads `env.kit ?? hostKit()` on every render and passes it to `renderBoard`; it also looks up `window.__kirocrew_modules['lucide-react']?.Kanban` and passes the icon in the view
    - Nothing else in the file changes
    - _Requirements: 1.1, 1.2, 1.3, 1.5_
  - [x] 1.2 Mark the fallbacks and rewrite `STYLE`
    - Give every element the fallback draws the class `eb-fb`, and move every `rgba(128, 128, 128, a)` rule under `.eb-fb`
    - Rewrite the rest of `STYLE` as the design's table says, with `currentColor` or `var(--token, currentColor)` for colours, the sizes of the table and no others, `.eb-card` `position: relative`, `margin-bottom: 0` on a card in the list, the description's three-line cut, and the body's gutter
    - Keep the `@container (min-width: 720px)` rule and the `@supports not` copy, and the panel rules of the chat story, with the two changes of "Edits"
    - The projects parts, with the rows of the design's table: split `.eb-notice` from `.eb-error` (the fallback keeps today's `.eb-error` look) and give `.eb-notice` the neutral tone and `.eb-notice-error` the error tone; `.eb-filters` and `.eb-filter` as the table gives them; `.eb-setup`, `.eb-folder`, `.eb-folder-label`, `.eb-folder-dir`, `.eb-folder-name` and `.eb-setup-actions`; the directory in the one rule of the meta line
    - _Requirements: 1.3, 2.1, 2.2, 2.3, 2.5, 3.3, 3.4, 3.8, 3.9, 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.3, 6.4, 6.5_
  - [x] 1.3 Check them in `tests/ui/kit.test.mjs` and the existing files
    - `isComponent` for a function, a memo-like object, `null`, a string, a number and a plain object; `pickKit` for each kind of module value and for a throwing getter; `hostKit` with no `window`
    - Update the `STYLE` scans in `tests/ui/render.test.mjs` as "Edits" says: no colour literal outside `.eb-fb` rules, `var(--token, currentColor)` allowed, no `outline: none`; the scans cover the new notice, folder and filter rules too
    - Check that every existing page test still passes with no kit
    - _Requirements: 1.1, 1.2, 5.1, 5.2, 5.5_
  - [x] 1.4 Write property test for the lookup in `tests/ui/kit.test.mjs`
    - **Property 2: A kit lookup never throws and keeps only components**
    - Seeded module values of every kind; at least 100 iterations with the seed printed on failure
    - **Validates: Requirements 1.1, 1.2**
  - [x] 1.5 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 1.1, 1.2, 1.3, 1.5, 5.1, 5.2, 5.5_

- [x] 2. Page: the header, the column headers and the empty and error states
  - [x] 2.1 Draw them in `ui/index.mjs`
    - The header with `PageHeader` as the design's table gives it (the `h1` inside the title, the one-line subtitle, the always-present "Checking for updates…" in the actions), and the fallback header as it is
    - The column box, the header bar, `span.eb-dot` with `aria-hidden`, the name and the count, with the dot's colour by column key (`planned`, `in-progress`, `done` as `columnsOf` names them); the heading element and level stay; the group heading's look
    - The empty plan with `EmptyState` and the icon; the backend error and the unreachable state with `ErrorNotice` (message, and a footer with the code and the `settings` entries as `code` text), with no `askAgent`
    - The notices with the role `status`, "Loading…" and the disclosure keep their markup
    - _Requirements: 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - [x] 2.2 Check the markup in `tests/ui/render.test.mjs`
    - With a fake kit and without: the header's props and subtitle text, the `visibility` slot, the column header's order and `aria-hidden`, the capitals by style and not by text, the heading levels in every view, the empty and error trees, the roles (`alert` only on the two errors, `status` on the rest), and that no component gets a prop the design does not name
    - Add the cases for a kit that has only some of the components
    - _Requirements: 1.2, 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6_
  - [x] 2.3 Draw the filter row, the header's "Projects" button and the first-run notice in `ui/index.mjs`
    - Check the props at `v0.12.2` before writing them: `Select` takes `options`, `optionLabels`, `value`, `onChange` and `aria-label` (`website/src/kirocrew-ui/Select.tsx`), and `Btn` takes `primary`, `danger`, `busy` and every button attribute (`website/src/components/ui.tsx`, re-exported by `kirocrew-ui/index.ts`); pass nothing else
    - `renderFilters`: both dropdowns are drawn through the one `Select` of `parts.Select`, each in its own `div.eb-filter`, project first, inside the one `div.eb-filters`, with the same five props and no `className`; with no `Select` both are the native `select` carrying `eb-fb`. Make `renderProjects` and `renderFilter` take their control from one small function so the two cannot drift
    - The header's "Projects" button as a plain `Btn` (`type`, `aria-expanded`, `data-eb-setup-btn`, `onClick`) in the `PageHeader` actions after "Checking for updates…", and as `button.eb-fb` in the fallback header; keep it in the states that draw it today, and add it to no other. The page draws it in the plan view only, while the setup spec's Requirement 2, criterion 6 says every state: report that gap to the owner, and do not close it in this story
    - The first-run notice: keep `div.eb-notice[role=status]` and the text "Choose your projects", and draw "Set up projects" as a `Btn` with `primary` (keeping `aria-label` and `aria-expanded`), or `button.eb-fb`
    - Draw the failed project list notice and the other `status` notices with the `eb-notice` class as they have it; they take the Notice_Style from `STYLE`
    - _Requirements: 6.1, 6.5, 6.6, 6.7, 6.8_
  - [x] 2.4 Check them in `tests/ui/render.test.mjs`, `tests/ui/board.test.mjs` and `tests/ui/projects.test.mjs`
    - Both dropdowns with a fake `Select`: exactly the five props, strings in `options`, the names in `optionLabels`, no `className`, the project first in the one row, the epic dropdown hidden where the filter spec hides it, and with no `Select` the two native selects with `eb-fb`
    - The "Projects" button with and without a kit: plain, in the actions after "Checking for updates…", present in the same states as with no kit, `aria-expanded` and `data-eb-setup-btn` on the element, and focus back on it when the view closes
    - The first-run notice: `status`, no `alert`, "Set up projects" `primary` with its accessible name, and the same with no kit; update the tests listed under "Edits to earlier specs and checks" that find these buttons as `button` elements
    - _Requirements: 6.1, 6.5, 6.6, 6.7, 6.8_
  - [x] 2.5 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 1.2, 1.3, 2.1, 2.2, 2.3, 2.4, 2.5, 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 6.1, 6.5, 6.6, 6.7, 6.8_

- [x] 3. Page: the cards, the badges and the buttons
  - [x] 3.1 Draw them in `ui/index.mjs`
    - `li.eb-item` with a `Card` (class, `data-mode`, `data-open`), or the fallback `li.eb-card.eb-fb` with the same attributes; the name in a `CardTitle` with `role="presentation"`, or `div.eb-card-name`
    - The meta lines, the description, the progress in a `Badge` (variant `muted`, or `ok` when every task is ticked) with the bar, and the state word in a `Badge` (Needs you `warn`, Interrupted `err`, Working `ok`, Stalled `warn`, Review `muted` or `err` for Checks failed, Your turn `muted`) with its `data-state`
    - Every button of the earlier specs as a `Btn` (on a card, `primary` for "Start" only) or the fallback button, with the same text, handler and keyboard behaviour; the panel's "Close" the same. The buttons of the Projects parts are in 2.3 and 3.6
    - The open card's mark as the design gives it (a ring, no padding change) and the edits of "Edits" to the chat design's two paragraphs
    - _Requirements: 1.3, 1.4, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_
  - [x] 3.2 Check the markup in `tests/ui/render.test.mjs`
    - The card with and without `Card`, the name's `role="presentation"` and the absence of a card heading, the meta and description classes and the three-line rule, the progress and state badges and their variants, each button as a `Btn` and as a fallback, and that the stretched link, the controls above it and `data-card-id` are where the start spec puts them
    - Update the tests that find a card by `li.eb-card`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9_
  - [x] 3.3 Check the wiring in `tests/ui/board.test.mjs`
    - `createBoard` with a fake kit through `env.kit`: it is read on every render and a component that arrives later is picked up; a card's click, keyboard and focus behaviour is the same with and without the kit; "Start" is `primary` and the others are plain; "Close" is a `Btn`; a start, a resume and a retry of the brief behave as before
    - _Requirements: 1.1, 1.2, 3.1, 3.7_
  - [x] 3.4 Write property test for the kit's effect in `tests/ui/kit.test.mjs`
    - **Property 1: The kit changes the look, never the words or the structure**
    - Seeded subsets of the seven components as fakes, and seeded views and `ui` covering every card mode, column and state, with and without a panel, with and without the project dropdown, the Unconfigured state, and the Projects view in each phase (opening, error, no folders, ready, saving); at least 100 iterations with the seed printed on failure
    - **Validates: Requirements 1.2, 1.3, 1.6, 2.4, 3.1, 3.2, 3.7, 4.1, 4.4, 4.5, 6.1, 6.4, 6.6, 6.7, 6.8**
  - [x] 3.5 Bring the earlier specs' text in line
    - Edit the colour sentences of the board design's "Layout and theme" and of the start design's description of `STYLE` to say that the greys are the fallbacks'; tick nothing in those specs
    - _Requirements: 5.1, 5.2_
  - [x] 3.6 Draw the Projects panel in `ui/index.mjs`
    - `renderSetupView(h, setupState, actions, kit = {})` takes the kit as `renderBoard` does, and `createBoard` passes it; the panel itself stays the chat's `renderPanel`, with "Close" a `Btn` or the fallback button as in 3.1. Add no panel, no heading and no second layout
    - The folder row as the design's table gives it: `li.eb-folder` with `label.eb-folder-label` (native checkbox, then the name), `div.eb-folder-dir` with the directory as literal text, and the native name field when ticked; the labels, `aria-label` and placeholder of the setup spec unchanged
    - "Save" as a `Btn` with `primary` (still `disabled` by the setup spec's rule, still "Saving…" while saving, never `busy`) and "Cancel" as a plain `Btn`, in one `div.eb-setup-actions`; "Try again" and the view's "Close" as plain `Btn`; with no `Btn`, `button.eb-fb`
    - The config line and the two errors: keep their `p[role=status]` and text, add the class `eb-notice`, and `eb-notice-error` for the errors; draw no `ErrorNotice` for them
    - Check the props at `v0.12.2` as in 2.3; the page's checkbox and name field stay native (design, Open Question 10)
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.8_
  - [x] 3.7 Check the panel in `tests/ui/setup.test.mjs` and `tests/ui/board.test.mjs`
    - `renderSetupView` in each phase with a fake kit and with none: the folder row's parts in order, the directory as text in the meta class, the name field only when ticked, "Save" `primary` and not `busy`, `disabled` as before, "Cancel" plain and absent while saving, both in one `div.eb-setup-actions`, "Try again" and "Close" plain, the three notices with `status`, the classes `eb-notice` and `eb-notice-error`, and no `alert` and no `ErrorNotice`
    - `createBoard` with a fake kit: the panel opens from the "Projects" button, and "Close" and "Cancel" close it and put focus back on that button; a save, a failed save and a retry of the folder read behave as before; the heading structure is the same as with no panel
    - Update `buttons(tree)` and the other finders in `tests/ui/setup.test.mjs` that assume a `button` element, as "Edits to earlier specs and checks" lists
    - _Requirements: 6.2, 6.3, 6.4, 6.5, 6.8_
  - [x] 3.8 Give the panel Crew's look in `STYLE` and `renderPanel`
    - Applies to the panel with a chat and with the Projects view alike. The markup of `renderPanel` does not change (`aside.eb-panel`, `div.eb-panel-head` with `span.eb-panel-title` and the "Close", `div.eb-panel-body`); read `STYLE` and `renderPanel` first, and use the rows "Panel head", "Panel title", "Panel edge and background" and "Panel body" of the design's table
    - Check the sources at `v0.12.2` before writing the values: `SidePanel.tsx` (the strip and the root) and `PanelSectionHeader` in `components/ui.tsx`; `ChatPanel` in `app-sdk/ChatPanel.tsx`
    - `.eb-panel-head`: `var(--bg-elevated)` background, `var(--border)` bottom border in place of `currentColor`, `padding: 0 8px`, `min-height: 40px`; `.eb-panel-title`: 11.5px, weight 600, no colour rule
    - `.eb-panel`: `background: var(--bg)`. Replace the `currentColor` left border with `var(--border)` in both copies of the beside-the-board rule (the `@container` rule and the `@supports not` copy), and add none where the panel is over the board
    - `.eb-panel-body` keeps `flex: 1 1 0; min-height: 0` and gets no other rule; add no rule that selects inside it, and give `ChatPanel` only `slotKey` and `conversationOnly`, as today. The embedded chat stays as Crew draws it
    - The Projects view body takes `padding: 8px`, so it lines up with the head (the row "Projects view body")
    - Edit the chat design's paragraph on the panel's look in place to match, as "Edits to earlier specs and checks" says; tick nothing in that spec
    - _Requirements: 5.1, 5.4, 5.5, 6.2, 6.9, 6.10, 6.11_
  - [x] 3.9 Check the panel in `tests/ui/render.test.mjs` and `tests/ui/board.test.mjs`
    - `STYLE` scans: the head has the elevated background and the `var(--border)` bottom border; the left border is `var(--border)` and appears only in the two beside-the-board rules; the panel's background is `var(--bg)`; every colour is `var(--token, currentColor)`; no `currentColor` border is left on `.eb-panel` or `.eb-panel-head`; no `outline: none`
    - No rule in `STYLE` selects a descendant of `.eb-panel-body`, and the sizes of the head and the title are those of the table and no others
    - `renderPanel` draws the same elements for a chat and for the Projects view, with "Close" a plain `Btn` and with no kit; `createBoard` gives `ChatPanel` exactly `slotKey` and `conversationOnly`, and the chat and the Projects panel open, close and take focus as before
    - _Requirements: 5.1, 5.4, 5.5, 6.2, 6.9, 6.10, 6.11_
  - [x] 3.10 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.6, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 3.8, 3.9, 6.2, 6.3, 6.4, 6.5, 6.8, 6.9, 6.10, 6.11_

- [x] 4. Check it on a Crew host
  - [x] 4.1 Install the app in Kiro Crew and check the look (done by you in the app)
    - Use Crew 0.12.2 or later and the throwaway project of the start spec's task 4.2, with a plan that has cards in all three columns, a long description, a story with a chat in each of the four states, an empty column and a story with no spec
    - Check the components: the header, the cards, the badges, the buttons and the empty and error states look like Crew's own; open the browser's inspector and confirm they are Crew's elements (`card-glow`, `animate-rise` and the like) and not the page's fallbacks
    - Check the column headers beside Crew's Sessions board: dot, capitals, count, bar, box and radius match; the dot colours read well in both themes (design, Open Question 3)
    - Check the card: the title is bold, the meta lines are quieter, a long description stops at three lines with no control to show more, and a screen reader reads all of it; the card's inset in a column (design, Open Question 1) and a card against the column's background (Open Question 7)
    - Check the header's left edge lines up with the columns at the window widths of 700, 800 and 1,200 pixels (Open Question 6), and the columns do not move when "Checking for updates…" appears
    - Check the badges: the six states, the progress badge and the open card's mark are told apart by their words and read well in both themes (Open Question 4)
    - Check the heading structure in the browser's accessibility tree: one `h1`, three `h2`, `h3` for the groups, and no heading for a card (Open Question 2); check that no `alert` appears except for the two errors
    - Check the projects parts with two projects in `config.json` or a saved setup: the Project dropdown and the epic dropdown are both Crew's `Select`, in one row, the same height, with the 8px gap, and the open list of each is themed; with one project only the epic dropdown shows
    - Check the Projects panel: it opens as the chat's panel does (beside the board from 1,000 pixels, over it below), each folder is a row with checkbox, name and directory, the directory is quieter and monospace like a card's spec folder, a ticked folder shows its name field; "Save" is the accent button, "Cancel" is plain, there is space between them, and the focus ring shows on both, the checkbox and the field
    - Check the panel for a chat and for the Projects view next to Crew's own side panel and chat column: the head is an elevated bar with a line under it and the title in the section-label size and weight, "Close" is a plain Crew button, the left edge is a `--border` line beside the board, and the background matches the chat column in light and dark and one other palette (design, Open Question 11); confirm the embedded chat is exactly as Crew draws it, with no rule of the page inside it
    - Check the notices: the first-run notice with "Set up projects" as the accent button, the config line when `config.json` also has projects, a load error (make the folder read fail) and a save error (save a path that is not a checkout), all in one look, in light and dark and one other palette; the neutral tone is readable and the error tone's border is not too strong (design, Open Question 9); confirm in the accessibility tree that none of them is an `alert`
    - Check the header's "Projects" button is a plain Crew button beside "Checking for updates…", and that the columns still do not move when the text appears
    - Check the themes: light and dark, and one other Crew palette, with no clash and no unreadable text, and the focus ring on the card's control, "Start", "Cancel" and "Close"
    - Check the fallbacks: in the console, delete one component (and `Select`) from `window.__kirocrew_modules['@kirocrew/ui']` before the page loads (each in turn, and the whole module), and confirm that part is drawn as it was and the rest of the page still works
    - Check the open questions of the design that only the host can answer, and write the owner's answers into the design
    - _Requirements: 1.1, 1.2, 1.3, 2.1, 2.2, 2.3, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.9, 4.1, 4.2, 4.3, 4.4, 5.1, 5.3, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 6.7, 6.9, 6.10, 6.11_
    - _Checked on the Crew host on 15 November 2026, on epic-board itself, beside Crew's Sessions board: the header, the column headers, the cards, the badges, the buttons, both dropdowns in one row, the Projects panel and the chat panel's frame look like Crew's own, in light and dark. The owner's answers to the open questions are in the design. Not checked on the host, covered by tests: the fallbacks with components deleted in the console, the accessibility tree, the header's alignment at 700, 800 and 1,200 pixels, the load and save error notices, and the Checks failed and Stalled badges. Found on the host: the Projects view's config line still used the page's old words; it now uses the setup spec's (set-up-projects, Requirement 4, criterion 3)._

- [x] 5. Fold the columns on a narrow screen
  - [x] 5.1 Fold button, body and style
    - In `ui/index.mjs`, `renderColumn` puts a `button.eb-fold` (chevron from the style sheet, `aria-expanded`, `aria-controls`) at the end of the column heading and the groups in `div.eb-column-body`; the column carries `data-folded`. `STYLE` hides a folded body below 720 pixels and hides the button, and shows every body, from 720 pixels (container query and the `@media` fallback)
    - Pure helpers `DEFAULT_FOLDS`, `foldsFor`, `toggleFold`, `loadFolds`, `saveFolds` (key `epic-board.folded`, per project); the Board keeps the folds in state and passes `folded` and `toggleColumn`
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - [x] 5.2 Tests
    - New `tests/ui/fold.test.mjs`. The structure rules in `render.test.mjs` and `kit.test.mjs` that allowed no control outside a card and no native button but a Fallback now also allow the column's `eb-fold` button (Requirement 7.1)
    - Built by Claude on the Mac on 2026-11-19 at the owner's request, as a quick change outside a Crew run
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
- [x] 6. An Unplanned column
  - [x] 6.1 Status, column and style
    - `backend/parse.py` accepts `unplanned`; `story_card` in `backend/plan.py` keeps a spec story with that line in Unplanned until every task is ticked. In `ui/index.mjs`, `COLUMNS` starts with Unplanned, `columnsOf` moves a started Unplanned card to In progress, `DEFAULT_FOLDS` folds it, and `STYLE` lays out four columns from 720 pixels
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
  - [x] 6.2 Tests
    - New tests in `tests/test_plan.py` and `tests/ui/columns.test.mjs`. The tests in `columns`, `filter`, `fold` and `render` that named three columns now name four
    - Built by Claude on the Mac on 2026-11-19 at the owner's request, as a quick change outside a Crew run
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_
- [x] 7. A taller list in the dropdowns
  - [x] 7.1 Style and test
    - `STYLE` raises the open list's `max-height` to `min(440px, var(--radix-select-content-available-height))` while a trigger in `.eb-filter` has `aria-expanded="true"`; a test in `tests/ui/render.test.mjs` checks the rule
    - Built by Claude on the Mac on 2026-11-20 at the owner's request, as a quick change outside a Crew run
    - _Requirements: 9.1_

## Notes

- Each group is one pull request and is merged by the owner; start the next group from the updated main
- This story edits rules that other specs own, in place, as "Edits to earlier specs and checks" in the design lists: the board spec's Requirement 3 (criterion 1), Requirement 8 (criterion 3) and Requirement 10 (criterion 1), and the chat design's panel button and mark. Their ticked tasks are not reopened
- No task is optional: every task checks a requirement of this spec
- The open questions in the design are for the owner; the host-dependent ones are checked in 4.1

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.4"] },
    { "id": 3, "tasks": ["1.5"] },
    { "id": 4, "tasks": ["2.1"] },
    { "id": 5, "tasks": ["2.2", "2.3"] },
    { "id": 6, "tasks": ["2.4"] },
    { "id": 7, "tasks": ["2.5"] },
    { "id": 8, "tasks": ["3.1"] },
    { "id": 9, "tasks": ["3.2", "3.3", "3.4", "3.5", "3.6", "3.8"] },
    { "id": 10, "tasks": ["3.7", "3.9"] },
    { "id": 11, "tasks": ["3.10"] },
    { "id": 12, "tasks": ["4.1"] }
  ]
}
```
