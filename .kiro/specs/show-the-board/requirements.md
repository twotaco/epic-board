# Requirements Document

## Introduction

This story is the second of the Epic Board epic (`docs/epics/epic-board.md`). It builds on "Read the plan from main" (`.kiro/specs/read-the-plan-from-main/`, called "the earlier spec" below), whose backend returns the plan as data. This story replaces the placeholder page (`ui/index.mjs`) with a read-only board, and changes the backend so that the page never waits on git. The next story, "Start a story", adds the Start button and the "Started" mark on cards.

The board shows every card of the plan in three columns: Planned, In progress and Done. Inside a column the cards are grouped under their epic, with "No epic" last. Each card shows its name, its description, its task progress and its spec folder name.

The earlier spec fetches from `origin` on every plan request, which can take seconds. This story makes the backend keep the last plan in memory, answer from it at once, and refresh it with a background fetch. The page asks again at intervals and picks up the refreshed plan.

Four criteria of the earlier spec were edited in place because this story changes them: 2.1, 2.2, 2.5 and 8.4. Every other rule of the earlier spec still applies and is not restated here, including the statuses, the order of the groups, the `problems` list and the error responses. The only card field this story adds is `description`.

## Glossary

- **Held_Plan**: the plan the backend keeps in memory and answers requests with.
- **Refresh**: one background run that fetches the main branch, builds the plan and replaces the held plan.
- **Plan_Age**: the number of whole seconds since the last fetch of the main branch that succeeded. It is none until a fetch has succeeded since the backend started.

## Requirements

### Requirement 1: The board page

**User Story:** As a person planning a project, I want the app's page to show the board, so that I see the whole plan at once and cannot change it by accident.

#### Acceptance Criteria

1. WHEN the page is opened at the app's route THEN the page SHALL show the board in place of the placeholder, and `app.json` SHALL keep its route and backend declarations.
2. THE page SHALL make no request other than reads of the backend's `plan` route, and SHALL use the host's React with no added dependency or build step.
3. THE page SHALL have no Start button, no "Started" mark and no interactive element other than the unreadable-files disclosure (Requirement 9). An interactive element is any link, button, input or other control that responds to click or keyboard activation.
4. THE page SHALL show every text it takes from the plan, such as names, descriptions, folder names, messages, settings and problems, as literal text and not as HTML or Markdown.

### Requirement 2: Columns and grouping

**User Story:** As a person planning a project, I want the cards in Planned, In progress and Done columns grouped by epic, so that I see what is next and where each story belongs.

#### Acceptance Criteria

1. WHEN a plan with cards is shown THEN the page SHALL show three columns in the order Planned, In progress, Done, each headed with its name and its number of cards, and SHALL show each card only in the column of its status. A card shown under more than one epic group SHALL count once for each group.
2. WHEN a column holds cards THEN the page SHALL show one heading for each group that has a card with that column's status, in the order the plan returns the groups (earlier spec, Requirement 8), with the cards of each group in the order the plan returns them. A group with no epic SHALL be headed "No epic", and a spec listed in more than one epic SHALL appear as one card under each of those epics, in the column of that card's own status.
3. WHEN a column has no cards THEN the page SHALL show "Nothing here" under its heading.
4. WHILE the page is at least 720 CSS pixels wide THEN the page SHALL show the three columns side by side, from left to right in the order of criterion 1.
5. WHILE the page is narrower than 720 CSS pixels THEN the page SHALL stack the three columns vertically, in the order of criterion 1.

### Requirement 3: Card content

**User Story:** As a person planning a project, I want each card to show what the story is, which spec it comes from and how far it has got, so that I can judge it at a glance.

#### Acceptance Criteria

1. THE page SHALL show each card's name and, when the description is not empty, the description below the name. WHEN text is longer than the card is wide THEN the text SHALL wrap inside the card.
2. WHEN a card has a spec THEN the card SHALL show the spec folder name as plain text, for example `show-the-board`, and not the path `.kiro/specs/<folder>`.
3. WHEN a card has no spec THEN the card SHALL show "No spec yet", with no progress line and no bar.
4. WHEN a card has a spec and its task total is greater than 0 THEN the card SHALL show "`<done>` of `<total>` tasks" ("1 of 1 task" when the total is 1) and a bar filled to done divided by total. The bar SHALL be hidden from assistive technology, because the progress text carries the numbers.
5. WHEN a card has a spec and its task total is 0, or its task counts are none, THEN the card SHALL show "No tasks yet" or "Tasks could not be read" respectively, and no bar.

