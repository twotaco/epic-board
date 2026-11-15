# Implementation Plan

## Overview

The work is four task groups. Each group is one pull request on its own branch, named `story/work-in-the-chat-g1` to `story/work-in-the-chat-g4`, cut from the latest main after the previous group's pull request is merged. Each group lands green on its own and leaves the app working. Every group ends with a sub-task that runs the tests and reports the counts run, passed and skipped. Tick each task in this file in the same branch, and tick nothing in the earlier specs. The page adds no dependency, and the backend does not change.

Start this story after the fix to "Start a story" (`.kiro/specs/start-a-story/`, group 5) has landed on main, because this story's start flow builds on that fix's `onSaved`, and group 3 changes the same file.

Group 1 is the page's pure logic. Group 2 draws the panel and its styles. Group 3 mounts Crew's `ChatPanel` in the component and wires the actions and the focus. Group 4 checks the whole on a Crew host, which is the only place the permissions and the layout can be confirmed.

## Tasks

- [x] 1. Page: the pure parts
  - [x] 1.1 Add the pure functions and the state to `ui/index.mjs`
    - `isChatPanel(value)`, `isPlainClick(event)` and `panelViewOf(view, ui, hasPanel)` as the design gives them
    - `initialUi` gains `open: null`; `uiReduce` gains `open-chat` (same state when the key is already open) and `close-chat` (with an optional `key` guard and an optional `focus`, which sets `focus: {cardId}` of the card that was open)
    - `cardViewOf` gives a `chat` view `open`, true when `ui.open?.key` is its key
    - Nothing else in the file changes, and no other action touches `open`
    - _Requirements: 1.1, 1.3, 1.4, 2.1, 2.2, 2.3, 2.6_
  - [x] 1.2 Check them in `tests/ui/panel.test.mjs` and the existing files
    - `isChatPanel`: a function, a memo-like object with `$$typeof`, `null`, `undefined`, a string, a number and a plain object; `isPlainClick`: each modifier alone, a secondary and a middle button, and `defaultPrevented`; `panelViewOf`: the title from the plan, `'Chat'` when the card is gone, null with no host panel and with nothing open; `uiReduce` for the two actions including the key guard and the focus request
    - `tests/ui/controls.test.mjs` and `tests/ui/chats.test.mjs`: the new field in `initialUi`, and `cardViewOf`'s `open`
    - _Requirements: 1.1, 1.3, 1.4, 2.1, 2.2, 2.3, 2.6_
  - [x] 1.3 Write property test for one open chat in `tests/ui/panel.test.mjs`
    - **Property 1: At most one chat is open, and it is always one the page started**
    - Seeded sequences of `open-chat` and `close-chat` actions, records added and removed, reads that drop or keep records and failed reads; at least 100 iterations with the seed printed on failure
    - **Validates: Requirements 1.3, 1.4, 2.1, 2.2, 2.3, 2.6**
  - [x] 1.4 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 1.1, 1.3, 1.4, 2.1, 2.2, 2.3, 2.6_

- [x] 2. Page: the panel, the mark and the layout
  - [x] 2.1 Draw them in `ui/index.mjs`
    - `renderPanel` and `renderShell` as the design gives them; `renderBoard` is not changed except that the card's `a` gets the `onClick` of the design, `view.panelAvailable` and an `openChat` action defaulting to a no-op, and an Open_Card gets `data-open`, `aria-current` on its link and `span.eb-chat-open` "Chat open"
    - Add the rules of the design to `STYLE`: the container, the panel, the mark, the narrow rules, the wide rules in a container query named `eb-shell` at 1,000 pixels, and the same wide rules in a media query under `@supports not (container-type: inline-size)`; only `currentColor` and greys with an alpha between 0 and 1, no `outline: none`
    - The failure text is `p[role=status]` and the failure link is built only from `chatHref`; no heading is added; every text from the plan is a child or a text attribute
    - _Requirements: 2.4, 2.5, 3.1, 3.2, 3.3, 3.5, 4.1, 6.1, 6.2, 6.3, 6.4_
  - [x] 2.2 Check the markup in `tests/ui/render.test.mjs`
    - The panel's `aside`, `aria-label`, `tabindex`, `data-eb-panel`, title and "Close" button; the mark on the Open_Card and on no other; no panel, no mark and an unchanged link when the host has none; the click handler (plain click calls `preventDefault` and `openChat` with the card id and key; a modifier click, a secondary button, a handled event and a missing host panel do neither); no heading added and the same heading levels; literal text for a name with markup in the title and the label; `STYLE` scans for colour and outline and for the narrow and wide rules in both forms
    - Update the interactive-element check: the only interactive elements are the `summary`, the controls of the start spec's Requirements 2, 4, 7 and 8, the Panel's "Close" button and the failure link, and no element drawn inside the panel's body by a fake component
    - Update the root checks: the page's first element is `eb-shell`, then `eb-split`, then `eb-root`
    - _Requirements: 1.5, 1.6, 2.4, 2.5, 3.1, 3.2, 3.3, 3.5, 4.1, 6.1, 6.2, 6.3, 6.4_
  - [x] 2.3 Write property test for the agreement of the mark and the panel in `tests/ui/panel.test.mjs`
    - **Property 2: The mark, the Panel and the chat agree**
    - Seeded views, chats states and `ui` with and without a host panel; at least 100 iterations with the seed printed on failure
    - **Validates: Requirements 1.2, 1.5, 2.4, 2.5, 3.5**
  - [x] 2.4 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 1.2, 1.5, 1.6, 2.4, 2.5, 3.1, 3.2, 3.3, 3.5, 4.1, 6.1, 6.2, 6.3, 6.4_

