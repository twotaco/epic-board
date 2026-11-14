# Requirements Document

## Introduction

This story is the fourth of the Epic Board epic (`docs/epics/epic-board.md`). It builds on "Show the board" (`.kiro/specs/show-the-board/`, "the board spec" below) and "Start a story" (`.kiro/specs/start-a-story/`, "the start spec" below), and does not restate them. The start spec puts a started story's chat on its card as a link, which leaves the board. A conductor that waits for a tool approval or an answer therefore sends the person away from the board to Crew's chat page and back.

This story opens the chat beside the board instead. The board mounts Crew's own chat component, `ChatPanel`, which the host offers to apps in `window.__kirocrew_modules['@kirocrew/app-sdk']`. The person reads the conductor, approves its tool calls, answers its questions and steers it in that panel, and the board stays where it was. On a wide screen the panel sits to the right of the columns. On a narrow screen it covers the board and a "Close" button returns to it. Only one chat is open at a time, because Crew's documentation says that two `conversationOnly` panels fight over the session. The card whose chat is open is marked. Starting a story opens its chat as soon as the chat is saved. A host without `ChatPanel` keeps the link of the start spec.

The board's own code still never approves or answers anything. The embedded chat is Crew's component, and it sends the person's approvals and answers as the person. The start spec's Requirement 6, criterion 6 says so, and its Requirement 7 says what a click on a card does, which this story changed: criteria 1, 5 and 6 of Requirement 7, criterion 6 of Requirement 6 and the start spec's introduction were edited in place. The board spec's criteria 1.2 and 1.3 were edited in place too, because the panel adds a button and Crew's own requests to the page. Every other rule of those specs still applies.

The permissions the panel needs were checked in Crew 0.12.2's source: `ChatPanel` shows the chat through the host's own client and not through the app's scoped `useAppApi` client, so it needs no `permissions.api` entry, and this story adds none (Requirement 1, criterion 7).

## Glossary

- **Chat_Panel**: the component `ChatPanel` of `window.__kirocrew_modules['@kirocrew/app-sdk']`.
- **Panel**: the region of the page that holds one Chat_Panel and the "Close" button.
- **Open_Card**: the card whose Started_Chat is shown in the Panel. There is at most one.
- **Started_Chat**, **Card_Id** and **Chat_Record**: as the start spec defines them.
- **Area**: the box that holds the board and the Panel. It is the width the page has, which the host decides.
- **Wide** and **Narrow**: the Area is Wide when it is at least 1,000 CSS pixels wide, and Narrow otherwise.

## Requirements

### Requirement 1: Crew's chat inside the board

**User Story:** As a person with a conductor running, I want its chat to be Crew's own chat, so that approving, answering and steering work as they do everywhere else in Crew.

#### Acceptance Criteria