### Requirement 4: Card descriptions

**User Story:** As a person reading the board, I want the sentence I wrote after a story's status to appear on its card, so that the board says what each story is for.

#### Acceptance Criteria

1. WHEN a card comes from a story line, whether or not the story's link points to an existing spec, THEN the backend SHALL return the story's description (earlier spec, Requirement 5, criterion 4) as the card's `description`, with whitespace removed at both ends and every other character unchanged.
2. WHEN a story line has no full stop after its dash, or only whitespace after its first full stop, or no story line lists the card's spec, THEN the card's `description` SHALL be the empty string, and the backend SHALL NOT take a description from the spec's own files. A line that the earlier spec ignores (Requirement 5, criterion 10) SHALL NOT count as listing the spec.
3. WHEN a spec is listed by more than one story line THEN each epic card SHALL carry the description of its own story line, and the single "No epic" card of a spec that only `standalone.md` lists SHALL carry the description of the first such line in the order written.

### Requirement 5: Held plan and first request

**User Story:** As a person opening the board, I want it to appear at once, so that I never wait for git.

#### Acceptance Criteria

1. WHEN a plan request arrives THEN the backend SHALL answer from memory within 1 second, with the held plan or the held error (as the earlier spec describes the error), and SHALL NOT wait for any git command, including one still running.
2. WHEN the backend holds a plan THEN the answer SHALL have status 200 and the fields of the earlier spec's plan response with the cards of Requirement 4, plus `age_seconds` (the Plan_Age, an integer of 0 or more, or none) and `refreshing` (true while a refresh runs, otherwise false).
3. WHEN the backend holds neither a plan nor an error THEN the answer SHALL have status 202 and the body `{"pending": true}`.
4. WHEN the backend starts with a configured repository THEN it SHALL read the plan in the background from the local `origin/<main branch>` without fetching, and SHALL start its first refresh when that read ends, whether it succeeded or failed. WHEN that read succeeds THEN the backend SHALL hold the plan with `fetch` set to `{"ok": null}` and `age_seconds` set to none.
5. IF the first read fails THEN the backend SHALL hold the error `repository_not_a_checkout` (earlier spec, Requirement 1, criterion 4) when the repository is not a git checkout, and otherwise SHALL hold neither a plan nor an error, so that the first refresh decides.
6. IF no repository is configured THEN the backend SHALL answer every plan request within 1 second with the error of the earlier spec, Requirement 1, criterion 4, and SHALL run no git command and no refresh.

### Requirement 6: Background refresh

**User Story:** As a person keeping the board open, I want the plan to refresh itself in the background, so that it follows main without my asking and a failure does not blank it.

#### Acceptance Criteria