- [x] 3. Page: mount `ChatPanel` and wire it
  - [x] 3.1 Wire it in `createBoard`
    - Read `env.ChatPanel ?? hostChatPanel()` in the component on every render (`window.__kirocrew_modules?.['@kirocrew/app-sdk']?.ChatPanel`, no `window` needed at import) and set `hasPanel` with `isChatPanel`
    - Mount `h(ChatPanel, {slotKey, conversationOnly: true})` and nothing else, with no React `key`, so that one instance gets a new `slotKey`; wrap it in `PanelBoundary`, a class made from `React.Component` that shows the failure text and link and clears when the `slotKey` changes
    - `actions.openChat` checks that the chats state holds a record with that key and card id, and dispatches `open-chat`; `actions.closeChat` dispatches `close-chat` with `focus: true`; a start's `onSaved` dispatches `open-chat` after it adds the record when `hasPanel` is true; `actions.startAgain` dispatches `close-chat` with the removed record's key after it removes the record
    - An effect keyed on the open key focuses `[data-eb-panel]`; the existing focus effect handles Close; compose the page with `renderShell`
    - Nothing in the file calls a path containing `approve`, `question` or `approvals`
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.1, 2.2, 2.3, 2.6, 2.7, 3.3, 3.4, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 6.5_
  - [x] 3.2 Check the wiring in `tests/ui/board.test.mjs`
    - With a fake `ChatPanel` that records its props and counts its mounts: a plain click opens the Panel with exactly `{slotKey, conversationOnly: true}`; a click on a second started card switches the same instance (one mount, two `slotKey` values, never two mounted); the Open_Card again changes nothing; a modifier click and a secondary click are not taken; with no fake `ChatPanel` the click is left to the browser; `openChat` for a key with no record does nothing
    - A start with the fake opens the Panel when the chat is saved, while a send that never answers is still open, and replaces a chat open on another card; a start that fails before the save leaves the Panel as it was; the brief's notes are unchanged
    - Close puts focus on the card's link; opening puts focus on the Panel's container, and the Open_Card again does not; "Start again" closes the Panel without moving focus; a read of the records that does not list the chat, a failed read and a missing chat do not close it
    - The boundary shows its text and link when the fake throws, keeps "Close", and tries again after another open; unmounting leaves no listener or timer; the page's requests are the same with the Panel open as with it closed
    - Update the tests that assume the old root or that a click follows the link
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 1.6, 1.8, 2.1, 2.2, 2.3, 2.6, 2.7, 3.3, 3.4, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 6.5_
  - [x] 3.3 Check the permissions and the scan
    - `tests/test_ui.py`: `permissions.api` is exactly `/api/chat` and `/api/chat/slots` and `app.json` declares none of `sessionApproval`, `chatSlots`, `spawn`, `agentTurns`, `network` or `storage`; add the number of this story to the assertion's comment
    - The source scan of `ui/index.mjs` of the start spec's task 3.5 still finds no `approve`, `question` or `approvals` path, no `innerHTML` and no `dangerouslySetInnerHTML`
    - _Requirements: 1.7, 1.8, 6.6_
  - [x] 3.4 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 2.1, 2.2, 2.3, 2.6, 2.7, 3.3, 3.4, 4.1, 4.2, 4.3, 5.1, 5.2, 5.3, 5.4, 6.5, 6.6_

