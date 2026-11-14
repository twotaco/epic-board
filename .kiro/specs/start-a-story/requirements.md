# Requirements Document

## Introduction

This story is the third of the Epic Board epic (`docs/epics/epic-board.md`). It builds on "Read the plan from main" (`.kiro/specs/read-the-plan-from-main/`, "the first spec" below) and "Show the board" (`.kiro/specs/show-the-board/`, "the board spec" below), and does not restate them. The board shows the plan. This story lets the person start a Crew conductor on a story from its card, shows the state of that conductor's chat on the card, and opens the chat from the card.

The person clicks a Planned or In progress card that has no chat. The card asks "Start a conductor on this story?". On Start, the board opens a plain conductor chat in the project's Crew folder and sends it a brief. The brief depends on the story: when the story has no spec, the conductor writes the spec on a branch and opens a pull request; when it has a spec, the conductor builds the next task group and opens a pull request. The conductor never merges. The board only starts the chat. It does not run git, does not open pull requests and does not merge.

The board remembers which chat belongs to which card in a file in the app's own data folder. A card with a chat shows one of four states, read from Crew's own status fields with no language model: Working, Needs you, Interrupted or Idle. There is no "finished" state. Whether a story is done still comes only from main, as the first spec defines. The board never approves a tool call and never answers a question for the conductor. A card in the Needs you state links to the chat, where the person does that. Clicking a card that has a chat opens the chat, in any column.

Three criteria of the earlier specs were edited in place because this story changes them: the first spec's 8.4 (a card gains `id`) and the board spec's 1.2 and 1.3 (the page may now send the requests and show the controls named here). The board spec's introduction names this story and was edited to match. Every other rule of those specs still applies.

The page talks to two services. It reads and writes the board's own records through the backend, and it talks to Crew's chat endpoints through the host's `useAppApi`, which is limited to the paths in `permissions.api`. The backend never calls Crew.

## Glossary

- **Card_Id**: the card's `id` field (first spec, Requirement 8, criterion 4).
- **Crew_Folder**: a folder in Crew's chat sidebar whose project is the repository. Its id is set by the person (Requirement 1).
- **Chat_Record**: one entry of the board's own file of chats: a Card_Id, the name the board reserved, the key Crew gave the chat, a state and a creation time. A Chat_Record is `reserved` until the chat has been created and sent its brief, and `started` after.
- **Started_Chat**: a chat that has a `started` Chat_Record.
- **Chat_List**: the answer of `GET /api/chat/slots`, one row per chat Crew has open.
- **Card_State**: one of Working, Needs you, Interrupted, Idle.
- **Data_Folder**: `<KIROCREW_HOME>/apps/<KIROCREW_APP_NAME>/data`.

## Requirements

### Requirement 1: Settings, permissions and the data folder

**User Story:** As the person who sets up the board, I want starting stories to need one more setting and no more permission than it uses, so that the board stays safe to install.

#### Acceptance Criteria

1. WHEN the app starts THEN the backend SHALL take the Crew_Folder id from the environment variable `EPIC_BOARD_FOLDER` if it is set and not empty, and otherwise from the `folder_id` value in the `config.json` of the board spec's repository setting (first spec, Requirement 1, criterion 2). The first source that is present SHALL be used, and a bad value in it (not text, or only whitespace) SHALL NOT fall through to the next source and SHALL be reported as the folder not being set, with the reason. WHEN neither source gives a value THEN the folder is not set. The backend SHALL NOT take a folder id from a request.
2. THE repository setting SHALL keep working as the first spec says, and a missing or bad folder setting SHALL NOT change any answer of the `plan` route.
3. THE `permissions.api` of `app.json` SHALL list exactly `/api/chat` and `/api/chat/slots`, and `app.json` SHALL declare no other permission, in particular none of `sessionApproval`, `chatSlots`, `spawn`, `agentTurns`, `network` or `storage`. `app.json` SHALL keep its name, route, backend and platform declarations.
4. THE backend SHALL keep the Chat_Records in one file named `chats.json` in the Data_Folder, where `KIROCREW_HOME` defaults to `~/.kiro/crew` and `KIROCREW_APP_NAME` defaults to `epic-board` when the host does not set them. The backend SHALL create the Data_Folder when it first writes, and SHALL write nothing to the configured repository, to `config.json` or to the app's own folder.