1. WHILE a repository is configured, the first read of Requirement 5 has ended and no refresh is running, WHEN a plan request arrives and either no refresh has started yet or the last refresh ended 60 seconds or more ago THEN the backend SHALL start one background refresh and SHALL answer the request without waiting for it.
2. WHILE a refresh is running THEN the backend SHALL start no other refresh.
3. WHEN a refresh's fetch succeeds THEN the backend SHALL replace the held plan with the new plan, SHALL discard any held error, SHALL set `fetch` to `{"ok": true}` and SHALL set `age_seconds` to the whole seconds since the end of that fetch.
4. IF a refresh's fetch fails and the earlier spec, Requirement 2, criterion 4 lets the plan be read from the earlier copy THEN the backend SHALL replace the held plan with that plan, SHALL discard any held error, SHALL set `fetch` to `{"ok": false, "reason": <the fetch failure's message>}` and SHALL leave the Plan_Age counted from the last successful fetch.
5. IF a refresh cannot build a plan THEN the backend SHALL keep a held plan unchanged, with `fetch` set to `{"ok": false, "reason": <the failure's message>}` and the Plan_Age unchanged, and SHALL hold the failure as an error, replacing any held error, only when it holds no plan, using the code `internal` for a failure with no other code.

### Requirement 7: The page picks up refreshed plans

**User Story:** As a person keeping the board open, I want the page to pick up a refreshed plan, so that I see main's changes without reloading.

#### Acceptance Criteria

1. WHEN the page opens, or changes from hidden to visible, THEN the page SHALL send a plan request at once, unless a request is in flight. The page SHALL have at most one request in flight.
2. WHILE the browser reports the page as hidden THEN the page SHALL send no request.
3. WHEN a response arrives THEN the page SHALL send the next request 2 seconds later if the response is pending (status 202 and body `{"pending": true}`) or has `refreshing` true, and 15 seconds later otherwise. A response without `refreshing`, such as an error, SHALL count as having `refreshing` false.
4. IF a request fails because the connection fails, no answer arrives within 10 seconds, or the body is not valid JSON, THEN the page SHALL send the next request 15 seconds after the failure and SHALL show what Requirement 9, criterion 5 describes.

### Requirement 8: Branch, commit and plan age

**User Story:** As a person reading the board, I want to see which commit it shows and how old it is, so that I know whether to trust it.

#### Acceptance Criteria

1. WHEN a plan is shown THEN the page SHALL show, above the columns, the main branch name, the first 7 characters of the commit and the plan age.
2. THE page SHALL word the plan age as "Updated less than a minute ago" under 60 seconds, "Updated N minutes ago" from 60 seconds to under 1 hour, "Updated N hours ago" from 1 hour to under 24 hours, and "Updated N days ago" from 24 hours on, where N is the age in that unit rounded down, with "minute", "hour" or "day" in the singular when N is 1. WHEN the plan age is none THEN the page SHALL show "Not yet updated from origin".
3. WHILE `refreshing` is true THEN the page SHALL show "Checking for updates…" next to the plan age, and SHALL reserve the space for that text at all times so that the columns do not move when it appears or disappears.

### Requirement 9: States and unreadable files

**User Story:** As a person using the board, I want clear states when there is nothing to show or something is wrong, so that I know what to do next.

#### Acceptance Criteria

1. WHILE the page has received no plan and no error, or the latest answer is pending, THEN the page SHALL show "Loading…" and no columns. Once a plan or an error has been shown, the page SHALL NOT show "Loading…" again, and each later plan SHALL replace the board in place.
2. WHEN a plan has no cards in any group THEN the page SHALL show, in place of the columns, "No specs or epics were found on `<main branch>`." and a line saying that specs are read from `.kiro/specs/` and epics from `docs/epics/`.
3. WHEN the backend answers with an error THEN the page SHALL show no columns, SHALL show the error's message and code as text, and SHALL show each entry of the error's `settings` as code text, in order. WHEN a later plan arrives THEN the page SHALL remove the error in the same update that shows the plan.
4. WHEN a plan's `fetch.ok` is false THEN the page SHALL show, above the columns or the empty-plan text, a notice that the fetch failed and an earlier copy is shown, with the reason when there is one and the plan age worded as Requirement 8 words it, and the columns SHALL stay visible. WHEN a later plan arrives whose `fetch.ok` is not false THEN the page SHALL remove the notice in the same update.
5. IF a request fails or its answer cannot be read (Requirement 7, criterion 4) THEN the page SHALL keep a shown board unchanged and show above it the notice "Could not reach the backend. Showing the plan from the last update.", and when no plan has been shown SHALL show the error state with the text "Could not reach the backend." in place of an error message and no code. WHEN a later answer can be read THEN the page SHALL remove that notice or text in the same update.
6. WHEN a plan's `problems` list is not empty THEN the page SHALL show below the columns or the empty-plan text one disclosure, collapsed by default, with the summary "N files could not be read" ("1 file could not be read" for 1), and opening it SHALL list every problem's file and reason in the order the plan returns them, untruncated.

### Requirement 10: Theme and accessibility

**User Story:** As a person using Kiro Crew in a light or dark theme, I want the board to be readable in both and usable without a mouse or by a screen reader, so that nothing disappears or is out of reach.

#### Acceptance Criteria

1. THE page SHALL take its text and background colours from the host's theme, with no opaque colour (alpha 1, in any colour syntax, including a named colour) as a text colour or element background, SHALL draw borders, bar tracks, bar fills and tints in `currentColor` or a colour with an alpha greater than 0 and less than 1, and SHALL tell states apart by words and not by colour alone.
2. THE page SHALL give its title, the column headings and the group headings heading elements, with the column headings one level below the title, the group headings one level below the column headings and no level skipped in any state, and SHALL present the cards of each group as one list in the order of Requirement 2, criterion 2.
3. THE page SHALL give "Loading…", the failed-fetch notice and the unreachable-backend notice a `status` role, SHALL give the backend error and the "Could not reach the backend." error state an `alert` role, and SHALL give no other text an `alert` role.
4. THE disclosure summary SHALL be reachable by keyboard focus, SHALL show the browser's focus indicator, and SHALL toggle the disclosure on Enter or Space.