1. THE page SHALL look for `ChatPanel` in `window.__kirocrew_modules['@kirocrew/app-sdk']` inside the component, as the start spec's design says it looks for `useAppApi`, and SHALL treat the host as providing a chat panel only when the value is a function or an object with a `$$typeof` field. A missing module, a missing value or any other value SHALL mean that the host provides none, and SHALL NOT raise an error or show a message.
2. WHEN the page shows a chat THEN it SHALL mount `<ChatPanel slotKey={key} conversationOnly />` with the chat's `key` and no other prop.
3. THE page SHALL have at most one Chat_Panel mounted at any time, in either layout, and SHALL show another chat by giving that one Chat_Panel another `slotKey`.
4. THE page SHALL open the Panel only on the `key` of a Started_Chat that the page holds a Chat_Record for at that moment, and SHALL pass no other key to the Chat_Panel. A chat that has no Chat_Record, and a card that has only a `reserved` Chat_Record, SHALL never be shown.
5. IF the host provides no chat panel THEN the page SHALL show no Panel and no "Close" button, and a card SHALL work as the start spec's Requirement 7, criterion 6 says.
6. IF the Chat_Panel throws while the page draws it THEN the page SHALL show in the Panel, in its place, the text "The chat could not be shown here." with the role `status` and a link to the chat (the start spec's Requirement 7, criterion 1), SHALL keep the "Close" button, and SHALL leave the board and its polling as they are. WHEN the person opens another chat THEN the page SHALL try the Chat_Panel again.
7. THE `permissions.api` of `app.json` SHALL stay as the start spec's Requirement 1, criterion 3 says, and this story SHALL add no entry and no other permission. THE Chat_Panel reads and sends through the host's own client, as the person, so it needs none.
8. THE page's own code SHALL send no request for the Panel. Every request the Chat_Panel makes is made by Crew's component (the board spec's Requirement 1, criterion 2).

### Requirement 2: Opening, switching and marking

**User Story:** As a person with several conductors, I want to move between their chats from the cards and see which one I am in, so that I always know whose questions I am answering.

#### Acceptance Criteria

1. WHEN the person opens the chat of a card (the start spec's Requirement 7, criterion 5) THEN the Panel SHALL show that chat, and the card SHALL be the Open_Card.
2. WHEN a chat is open and the person opens the chat of another card THEN the Panel SHALL show the other chat in place of the first, and SHALL show no more than one Open_Card, so that the first card stops being marked in the same update.
3. WHEN the person opens the chat of the Open_Card again THEN nothing SHALL change: the Panel stays open on the same chat and the Chat_Panel is not given a new `slotKey`.
4. THE Open_Card SHALL be marked by the words "Chat open" as text in the card, by `aria-current="true"` on the card's link, and by a border in `currentColor` that is thicker than the border of the other cards, so that the mark does not rely on colour. No other card SHALL be marked, and no card SHALL be marked while the Panel is closed.
5. THE Panel SHALL show, above the Chat_Panel, the Open_Card's name as plain text, next to the "Close" button.
6. WHEN the page removes the Open_Card's Chat_Record (the start spec's Requirement 8, criterion 5, "Start again") THEN the page SHALL close the Panel. Nothing else SHALL close the Panel except the "Close" button and a new open: in particular a chat that is restoring or not open (the start spec's Requirement 8), a read that fails, and a read of the records that does not list the chat SHALL NOT close it. The Chat_Panel shows what Crew says about the chat and the card shows its own text.
7. THE page SHALL NOT remember an open chat when it is closed or reloaded: it SHALL open with the Panel closed.

### Requirement 3: Layout

**User Story:** As a person using the board on a wide monitor or a narrow window, I want the chat beside the board when there is room and over it when there is not, so that I can read the chat and still reach the board.

#### Acceptance Criteria

1. WHILE the Area is Wide and a chat is open THEN the Panel SHALL sit to the right of the columns, from the top to the bottom of the Area, and the board SHALL stay shown to its left. The board SHALL scroll on its own and the Panel SHALL scroll on its own. The cards of the board SHALL stay visible and be usable, and the plan and the chats SHALL keep updating.
2. WHILE the Area is Narrow and a chat is open THEN the Panel SHALL cover the whole Area and the board SHALL be neither visible, nor reachable by keyboard, nor exposed to a screen reader. The board SHALL stay mounted, so that its polling goes on and its scroll position is the same when it comes back.
3. WHILE a chat is open, in either layout, THE Panel SHALL have a button "Close". WHEN the person activates it THEN the Panel SHALL close, no card SHALL be marked, and the board SHALL show in the whole Area.
4. WHEN the width of the Area changes while a chat is open THEN the layout SHALL change with it, and the Chat_Panel SHALL stay mounted on the same chat, with the draft the person was typing.
5. WHILE no chat is open THEN the board SHALL be drawn exactly as the start spec draws it, with no empty Panel and no space kept for one.

### Requirement 4: Focus

**User Story:** As a person who uses the keyboard, I want focus to follow me into the chat and back to the card, so that I do not lose my place on the board.

#### Acceptance Criteria

1. WHEN the Panel opens, or shows another chat, THEN focus SHALL move to the Panel's own container, which SHALL have `tabindex="-1"` and an accessible name that includes the Open_Card's name, so that the next Tab reaches the "Close" button.
2. WHEN the person activates "Close" THEN focus SHALL move to the link of the card that was the Open_Card, found by its `data-card-id`, once the board is shown. IF that card has no link at that moment (its chat is restoring or not open, or its record is gone) THEN the page SHALL move focus nowhere.
3. WHEN the Panel closes because the page removed the chat's record (Requirement 2, criterion 6) THEN the page SHALL move focus nowhere.

### Requirement 5: Starting a story

**User Story:** As a person starting a story, I want its chat to open beside the board as soon as it exists, so that I can see the conductor begin and answer it at once.

#### Acceptance Criteria

1. WHEN a start's chat is saved (the start spec's Requirement 4, criteria 4 and 7) and the host provides a chat panel THEN the Panel SHALL show that chat at once, without waiting for the brief to be sent or for the next read of the states, and the card SHALL be the Open_Card. A chat that is open on another card SHALL be replaced, as Requirement 2, criterion 2 says.
2. THE card SHALL keep the notes of the start spec's Requirement 4, criterion 9 ("Sending the brief…", and "The brief was not sent" with its button), whether or not the Panel shows its chat.
3. IF a start fails before its chat is saved THEN the Panel SHALL stay as it was.
4. IF the host provides no chat panel THEN a start SHALL end as the start spec says, with the card showing its link.

### Requirement 6: Theme, accessibility and failures

**User Story:** As a person using Kiro Crew in a light or dark theme, I want the panel's controls to be readable and usable by keyboard and screen reader, so that working in the chat is as accessible as reading the board.

#### Acceptance Criteria

1. THE new elements SHALL follow the board spec's Requirement 10, criterion 1: no opaque colour as a text colour or element background, borders and tints in `currentColor` or a colour with an alpha above 0 and below 1, and states told apart by words. THE Chat_Panel draws itself with the host's theme.
2. THE Panel SHALL be an `aside` element with an `aria-label` that names the chat and the Open_Card, SHALL add no heading element, and SHALL leave the heading levels of the board spec's Requirement 10, criterion 2 as they are in every state.
3. THE "Close" button SHALL be reachable by keyboard, SHALL show the browser's focus indicator and SHALL act on Enter and Space. NO new text SHALL have the role `alert`.
4. THE page SHALL show every text it takes from the plan or the backend, here the Open_Card's name, as literal text and not as HTML or Markdown.
5. A failure inside the Panel SHALL NOT change the plan or the chat states the page shows, and a failure of a plan or chat request SHALL NOT close the Panel or change its chat.
6. THE page SHALL add no dependency and no build step.
