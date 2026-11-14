# Requirements Document

## Introduction

This story is the fifth of the Epic Board epic (`docs/epics/epic-board.md`). It builds on "Show the board" (`.kiro/specs/show-the-board/`, "the board spec"), "Start a story" (`.kiro/specs/start-a-story/`, "the start spec") and "Work in the chat" (`.kiro/specs/work-in-the-chat/`, "the chat spec"), and does not restate them. Those specs say what the board shows and does. This story changes how it looks, so that the board reads as part of Kiro Crew.

The page draws its own markup and its own style sheet today. This story has it use Crew's own components where Crew has them, from `window.__kirocrew_modules['@kirocrew/ui']`: `Btn` for buttons, `Card` and `CardTitle` for cards, `Badge` for the chat state words and the task progress, `PageHeader` for the header, `EmptyState` for an empty plan and `ErrorNotice` for the two error states. The page looks that module up the way it looks up React, and any component it does not find is drawn as the page draws it today. The column headers copy the look of the board in Crew's Sessions sidebar: a status dot, the name in capitals and the count on the right. Card titles are bold, the lines that describe a card are quieter, and a description is cut to three lines. The light and dark themes come from Crew's components and from the host's theme tokens, and the page keeps no colour of its own except what the fallbacks need.

Crew's Sessions board is not an exported component, so its look is matched from its source in Crew 0.12.2 (`website/src/pages/chat-sidebar/boardLane.tsx`) and the page does not reach into Crew's internals. Every size and weight comes from a Crew component or from that source, as the design's table names.

This story changes what the page looks like and nothing it says or does: every text, role, heading level, control, request and poll of the three specs above stays. Where it must change a rule of those specs, the rule was edited in place: the board spec's criteria 3.1, 8.3 and 10.1, the chat spec's design for the panel's button and the mark of the open card, and the epic page. Every other rule of those specs still applies.

## Glossary

- **Crew_Kit**: the object found at `window.__kirocrew_modules['@kirocrew/ui']`.
- **Kit_Component**: one of `Btn`, `Card`, `CardTitle`, `Badge`, `PageHeader`, `EmptyState` and `ErrorNotice` of the Crew_Kit that is a component, as Requirement 1, criterion 2 defines.
- **Fallback**: the markup the page draws for a component it did not find. It is the markup of the earlier specs.
- **Theme_Token**: a CSS custom property of the host's theme that Crew's own style sheet defines, for example `--border`, `--muted` and `--accent`.
- **Card_Id**, **Started_Chat**, **Card_State** and **Open_Card**: as the earlier specs define them.

## Requirements

### Requirement 1: Crew's components, found like React

**User Story:** As a person using Kiro Crew, I want the board built from Crew's own components, so that it looks and behaves like the rest of Crew, and I want it to keep working on a host that lacks them.

#### Acceptance Criteria

1. THE page SHALL read the Crew_Kit inside the component, as `window.__kirocrew_modules['@kirocrew/ui']`, the way it reads `useAppApi` and `ChatPanel`, so that importing the module needs no `window`. A missing `window`, a missing module or a module that is not an object SHALL mean an empty Crew_Kit, and SHALL NOT raise an error or show a message.
2. THE page SHALL use a Kit_Component only when the Crew_Kit's value for its name is a function or an object with a `$$typeof` field. Any other value, including a missing one, SHALL mean that component is missing. Each of the seven SHALL be decided on its own, so that a host with some of them gets those and the Fallback for the rest.
3. WHEN a Kit_Component is missing THEN the page SHALL draw its Fallback, which SHALL have the markup, roles, texts and behaviour that the board spec, the start spec and the chat spec give today.
4. THE page SHALL pass to a Kit_Component only the props that the design names for it, and SHALL NOT pass a class name that Crew's style sheet may lack, because an app's own markup cannot add Tailwind utilities to the host's style sheet.
5. THE page SHALL import nothing, SHALL add no dependency and no build step, and SHALL show every text it takes from the plan, the backend or Crew as literal text in a Kit_Component as it does in a Fallback.
6. THIS story SHALL NOT change any text, role, heading level, control, request or poll of the earlier specs, except the three changes of what is drawn that this spec names: a description cut to three lines (Requirement 3, criterion 4), the header's branch, commit and age on one line (Requirement 4, criterion 1) and the column's box, dot and capitals (Requirement 2).