### Requirement 2: Starting from a card

**User Story:** As a person planning a project, I want to click a story's card and be asked once whether to start a conductor on it, so that nothing starts by accident and starting is one step.

#### Acceptance Criteria

1. WHEN a card is in the Planned or In progress column and has no Started_Chat THEN the card's name SHALL be the label of one button, and a click anywhere on the card outside its own controls, or Enter or Space on that button, SHALL open the question of criterion 2 on that card.
2. THE question SHALL be shown on the card and SHALL read "Start a conductor on this story?" with a "Start" button and a "Cancel" button. THE page SHALL show the question on at most one card at a time, and opening it on a card SHALL close it on any other.
3. WHEN the person activates "Cancel", or presses Escape while focus is inside the question, THEN the page SHALL close the question and put focus on the card's button.
4. WHEN a card is in the Done column and has no Started_Chat THEN it SHALL have no button, no link and no other interactive element.
5. A card that has only a `reserved` Chat_Record (Requirement 4, criterion 6) SHALL be treated as a card with no Started_Chat.
6. IF the folder is not set (Requirement 1, criterion 1) THEN activating the card's button SHALL show, in place of the question, the text "No Crew folder is set for this project." with the names `EPIC_BOARD_FOLDER` and `folder_id` as code text, the reason when there is one, and a "Close" button, and SHALL start nothing. IF the board's file of chats cannot be read (Requirement 5, criterion 5) THEN it SHALL show the backend's message in the same way.
7. WHEN the person activates "Start" THEN the question SHALL be replaced by the progress and failure texts of Requirement 4.

### Requirement 3: The brief

**User Story:** As a person starting a conductor, I want the conductor to get a short, exact brief that fits the story's state, so that it does the right job and does not merge.

#### Acceptance Criteria

1. THE backend SHALL build the brief as plain text from the card, the epic file name and the main branch name only, with no language model, so that the same inputs give the same text. THE brief SHALL name the story as a quoted string, the epic file (`docs/epics/<file>`) or say that the story has no epic, the spec folder, and the main branch, and SHALL NOT include the story's description, any task text or any other text read from a file of the repository.
2. WHEN the card has no spec (`spec` is none in the plan the backend holds) THEN the brief SHALL tell the conductor to write the story's spec: `requirements.md`, `design.md` and `tasks.md` in `.kiro/specs/<folder>/`, in the project's usual spec format, where `<folder>` is the name Requirement 3, criterion 5 gives; to link the story's line in its epic page to the new folder when the story has an epic; to work on a branch named `story/<folder>` cut from `origin/<main branch>`, unless the project's `AGENTS.md` or steering says otherwise; and to open one pull request.
3. WHEN the card has a spec THEN the brief SHALL tell the conductor to read the spec's `requirements.md`, `design.md` and `tasks.md` and the epic page, to build only the first task group that has a task not yet ticked, to tick the tasks it finishes in the same branch, to run the checks the project's `AGENTS.md` or steering names, to work on a branch named `story/<spec folder>-g<N>`, where `<N>` is that task group's number, cut from `origin/<main branch>`, unless the project says otherwise, and to open one pull request. IF the spec has no tasks, THEN the brief SHALL tell the conductor to write `tasks.md` as the pull request's only change and not to build. IF every task is ticked, THEN the brief SHALL tell the conductor to change nothing and say so.
4. EVERY brief SHALL tell the conductor, in plain words: never to merge a pull request, never to push to the main branch, never to turn on auto-merge, to open exactly one pull request, to report the pull request's address in the chat when it is open and then stop, and to ask the person in the chat when it is blocked instead of guessing. A brief SHALL be at most 6,000 characters, and the story's name SHALL be cut to 200 characters in it.
5. THE name of a new spec folder SHALL be the story's name in lower case, with each run of characters other than ASCII letters and digits replaced by one hyphen, hyphens removed at both ends and the result cut to 60 characters (and again with hyphens removed at the end), or `story` when nothing is left. WHEN a spec folder of that name already exists in the plan THEN `-2`, `-3` and so on SHALL be added until the name is unused.