- [x] 4. Check it on a Crew host
  - [x] 4.1 Install the app in Kiro Crew and check the panel (done by you in the app)
    - Use Crew 0.12.2 or later, the throwaway project of the start spec's task 4.2, and the app's `app.json` as it is, with `permissions.api` of exactly `/api/chat` and `/api/chat/slots`
    - **Check the permissions.** Click a started card. Confirm that the transcript loads, a message sends, a tool approval can be approved and a question can be answered in the panel, and that the host reports no permission error and the browser's network log shows no refusal for the panel's requests. If a call is refused, note its path, add only that entry to `permissions.api` and change the start spec's Requirement 1, criterion 3 and the check in `tests/test_ui.py` with it
    - Check that the panel shows no sessions rail and that the address bar does not change when a chat opens or switches
    - Check switching: open one started card and then another, and confirm the panel shows the second chat, a message typed there goes to the second chat, and only one panel exists in the page (the browser's element inspector)
    - Check the layouts: in a window of 1,000 pixels or more the panel is to the right of the columns, the board scrolls on its own and its cards still respond, and the plan and the chat states go on updating; below 1,000 the panel covers the board, "Close" returns to it, the board's scroll position is as it was and keyboard focus cannot reach the hidden board; resize across 1,000 with a message half typed in the panel and confirm the draft and the chat stay
    - Check the mark: the Open_Card shows "Chat open", a thicker border and `aria-current`, no other card does, and the mark goes when the panel closes
    - Check the click rules: a plain click and Enter on the link open the panel; Ctrl-click, Cmd-click and middle-click open the chat in a new tab; Space on the link does nothing, as on any link
    - Check focus: opening moves focus into the panel; Tab reaches "Close"; Enter on it returns focus to the card's link
    - Check a start whose conductor waits for a tool approval: the panel opens as soon as the chat is saved, the brief appears in it, the approval is shown in the panel and approving it there makes the card change to Working
    - Check the fallback: with the host's `ChatPanel` hidden (for example by loading the page in a Crew version without it, or by deleting `ChatPanel` from `window.__kirocrew_modules['@kirocrew/app-sdk']` in the console before the page loads), no panel and no "Close" appear and a click follows the link to `/chat?sid=`
    - Check the open questions of the design: after a panel has been open, what Crew's own chat page shows as its active chat, and whether the panel stays on its chat while you change sessions elsewhere in Crew
    - Check light and dark themes and the focus ring on "Close"
    - _Requirements: 1.2, 1.3, 1.5, 1.7, 2.1, 2.2, 2.4, 3.1, 3.2, 3.3, 3.4, 4.1, 4.2, 5.1, 6.1, 6.3_
    - _Checked on the Crew host on 15 November 2026. Seen: the transcript, sending, approving and answering in the panel, switching chats, the mark, Cmd-click to a new tab, the narrow layout with Close, focus, and both themes. Not reproducible on this host, covered by tests: the fallback without ChatPanel. The design's open questions about Crew's own active chat were not checked. `permissions.api` now also lists `/api/chat/folders` (set-up-projects, Requirement 1); the panel itself needed no entry._

## Notes

- Each group is one pull request and is merged by the owner; start the next group from the updated main
- This story edits requirements that other specs own, in place, as "Edits to earlier specs and checks" in the design lists: the start spec's Requirement 7 (criteria 1, 5 and 6), Requirement 6 (criterion 6) and its introduction, and the board spec's Requirement 1 (criteria 2 and 3). Their ticked tasks are not reopened
- No task is optional: every task checks a requirement of this spec
- The open questions in the design are for the owner; the host-dependent ones are checked in 4.1

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3"] },
    { "id": 2, "tasks": ["1.4"] },
    { "id": 3, "tasks": ["2.1"] },
    { "id": 4, "tasks": ["2.2", "2.3"] },
    { "id": 5, "tasks": ["2.4"] },
    { "id": 6, "tasks": ["3.1"] },
    { "id": 7, "tasks": ["3.2", "3.3"] },
    { "id": 8, "tasks": ["3.4"] },
    { "id": 9, "tasks": ["4.1"] }
  ]
}
```