### Requirement 2: Column headers like Crew's Sessions board

**User Story:** As a person who also uses Crew's Sessions board, I want the columns of this board to look the same, so that I read them without learning a new layout.

#### Acceptance Criteria

1. THE page SHALL draw each column as a box with a border, rounded corners and Crew's card background, and its header as a bar at the top of the box with a border under it and Crew's elevated background, as the design's table gives them.
2. THE header SHALL hold, from left to right: a status dot, the column's name in capital letters, and the number of cards at the right. THE dot SHALL be decorative (`aria-hidden`) and a circle of the size the design gives.
3. THE dot SHALL take its colour from a Theme_Token: `--muted` for Planned, `--accent` for In progress and `--ok` for Done. THE name SHALL be drawn in capitals by the style sheet, so that its text and accessible name stay "Planned", "In progress" and "Done".
4. THE header's heading element and its level SHALL stay as the board spec's Requirement 10, criterion 2 gives them (one level below the title), with the name and the count inside it, and the count SHALL keep its text. A column with no cards SHALL show "Nothing here" as the board spec says.
5. THE group headings SHALL stay heading elements one level below the column headings, and SHALL be drawn in the size and weight of Crew's section labels (the design's table), without a colour of their own.

### Requirement 3: Cards

**User Story:** As a person reading the board, I want card titles that stand out and details that stay in the background, so that I find a story at a glance.

#### Acceptance Criteria

1. WHEN the page has `Card` THEN it SHALL draw each card as a `Card` inside its list item, and the card SHALL keep what the earlier specs put on a card (`data-mode`, `data-open`, `data-card-id` on its main control, the stretched link, and the controls above it). WHEN it has not THEN it SHALL draw the Fallback card.
2. THE card's name, with its button or link, SHALL be drawn with `CardTitle`'s look: bold, in Crew's strong text colour. WHEN the page has `CardTitle` THEN the element it draws SHALL be marked `role="presentation"`, so that it adds no heading and the heading levels of the board spec's Requirement 10, criterion 2 hold in every state.
3. THE card's meta lines SHALL be quieter than its name and description: the spec folder name, in Crew's monospace face, "No spec yet", "No tasks yet", "Tasks could not be read" and the mark "Chat open" SHALL be drawn in the size and muted colour the design gives.
4. THE card's description SHALL be cut to three lines by the style sheet. The page SHALL offer no control to show the rest, SHALL NOT shorten the text itself, and SHALL keep the whole text in the page, so that a screen reader reads all of it.
5. WHEN a card has a spec and its task total is greater than 0 THEN the page SHALL show "`<done>` of `<total>` tasks" in a `Badge` when the page has one, followed by the bar the board spec's Requirement 3, criterion 4 describes. THE bar SHALL stay hidden from assistive technology, and SHALL be drawn with Theme_Tokens in place of a grey of the page's own.
6. WHEN a card has a Started_Chat and its state has been read THEN the page SHALL show the state word in a `Badge` when the page has one, keeping the word and its `data-state`. THE variants SHALL be: Needs you `warn`, Working `ok`, Interrupted `err` and Idle `muted`. States SHALL stay told apart by their words and not by the colour alone.
7. THE page SHALL draw every button that the earlier specs give a card, the panel or an error state with `Btn` when the page has one: "Start" as `primary`, and "Cancel", "Close", "Resume chat", "Start again" and "Send the brief again" as plain. A `Btn` SHALL keep the button's text, `type="button"`, handler, keyboard behaviour and focus indicator, and SHALL NOT be `busy`.
8. THE card's inset, margin and radius SHALL be those of `Card`, except that the page SHALL remove `Card`'s bottom margin inside a list, where the list's own gap spaces the cards.
9. THE mark of the Open_Card SHALL be drawn with the card's border colour set to `currentColor` and a one-pixel ring in `currentColor` around it, and SHALL NOT change the card's padding.