### Requirement 4: The start sequence

**User Story:** As a person starting a story, I want one click to open a conductor chat with its brief, and a failure to leave nothing half-done, so that I can try again without duplicates.

#### Acceptance Criteria

1. WHEN the person activates "Start" THEN the page SHALL ask the backend to reserve a chat for the card by its Card_Id, and the answer SHALL give the name to use, the brief and the Crew_Folder id.
2. THE backend SHALL refuse the reservation, and the page SHALL show the reason on the card, when: the plan the backend holds has no card with that Card_Id (409 `card_not_found`); the card is Done (409 `card_done`); the card already has a Started_Chat (409 `chat_exists`); the folder is not set (409 `folder_not_set`); the file of chats cannot be read (Requirement 5, criterion 5); or the backend holds no plan yet (409 `plan_not_ready`). A refusal SHALL change no record.
3. WHEN the reservation is made THEN the page SHALL create the chat with `POST /api/chat/slots` and a body of the name, the agent `kirocrew-conductor` and the Crew_Folder id and no other field (the host's client adds its own `embed_app` field), and SHALL read the chat's `key` from the answer.
4. WHEN the chat exists THEN the page SHALL send the brief to it with `POST /api/chat`, as the message of a body naming the chat's `key` as `slot`, unless the chat's row from the create answer already shows that it holds a message (`messages` is greater than 0), in which case the page SHALL NOT send it again.
5. WHEN the brief is sent THEN the page SHALL tell the backend that the chat has started, giving the chat's `key`, and the backend SHALL make the Chat_Record `started` with that key.
6. WHILE the sequence runs THEN the card SHALL show "Starting…" and no button, and SHALL start no second sequence. IF any step fails THEN the page SHALL show on the card which step failed (reserving, creating the chat, sending the brief or saving) and the reason, and SHALL offer the question again. A Chat_Record SHALL stay `reserved` until the last step succeeds. A new reservation for a card with a `reserved` Chat_Record SHALL return that record's name with a freshly built brief and SHALL NOT make a second record.
7. WHEN the last step succeeds THEN the card SHALL show a link to the chat at once (Requirement 7), and the page SHALL read the chat's state at once (Requirement 6, criterion 7).
8. THE board SHALL NOT run git, open a pull request, merge, or change the repository in any way. THE page SHALL send, for a start, only the requests of criteria 1, 3, 4 and 5, and the backend SHALL send none.

### Requirement 5: Remembering chats

**User Story:** As a person who starts stories over days, I want the board to remember which chat belongs to which story, so that the cards still show their chats after I close the page or Crew restarts.

#### Acceptance Criteria

1. THE file `chats.json` SHALL hold a list of Chat_Records of the form `{"card_id", "name", "key", "state", "created"}`, where `state` is `reserved` or `started`, `key` is none until the record is `started`, and `created` is a UTC time in ISO 8601. A record SHALL hold no brief, no plan text and no text from the chat.
2. THE backend SHALL change the file by writing the whole new content to a temporary file in the Data_Folder and replacing the file with it, and SHALL serialize its changes, so that a stop at any moment leaves the old or the new content and never a part. The file SHALL hold at most one record for a Card_Id.
3. WHEN the backend restarts THEN it SHALL read the file again at its first use, so that a Started_Chat is still a Started_Chat. A missing file SHALL mean no records.
4. THE backend SHALL answer `GET .../chats` with `{"folder_id": <text or none>, "folder_reason": <text or none>, "chats": [...]}`, where `chats` holds one `{"card_id", "name", "key", "created"}` for each `started` record, in the order of their creation.
5. IF the file exists but cannot be read as the form of criterion 1 THEN every `chats` route SHALL answer 500 with the error code `chats_unreadable` and a message naming the file, SHALL read nothing from it and write nothing to it, and the backend SHALL leave the file as it is.
6. THE backend SHALL offer these routes under the app's route prefix, matched on the end of the path as the first spec's routes are: `GET /chats`, `POST /chats` with `{"card_id"}` (reserve), `POST /chats/<name>/started` with `{"key"}`, and `DELETE /chats/<name>` (remove the record of that name, `reserved` or `started`; 404 `chat_not_found` when there is none). A `started` call for a name that has no record SHALL answer 404 `chat_not_found`, and for a record that is already `started` SHALL answer 409 `chat_exists` unless the key is the same, which SHALL answer 200.
7. EVERY request to a `chats` route SHALL carry a valid gateway signature in `X-KiroCrew-Proxy`, as the host's documentation defines it. A request without a valid signature SHALL answer 401 `unauthorized` and SHALL read and change nothing. WHEN the backend has no `KIROCREW_PROXY_SECRET` THEN every `chats` route SHALL answer 503 `proxy_secret_missing`. The `plan` and `health` routes SHALL stay as they are.
8. A request body SHALL be at most 4,096 bytes and a JSON object with the fields named in criterion 6 and no others, a `card_id` of 1 to 400 characters, and a `name` and `key` made only of ASCII letters, digits, `.`, `_` and `-`, 1 to 193 characters. Anything else SHALL answer 400 `invalid_request` and change nothing. THE name the backend reserves SHALL be `epic-board-` and 8 lower-case hexadecimal characters from a secure random source, and SHALL NOT repeat a name in the file.
9. THE backend SHALL NOT make any request to Crew, and SHALL NOT read a card, a plan or a repository for any route except `POST /chats`, which reads the plan it holds.

### Requirement 6: The state of a chat on its card

**User Story:** As a person with several conductors running, I want each card to say whether its chat is working, needs me, was interrupted or is idle, so that I know where to look without opening every chat.

#### Acceptance Criteria

1. THE page SHALL read the Chat_List with `GET /api/chat/slots` and SHALL keep only the rows whose `key` is the key of a Started_Chat. EVERY other row SHALL be ignored: it SHALL NOT be shown, counted or used for any state.
2. THE page SHALL give each Started_Chat found in the Chat_List exactly one Card_State, the first that applies:
   - **Needs you**: `pending_approval` is true or `needs_input` is true;
   - **Working**: `running` is true or `admission_queued` is true;
   - **Interrupted**: `interrupted` is true, or the chat's last row has the role `error` (criterion 3);
   - **Idle**: anything else.

   A turn that waits for an approval or an answer is still running, so Needs you comes before Working.
3. WHEN a Started_Chat's row is neither Needs you nor Working and has `interrupted` false THEN the page SHALL read the chat's last row with `GET /api/chat/slots/<key>?limit=1` and use its `role`. WHEN the row's `last_ts` and `messages` have not changed since the page last read that chat, THEN the page SHALL reuse the earlier answer and make no request.
4. THE page SHALL show the Card_State on the card as one of the words "Working", "Needs you", "Interrupted" and "Idle", so that the states are told apart by their words and not by colour alone. A card in any column that has a Started_Chat SHALL show its state, once the page has read it.
5. THE page SHALL have no "finished" or "done" chat state, and a Card_State SHALL NOT move a card between columns or change its progress. THE column of a card SHALL come only from the plan, as the first spec says.
6. THE page SHALL NOT approve, reject or answer anything for a chat, SHALL NOT call any `approve`, `question` or `approvals` route, and SHALL NOT read or show the text, title or preview of any chat row.
7. WHILE the page is visible THEN the page SHALL read the Chat_Records from the backend (Requirement 5, criterion 4) and, when there is at least one Started_Chat, the states (the Chat_List, and the reads of criterion 3 that are due), once at once, and again 5 seconds after a read ends when any shown state is Working or Needs you or any chat is restoring (Requirement 8), and 15 seconds after it ends otherwise. THE page SHALL have at most one such read in flight, SHALL send none while it is hidden, and SHALL read at once when it becomes visible. A read, however many requests it makes, SHALL end as a failure 10 seconds after it starts.
8. IF a read fails (the connection fails, a request times out, an answer cannot be read, or Crew answers with an error other than the 404 of Requirement 8) THEN the page SHALL keep the states it shows and show above the columns the notice "Could not read chat status. Showing the last known states.", and SHALL try again after 15 seconds. WHEN a later read succeeds THEN the page SHALL remove the notice in the same update.
9. WHILE the chat reads fail or have not ended yet THEN the plan, its columns and its polling SHALL work as the board spec says, and a card with a Started_Chat SHALL show its link (Requirement 7) and no state.

### Requirement 7: Opening a chat

**User Story:** As a person who started a story, I want to click its card to get to its chat, so that I can read what the conductor did or answer what it asked.

#### Acceptance Criteria

1. WHEN a card has a Started_Chat THEN the card's name SHALL be the text of one link whose address is `/chat?sid=` followed by the chat's key, percent-encoded, and a click anywhere on the card outside its own controls, or Enter on that link, SHALL follow it. THE link SHALL carry no token, no credential and no other query field.
2. THE link SHALL be present on a card in every column, including Done, and SHALL be the card's only control except in the cases of Requirement 8.
3. A card with a Started_Chat SHALL NOT offer the question of Requirement 2, whatever its column.
4. WHEN a Started_Chat is shown as restoring or not open (Requirement 8) THEN the card SHALL show no link until the chat is back in the Chat_List.

### Requirement 8: A chat that is not open

**User Story:** As a person who restarts Crew, I want the board to give a chat time to come back and then offer to resume it, so that a restart does not strand my stories.

#### Acceptance Criteria

1. WHEN a Started_Chat's key is not in the Chat_List THEN the page SHALL read `GET /api/chat/slots/<key>?limit=1`. WHEN Crew answers 404 THEN the chat is missing. WHEN Crew answers with a chat THEN the page SHALL show "Working" when its `running` or `admission_queued` is true, otherwise "Interrupted" when its last row has the role `error`, and otherwise "Idle". Any other answer or failure SHALL be handled as Requirement 6, criterion 8 says.
2. WHILE a chat has been missing for less than 60 seconds THEN its card SHALL show "Restoring chat…" in place of a state. The 60 seconds SHALL be counted by the page from the first read in a run of reads that found the chat missing, and SHALL start again after a read that finds the chat present.
3. WHEN a chat has been missing for 60 seconds or more THEN its card SHALL show "This chat is not open." and a "Resume chat" button.
4. WHEN the person activates "Resume chat" THEN the page SHALL send `POST /api/chat/slots/<key>/resume` with no other fields and show "Resuming…" on the card. WHEN Crew answers with success THEN the page SHALL read the states at once. IF Crew refuses or the request fails THEN the card SHALL show "The chat could not be resumed." with the reason and a "Start again" button.
5. WHEN the person activates "Start again" THEN the page SHALL ask the backend to remove that record, and WHEN it is removed SHALL show the question of Requirement 2 on the card.
6. THE page SHALL NOT stop, close or delete a chat in Crew.

### Requirement 9: Theme, accessibility and failures

**User Story:** As a person using Kiro Crew in a light or dark theme, I want the new controls to be readable and usable by keyboard and screen reader, so that starting a story is as accessible as reading the board.

#### Acceptance Criteria

1. THE new elements SHALL follow the board spec's Requirement 10, criterion 1: no opaque colour as a text colour or element background, borders and tints in `currentColor` or a colour with an alpha above 0 and below 1, and states told apart by words.
2. THE texts "Starting…", "Restoring chat…", "This chat is not open.", "Resuming…", a failure of a start or a resume, and the notice of Requirement 6, criterion 8 SHALL have the role `status`. NO new text SHALL have the role `alert`.
3. EVERY control this story adds (the card's button, "Start", "Cancel", "Close", the link, "Resume chat" and "Start again") SHALL be reachable by keyboard, SHALL show the browser's focus indicator and SHALL act on Enter or Space for a button and Enter for a link.
4. THE page SHALL show every text it takes from the plan, the backend or Crew as literal text and not as HTML or Markdown, and SHALL build the link of Requirement 7 only from the percent-encoded key.
5. THIS story SHALL add no heading element, and the heading levels of the board spec's Requirement 10, criterion 2 SHALL hold in every state, including a card with the question open.
6. A failure of a chat request SHALL NOT change the plan the page shows, and a failure of a plan request SHALL NOT change the chat states the page shows.
