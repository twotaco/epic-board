# Requirements Document

## Introduction

This story is the fourth of the Epic Board epic (`docs/epics/epic-board.md`). It builds on "Show the board" (`.kiro/specs/show-the-board/`, "the board spec" below) and "Start a story" (`.kiro/specs/start-a-story/`, "the start spec" below), and does not restate them. The board shows every epic's cards at once. This story adds a dropdown at the top of the board that narrows the board to one epic, or to all of them.

The filter is a view on the page. The backend, the `plan` route, `app.json` and the chat records do not change. The page already receives every group of the plan, so it can hide the groups the person did not choose. Choosing an epic does not fetch anything, and does not stop or restart the plan poller or the chat poller. The choice is remembered in the browser's `localStorage`, so it comes back after a reload. When the remembered epic is no longer in the plan, the board shows all epics.

## Glossary

- **Plan_Groups**: the `groups` of the plan the page already reads. Each has an `epic` (`{name, file}`, or `null` for "No epic") and its `cards`.
- **Filter_Key**: what the dropdown stores. `all` for all epics, `no-epic` for the "No epic" group, and otherwise the epic's `file`. These are the same keys `columnsOf` gives a group in the board spec.
- **Filter_Options**: the list the dropdown shows, built from the Plan_Groups.
- **Saved_Choice**: the Filter_Key kept in `localStorage` under the key `epic-board.filter`, as plain text.

## Requirements

### Requirement 1: The dropdown

**User Story:** As a person planning a project, I want a dropdown above the board, so that I can look at one epic at a time.

#### Acceptance Criteria

1. WHEN the board shows a plan THEN the page SHALL show one dropdown (`select`) with a visible label "Epic", placed between the header line (branch, commit, age) and the columns.
2. THE first option SHALL be "All epics", with the Filter_Key `all`. It SHALL be selected when the page loads and nothing is saved (Requirement 3).
3. AFTER the first option, there SHALL be one option per Plan_Group that has at least one card, in the plan's order, labelled with the epic's name and keyed by its `file`. The "No epic" group, when it has cards, SHALL be the last option, labelled "No epic" and keyed `no-epic`.
4. THE page SHALL NOT show the dropdown while it has no plan to show: while loading, on an error, when the backend cannot be reached before a first plan, and when the plan has no cards at all (the empty board of the board spec).
5. THE dropdown SHALL work with the keyboard and a screen reader as a native `select` does, and its label SHALL be tied to it with `htmlFor` and `id`.

### Requirement 2: What the filter shows

**User Story:** As a person planning a project, I want the board to show only the epic I picked, so that I can see its stories without the others.

#### Acceptance Criteria

1. WHEN the Filter_Key is `all` THEN the board SHALL show exactly what the board spec says it shows, unchanged.
2. WHEN the Filter_Key names a Plan_Group THEN every column SHALL show only the cards of that group, in the plan's order, under the same group heading as before.
3. THE three columns SHALL stay (Planned, In progress, Done) even when one has no card for the chosen epic. Each column's count SHALL count only the cards it now shows.
4. THE filter SHALL NOT change a card's column, its progress, its chat state, its Start controls or its link to a chat. A card that shows a chat state with all epics SHALL show the same state under the filter.
5. THE filter SHALL NOT hide the header, the notices (failed fetch, backend unreachable, chat status unreadable) or the list of problems. The problems list stays whole: it is about the plan's files, not about one epic.
6. A spec listed under two epics is a card in two groups (board spec). Under the filter it SHALL appear once, as the card of the chosen epic.

### Requirement 3: Remembering the choice

**User Story:** As a person who comes back to the board, I want my choice to be remembered, so that I do not pick the epic again after every reload.

#### Acceptance Criteria

1. WHEN the plan poller delivers a new plan THEN the Filter_Key SHALL stay as chosen, if the Plan_Groups of the new plan still hold that key with at least one card.
2. WHEN the chosen key is not among the new Filter_Options (the epic was removed, renamed to a new file, or has no cards left) THEN the board SHALL show all epics, and the dropdown SHALL show "All epics". The stored choice SHALL be set back to `all`, so that the epic coming back later does not reselect itself.
3. WHEN the plan poller fails and the page keeps showing the last plan (the board spec's unreachable notice) THEN the filter SHALL keep working on that plan.
4. THE chat poller, the start flow and the resume flow SHALL NOT read or change the Filter_Key, and starting a story SHALL NOT change what the filter shows.
5. WHEN the person chooses an option THEN the page SHALL save its Filter_Key as the Saved_Choice. Choosing "All epics" SHALL save `all`.
6. WHEN the page loads THEN it SHALL read the Saved_Choice once and use it as the starting Filter_Key. WHEN nothing is saved THEN the starting key SHALL be `all`.
7. WHEN the first plan arrives and the Saved_Choice is not among its Filter_Options THEN the board SHALL show all epics, the dropdown SHALL show "All epics", and the Saved_Choice SHALL be set to `all`. Until a plan has arrived the page shows no board (Requirement 1.4), so a saved epic is never judged missing before then.
8. WHEN `localStorage` is not there, throws on a read or a write (private mode, a full quota, a blocked setting), or holds a value that is not text THEN the page SHALL work as if nothing were saved: it SHALL start on `all`, keep the choice in memory for that visit, and show no error.

### Requirement 4: No new reach

**User Story:** As the person who installs the board, I want this story to add no permission, no setting and no dependency.

#### Acceptance Criteria

1. THE backend, `app.json` and `config.json` SHALL stay as they are, and `app.json` SHALL still declare none of `sessionApproval`, `chatSlots`, `spawn`, `agentTurns`, `network` or `storage`. The page SHALL keep the choice only in the browser's `localStorage`, under the one key `epic-board.filter`, and SHALL make no new request. The choice is per browser, not per person or per project.
2. THE page SHALL add no dependency.
3. THE page's existing tests SHALL pass unchanged, except where a test names the exact children of the plan view (Requirement 1.1 adds one child); such a test SHALL be changed only for that.

## Open Questions

- Whether the host's page sandbox allows `localStorage`. The manual check (tasks 2.4) reads it on a real host. Requirement 3.8 keeps the board working if it does not.
- The key `epic-board.filter` is shared by every project the board shows in one browser. One board shows one repository (the epic's "Not in this epic"), so this is not a problem today.