### Requirement 4: Header, empty and error states

**User Story:** As a person opening the board, I want the header and the empty and error states to look like Crew's own, so that nothing on the page looks foreign.

#### Acceptance Criteria

1. WHEN the page has `PageHeader` THEN it SHALL draw the header with it: the title "Epic Board" as the title, as the heading element and level of the board spec's Requirement 10, criterion 2, the subtitle as one line of text made of the main branch name, the first 7 characters of the commit and the plan age worded as the board spec's Requirement 8, criterion 2 words it, separated by " · ", and "Checking for updates…" in the actions, in an element that is always in the page and is hidden while `refreshing` is false, so that the columns do not move (the board spec's Requirement 8, criterion 3).
2. THE page's body (the notices, the columns, the empty-plan text and the disclosure) SHALL take the same left and right gutter as `PageHeader`, so that the title shares its left edge with the cards, as Crew's own pages do.
3. WHEN a plan has no cards and the page has `EmptyState` THEN it SHALL draw "No specs or epics were found on `<main branch>`." as the empty state's title and the line about `.kiro/specs/` and `docs/epics/` as its subtitle, with an icon from `window.__kirocrew_modules['lucide-react']` when the host has one and no icon when it has not.
4. WHEN the page has `ErrorNotice` THEN it SHALL draw the backend error with it, with the error's message as the notice's message and the code and the `settings` entries (as code text, in order) inside it, and SHALL draw "Could not reach the backend." with it. THE page SHALL NOT turn on the notice's agent hand-off, and the two notices SHALL keep their `alert` role.
5. THE notices that have the role `status` (the failed fetch, the unreachable backend, the chat status and the start and resume failures, the brief's notes, "Loading…") SHALL keep the page's own markup and role, because `ErrorNotice` has the role `alert`, and SHALL be drawn with Theme_Tokens and `currentColor` only.
6. THE problems disclosure SHALL stay a native `details` with a `summary`, drawn with Theme_Tokens and `currentColor` only.

### Requirement 5: Theme, sizes and failures

**User Story:** As a person using Kiro Crew in a light or dark theme, I want the board to follow the theme without any colour of its own, so that it never clashes with the rest of Crew.

#### Acceptance Criteria

1. THE page's style sheet SHALL contain no colour literal (no hex colour, no `rgb()`, `rgba()`, `hsl()` or `color-mix()` and no named colour other than `transparent` and `currentColor`) outside the rules of the Fallbacks. A colour SHALL be `currentColor`, `inherit` or a Theme_Token in `var()`, with `currentColor` as the second argument of `var()`, so that a host that lacks the token still draws the element.
2. THE rules of the Fallbacks SHALL be the only place where the style sheet holds a grey of its own (`rgba(128, 128, 128, a)` with `a` above 0 and below 1), and SHALL apply only to elements that carry the Fallback marker class, so that a Kit_Component is never drawn over one.
3. THE page SHALL NOT detect the theme and SHALL NOT read the host's theme hook: the components and the Theme_Tokens follow it.
4. THE page SHALL use no size, weight, radius or letter spacing other than those the design's table names, and SHALL leave a size alone when no Crew component or Crew source gives it.
5. NO rule SHALL remove a focus indicator, and every control of the earlier specs SHALL keep the browser's or Crew's focus indicator and its keyboard behaviour.
6. A Kit_Component that throws while the page draws it SHALL NOT be caught by the page: the host's own error handling applies, as for any component the page draws.
