# Implementation Plan

## Overview

The work is five task groups. Each group is one pull request on its own branch, named `story/start-a-story-g1` to `story/start-a-story-g5` (group 5 is `story/start-a-story-send-after-save`), cut from the latest main after the previous group's pull request is merged. Each group lands green on its own and leaves the app working. Every group ends with a sub-task that runs the tests and reports the counts run, passed and skipped. Tick each task in this file in the same branch, and tick nothing in the earlier specs (`.kiro/specs/read-the-plan-from-main/`, `.kiro/specs/show-the-board/`). The backend adds no dependency, and neither does the page.

Start this story after the "Show the board" story has landed on main, because group 3 changes files and tests that story created (`ui/index.mjs`, `tests/ui/render.test.mjs`, `tests/ui/board.test.mjs`, `tests/test_ui.py`).

Group 1 is all backend and changes nothing the page uses except an added `id` on each card. Group 2 is the page's logic, with no change to what the page draws. Group 3 draws the controls, wires the second poller and adds the permissions to `app.json`. Group 4 checks the whole on throwaway data and on the host. Group 5 was added after the first try on the host: it changes the order of a start so that the chat is saved before its brief is sent, and it supersedes the order that tasks 2.8, 2.9 and 3.3 describe (those tasks stay ticked as the record of what was built first). Task 4.2 is run again after group 5.

## Tasks

- [x] 1. Backend: card ids, settings, signature, brief, store and routes
  - [x] 1.1 Add `id` to every card in `backend/plan.py`
    - Add `add_ids(groups)` and call it last in `build_plan`: `f"{epic['file']}#{card['name']}"` for a group with an epic, `f"#{card['name']}"` for the "No epic" group
    - Do not change `card()`, `story_card()` or their callers
    - Add cases to `PlanTests` in `tests/test_plan.py`: an epic card, a card with no spec, a "No epic" card, a spec listed in two epics (two different ids), and the same id before and after a story gains its spec (the story's name and epic are unchanged)
    - Check that the existing tests in `tests/test_plan.py` still pass unchanged
    - _Requirements: first spec 8.4_
  - [x] 1.2 Write `backend/proxyauth.py` and `tests/test_proxyauth.py`
    - `verify(header, *, method, target, body, secret, now)` as the design says: `<digits>:<hex>`, the message `timestamp:method:target:sha256(body)`, HMAC-SHA256, within 60 seconds, `hmac.compare_digest` on bytes encoded with `surrogatepass`; any malformed input gives `False` and never raises
    - Test with signatures computed in the test: valid; one second inside and outside the window, in the past and the future; wrong method; wrong target (with a query); altered body; empty body; empty secret; empty header; no colon; non-digit timestamp; empty signature; a signature with a non-ASCII character or a lone surrogate
    - _Requirements: 5.7_
  - [x] 1.3 Add `load_folder` and `data_dir` to `backend/server.py`
    - `load_folder(environ, app_dir)` returns `(folder_id or None, reason or None)` with the first-source-wins rule of Requirement 1.1: `EPIC_BOARD_FOLDER`, then the `folder_id` of `config.json`; a non-text or blank value is "not set" with a reason and does not fall through; it never raises and does not change `load_repository`
    - `data_dir(environ)` returns `<KIROCREW_HOME>/apps/<KIROCREW_APP_NAME>/data` with the defaults `~/.kiro/crew` and `epic-board`
    - Add tests to `tests/test_server.py` in a new class (leave `LoadRepositoryTests` unchanged): each source, both set (environment wins), a bad environment value not falling through, a bad `folder_id`, an unreadable `config.json`, no setting, and the data folder with and without the two environment variables
    - _Requirements: 1.1, 1.2, 1.4_
  - [x] 1.4 Write `slugify`, `build_brief` and `find_card` in `backend/chats.py`
    - `slugify(name, taken)` as Requirement 3.5 and the design say
    - `build_brief(card, epic_file, branch)` builds the two templates of the design, with the story's name as `json.dumps(name[:200], ensure_ascii=False)`, the epic line or "none, this story has no epic", the folder name from `slugify` for a card with no spec (`taken` is passed in), and the shared rules
    - `find_card(plan, card_id)` returns the epic file (or none) and the card
    - Write `tests/test_chats.py` with cases for the templates: the no-spec text and the with-spec text each hold the lines of Requirement 3 (branch, one pull request, never merge, never push to the main branch, no auto-merge, report the address and stop, ask when blocked); no epic omits the epic-page step; a story name with quotes, a line break, non-ASCII text and 500 characters; a card with `description` text that must not appear; the length of each template measured and every inserted name at 255 characters staying under 6,000; `slugify` cases (spaces, punctuation, non-ASCII only, 80 characters, a taken name once and twice); `find_card` for an epic card, a "No epic" card and a missing id
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
  - [x] 1.5 Write property tests for the brief and the folder name in `tests/test_chats_properties.py`
    - **Property 4: The brief depends only on its inputs and always says never to merge**
    - **Property 5: A spec folder name is well formed and unused**
    - Seeded `random.Random` generators for cards (names with any characters, with and without a spec and a description), epic files and branches; at least 100 iterations each; print the seed on failure
    - **Validates: Requirements 3.1, 3.2, 3.3, 3.4, 3.5**
  - [x] 1.6 Write `ChatStore` in `backend/chats.py`
    - `ChatStore(data_dir, new_name, clock)` with `started()`, `reserve(card_id)`, `mark_started(name, key)` and `remove(name)`, one lock, load and validate on every call, write through a temporary file in the data folder with `flush`, `os.fsync` and `os.replace`, create the folder on the first write only, `ChatError` with the codes and statuses of the design; `default_new_name()` is `epic-board-` and `secrets.token_hex(4)`, redrawn while the name is in the file
    - `reserve` returns the existing record for a card with a `reserved` record, raises `chat_exists` for a `started` one; `mark_started` is idempotent for the same key and raises `chat_exists` for another key and `chat_not_found` for an unknown name
    - Tests in `tests/test_chats.py` on a temporary folder: the record fields; a missing file; one record per card; a restart (a new store on the same folder); an unreadable file (not JSON, wrong shape, duplicate `card_id`, duplicate `name`, a `started` record with no key) raises `chats_unreadable` on every call and is left byte for byte as it was; a leftover temporary file does not matter; the folder is not created by a read; a failure to write leaves the old file
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.8_
  - [x] 1.7 Write property test for the store in `tests/test_chats_properties.py`
    - **Property 3: The store never holds two records for a card or a name, and survives a reload**
    - Seeded sequences of `reserve`, `mark_started`, `remove` and restart, against a model; check the invariants after every step
    - **Validates: Requirements 5.1, 5.2, 5.3**
  - [x] 1.8 Add `ChatService` and the `/chats` routes to `backend/server.py`
    - `ChatService(store, folder, reason, secret, holder, clock)` with `handle(method, path, headers, body_bytes)` doing, in this order, the secret check (503), the signature check against the raw body (401), the body size and form (400), then the route; the four routes, the answers and the codes of the design's tables; the order of the checks in `POST /chats`: folder, store, plan, card, status, reservation
    - `do_GET`, `do_POST` and `do_DELETE` hand a path that matches `/chats(/<name>(/started)?)?$` to `ChatService`; `do_POST` answers 400 at once for a missing, non-numeric or oversized `Content-Length`; `plan`, `health` and the 404 do not change; `make_server(port, holder, error, config_path, chats=None)` takes the service
    - In `__main__`, read the folder and the secret (`KIROCREW_PROXY_SECRET`), build the store from `data_dir`, and pass the service to `make_server`; when there is a configuration error, build the service with no holder, so that `GET /chats`, `DELETE` and `started` still work on the records and `POST /chats` answers `plan_not_ready`; no git runs
    - Tests in `tests/test_chats.py`: a signing helper; every code of the table; a reserve for each card state (unknown, Done, with a started chat, with a reserved record, planned with no spec, in progress with a spec); the check order; a refusal changing no record; the body limit; unknown fields; `started` and `DELETE` for known and unknown names; `plan_not_ready` for a pending and an error holder; no secret; one HTTP test on port 0 with `GET`, `POST` and `DELETE` through `make_server`, `plan` and `health` unsigned and unchanged, and no git command run
    - _Requirements: 1.1, 4.2, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_
  - [x] 1.9 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and report the counts run, passed and skipped
    - _Requirements: 1.1, 1.2, 1.4, 3.1, 3.2, 3.3, 3.4, 3.5, 4.2, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 5.9_

- [x] 2. Page logic
  - [x] 2.1 Let `createPoller` take a different answer reader and delay in `ui/index.mjs`
    - Add optional `classifyAnswer` (default `classify`) and `delay` (default `nextDelay`); with neither given it behaves exactly as before
    - Add two cases to `tests/ui/poller.test.mjs` that pass them; leave every other test in that file unchanged
    - _Requirements: 6.7_
  - [x] 2.2 Add the small chat functions to `ui/index.mjs`
    - `stateOf(row, lastRole)` and `STATE_WORDS` ("Needs you", "Working", "Interrupted", "Idle") as in the design; `chatHref(key)` is `/chat?sid=` and `encodeURIComponent(key)`; `classifyChats(status, body)` gives `{kind: 'chats', read}` or `{kind: 'failure'}`; `chatDelay(result)` gives 5000 when any state is `working`, `needs-you` or the chat is missing under 60 seconds, otherwise 15000, and 15000 for a failure
    - Write `tests/ui/chats.test.mjs` with examples: each flag alone and in pairs, missing fields, a key with `/`, `?`, `#`, space and non-ASCII in `chatHref`, and each delay
    - _Requirements: 6.2, 6.4, 6.7, 7.1_
  - [x] 2.3 Write property test for the state rule in `tests/ui/chats.test.mjs`
    - **Property 1: One state, by precedence**
    - **Validates: Requirements 6.2**
  - [x] 2.4 Add `readChats` to `ui/index.mjs`
    - The cycle of the design, with `backend`, `gateway`, `previous`, `now` and `signal` injected: records, then the list, then the due detail reads and the 404 reads, one shared signal; a `chats_unreadable` answer ends the cycle with no gateway request; no records means no gateway request; a non-array list, a non-404 rejection and a rejected backend request reject the cycle
    - Tests in `tests/ui/chats.test.mjs` with a fake backend and a fake gateway that record the requests: the requests made for each shape of input, no detail read when `last_ts` and `messages` are unchanged, a read when either changes, a 404 giving `missing`, a 200 detail for a chat absent from the list giving the state of Requirement 8.1, other rows ignored
    - _Requirements: 6.1, 6.3, 6.8, 8.1_
  - [x] 2.5 Write property test for our own keys in `tests/ui/chats.test.mjs`
    - **Property 2: Only our own keys count**
    - Generated lists with our rows and other rows, and generated started keys; at least 100 iterations with the seed printed on failure
    - **Validates: Requirements 6.1**
  - [x] 2.6 Add `initialChats`, `chatsReduce` and `cardViewOf` to `ui/index.mjs`
    - `chatsReduce` handles the read, the failed read, the started record added at once, and the removed record; it keeps `missingSince`, `lastRead` and the notice flag as the design says; a failed read keeps the shown states
    - `cardViewOf(card, chats, ui, nowMs)` returns the `mode` of the design's table and its fields (state word, link address, texts)
    - Tests in `tests/ui/chats.test.mjs`: every mode, including a Done card with a chat (a link and a state, no question), a Planned card with only a `reserved` record, the blocked texts, and the notice after a failed read and its removal after a good one
    - _Requirements: 2.1, 2.4, 2.5, 2.6, 6.4, 6.5, 6.8, 6.9, 7.1, 7.2, 7.3, 7.4, 8.2, 8.3_
  - [x] 2.7 Write property test for the restoring clock in `tests/ui/chats.test.mjs`
    - **Property 6: The restoring clock**
    - Generated sequences of reads with times, each finding the chat present or missing; check the mode at each read against the 60-second rule and the restart after a present read
    - **Validates: Requirements 8.2, 8.3**
  - [x] 2.8 Add `startStory` and `resumeChat` to `ui/index.mjs`
    - `startStory({cardId, backend, gateway, onStep})` as in the design: reserve, create with the three fields, send unless `messages > 0` (an error that only says `accepted the request` counts as sent), save with the key from the create answer; a failure is `{step, reason}` with the reason cut to 300 characters; a create answer with no text `key` fails the `create` step
    - `resumeChat({key, gateway})` posts the resume with no body; "Start again" uses `backend.del`
    - Write `tests/ui/start.test.mjs` with fakes: the order and bodies of the requests (the create body has exactly `name`, `agent` and `folder_id`), each step failing, the `accepted the request` case, a create that returns an existing chat with messages, a refused reservation with each code of Requirement 4.2, resume success and failure
    - _Requirements: 4.1, 4.3, 4.4, 4.5, 4.6, 8.4, 8.5_
  - [x] 2.9 Write property test for repeated starts in `tests/ui/start.test.mjs`
    - **Property 7: A repeated start never sends the brief twice and never makes a second chat**
    - A fake backend (stable reservation, started and reserved records) and a fake Crew (a create of a known name returns the same row with its message count, a send adds a message) with generated failures at each step across repeated attempts; at least 100 iterations with the seed printed on failure
    - **Validates: Requirements 4.3, 4.4, 4.5, 4.6**
  - [x] 2.10 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each; a skipped page test is reported as skipped, not as passed
    - _Requirements: 2.1, 4.1, 4.3, 4.4, 4.5, 4.6, 6.1, 6.2, 6.3, 6.7, 8.1, 8.2, 8.3_

- [x] 3. Page: controls, second poller and permissions
  - [x] 3.1 Draw the card modes in `ui/index.mjs`
    - `renderBoard(h, view, actions)` with `actions` `{ask, cancel, start, close, resume, startAgain}` defaulting to no-ops; `renderCard` draws each `mode` of `cardViewOf`: a `button` (class `eb-card-main`) for `startable`, an `a` with `chatHref` for `chat`, plain text for `plain`, `restoring`, `not-open`, `resuming` and `resume-failed` (with their controls); the question as a `div` with `role="group"` and an `aria-label`, its text, "Start" and "Cancel", Escape calling `cancel`; progress, failure and blocked texts with `role="status"` and no `alert`; the state word in a `span` with the class `eb-chat-state`; a `data-card-id` on the main control; the "Could not read chat status. Showing the last known states." notice above the columns; no heading added
    - Add the new rules to `STYLE`: `position: relative` on the card, the stretched `::after` on `.eb-card-main`, `position: relative` and a `z-index` on the controls, the pointer cursor, the hover and focus-within tint, the state word; only `currentColor` and greys with an alpha between 0 and 1, no named, hex or `rgb()` colour, no `outline: none`
    - Pass every text as a child; build the link only from `chatHref`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6, 4.6, 6.4, 6.8, 7.1, 7.2, 7.3, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5_
  - [x] 3.2 Check the markup in `tests/ui/render.test.mjs`
    - For each `mode`: the elements, the roles, the labels and the classes; one `a` or `button` as the card's main control; the question's buttons and `aria-label`; no `alert` role anywhere but the two of the board design; no new heading and the same heading levels with a question open; literal text for a story name, a failure reason and a Crew error containing markup; the `data-card-id` attribute; actions called with the right id or key (a recording `actions`)
    - Update the interactive-element check (from line 183): the only interactive elements are the `summary` and the controls of Requirements 2, 7 and 8; the board's other checks stay as they are
    - Extend the `STYLE` scans for the new rules
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 6.4, 7.1, 7.2, 8.3, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5_
  - [x] 3.3 Wire the chat poller and the start flow in `createBoard`
    - A second reducer for `chats` and `ui` (the question open on at most one card, flows per card id, resumes per key), `env.useAppApi` defaulting to the host's `window.__kirocrew_modules['@kirocrew/app-sdk'].useAppApi` looked up inside the component, `backend` and `gateway` clients as the design describes (the backend's with `credentials: 'same-origin'`, the signal and a JSON body)
    - A second effect builds the chat poller with `readChats`, `classifyChats` and `chatDelay`, the same `hidden`, timers and `visibilitychange` handling as the plan poller, and `stop()` on unmount; the plan poller and its tests do not change
    - Start, Cancel, Close, Resume and Start again run the flows of the design; a successful start adds the record at once and calls the chat poller's `visible()`; a successful resume does the same; a second activation of a running start is ignored; after Cancel an effect puts focus on the card's button found by `data-card-id`
    - A failure of a chat request does not touch the plan state, and a failure of a plan request does not touch the chat state
    - _Requirements: 2.2, 2.3, 4.1, 4.6, 4.7, 6.7, 6.8, 6.9, 8.4, 8.5, 8.6, 9.6_
  - [x] 3.4 Declare the permissions in `app.json` and bring `tests/test_ui.py` in line
    - Add `"permissions": {"api": ["/api/chat", "/api/chat/slots"]}` and nothing else; keep the name, route, backend and platform declarations
    - In `tests/test_ui.py` replace the assertion that there is no `permissions.api` (lines 77 to 79) with one that `permissions.api` is exactly those two entries and that `app.json` has none of `sessionApproval`, `chatSlots`, `spawn`, `agentTurns`, `network` or `storage`
    - _Requirements: 1.3_
  - [x] 3.5 Check the wiring in `tests/ui/board.test.mjs`
    - Update "opening the page sends one GET of the plan route and nothing else" (line 195): on open, the requests are one GET of the plan route and one GET of the chats route, and no Crew request while there are no started chats
    - Add tests with a fake `useAppApi`: with started chats, the list is read after the chats route; a hidden page sends no chat request; becoming visible reads at once; a start sends the requests of the design in order and then reads again; Cancel closes the question and restores focus; unmounting stops both pollers and removes the listener; a gateway failure shows the notice and keeps the board; a plan failure keeps the chat states; the default export still builds the component once and needs no `window` at import
    - Scan `ui/index.mjs` for `innerHTML` and `dangerouslySetInnerHTML`, and for any call to a path containing `approve`, `question` or `approvals`, `DELETE` of a Crew chat, `stop` or `close`
    - _Requirements: 4.6, 4.7, 6.6, 6.7, 6.8, 6.9, 8.6, 9.4, 9.6_
  - [x] 3.6 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 1.3, 2.1, 2.2, 2.3, 2.4, 4.6, 6.7, 6.8, 7.1, 8.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_

- [ ] 4. Check it works end to end
  - [x] 4.1 Run the backend on throwaway data
    - Start `backend/server.py` with `PORT`, `EPIC_BOARD_REPOSITORY` set to a throwaway clone, `EPIC_BOARD_FOLDER` set to a made-up id, `KIROCREW_HOME` set to a temporary folder and `KIROCREW_PROXY_SECRET` set to a test value; sign each request with the documented rule using a few lines of Python
    - Check: `GET /chats` is empty and the folder is reported; `POST /chats` for a planned card with no spec returns the no-spec brief, and for a card with a spec returns the with-spec brief; the file `chats.json` appears in `<KIROCREW_HOME>/apps/epic-board/data/` as `reserved`; `started` makes it `started`; a second `POST /chats` for that card is 409 `chat_exists`; a Done card is 409 `card_done`; an unknown id is 409 `card_not_found`; `DELETE` removes the record; stopping and starting the backend keeps the records
    - Check the refusals: no signature, a stale signature and a wrong signature answer 401; no secret answers 503; an unreadable `chats.json` answers 500 `chats_unreadable` and the file is unchanged; `plan` and `health` still answer unsigned
    - Do not change this repository's own `config.json`, and read nothing from the real Crew data folder
    - _Requirements: 1.1, 1.4, 3.2, 3.3, 4.2, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7_
  - [ ] 4.2 Install the app in Kiro Crew and check the page (done by you in the app)
    - Install the app on a throwaway project with its own git remote, set `EPIC_BOARD_REPOSITORY`, and set the Crew folder id (`EPIC_BOARD_FOLDER` or `folder_id` in `config.json`) to a Crew folder whose project is that checkout (the ids come from `GET /api/chat/folders`)
    - **Check that the board receives every chat's row and keeps only the keys in `chats.json`, and never shows another chat's preview.** In the page's network log, open the answer of `GET /api/chat/slots`: it holds a row for every chat you have open, not only the ones the board started. Confirm that the board's cards show only the chats listed in `chats.json`, that no other chat's preview or title appears anywhere on the page, and that the page sends no request about any chat whose key is not in `chats.json`
    - **Check that `/chat?sid=` opens our chat.** Click a started card and a Done card's chat, and confirm each opens the right chat in the host; try the keyboard (Tab to the link, Enter) and the browser's back button
    - Check Start end to end on a planned card with no spec and on a card with a spec: the question appears on the card and Cancel and Escape close it; "Start" opens one chat in the project's folder, its first message is the brief and it is sent once; the card shows its link as soon as the chat is saved, before the brief is sent, and its state after the next read; the conductor opens a pull request, and the board merges nothing and changes nothing in the repository
    - Check a start whose conductor waits for a tool approval: `POST /api/chat` does not answer until the turn ends, so the card must not stay on "Starting…". Confirm that the card has its link and a state as soon as the chat exists, that it shows Needs you while the request is still open, that "Sending the brief…" goes away after about 10 seconds, and that navigating away and back finds the chat in `chats.json` and on the board. Then make a send fail (for example stop Crew just after the chat is created) and confirm that the card keeps its link, says "The brief was not sent" with the reason, and that "Send the brief again" sends it once when the chat holds no message and sends nothing when it holds one
    - Check the four states on a real conductor: Working while it runs; Needs you when a tool call waits for an approval or it asks a question (confirm that `running` is true at the same time, which decides the order Needs you before Working), and that the board offers no approve or answer control; Interrupted after you stop Crew in the middle of a turn and start it again, and for a chat whose last row is an error; Idle when it has replied
    - Check that a click on a card with a started chat never shows the question, and that a Done card with no chat is inert
    - Restart the Crew gateway with a started chat: the card shows "Restoring chat…" and then its state again; stop a chat so that it stays closed and confirm "This chat is not open." appears after about 60 seconds and "Resume chat" brings it back, and that "Start again" removes only the board's record
    - Check the host details the design still leaves open: the backend receives `KIROCREW_PROXY_SECRET` and a valid v1 `X-KiroCrew-Proxy` on the page's `chats` requests (starting works); the data folder is writable by the backend (the record survives a backend restart)
    - Check light and dark themes, the focus ring on every new control, and that the plan keeps updating while a chat read fails (stop the gateway's chat routes or block them) and the other way round
    - _Requirements: 1.3, 1.4, 2.1, 2.2, 2.3, 4.1, 4.3, 4.4, 4.5, 4.7, 4.9, 5.3, 5.7, 6.1, 6.2, 6.4, 6.6, 7.1, 7.2, 8.1, 8.2, 8.3, 8.4, 8.5, 9.1, 9.3, 9.6_

- [x] 5. Save the chat before its brief is sent
  - [x] 5.1 Change the order of `startStory` in `ui/index.mjs` and add `sendBrief` and `retryBrief`
    - `startStory({cardId, backend, gateway, onStep, onSaved, setTimer, clearTimer})`: reserve, create, save the key (the record becomes `started`), call `onSaved({cardId, name, key, brief})`, then send the brief unless the create answer's `messages` is greater than 0; the steps are named `reserve`, `create`, `save` and `send`
    - `sendBrief({gateway, key, brief, setTimer, clearTimer})` ends when the request answers, when it fails with an error that only says Crew accepted the request, or `SEND_WAIT_MS` (10,000) after it was sent with no error; it does not abort the request, and ignores whatever the request later answers; any other error before then rejects
    - A failure of the send throws a StartError for the step `send` that carries `saved`; a failure before the save carries nothing
    - `retryBrief({gateway, key, brief, setTimer, clearTimer})` reads `GET /api/chat/slots` and sends only when the list has a row for the chat whose `messages` is 0; with `messages` greater than 0 it sends nothing and answers `{sent: false}`; with no row, a list that is not a list or no number of messages it sends nothing and throws a `send` failure with that reason
    - _Requirements: 4.3, 4.4, 4.5, 4.6, 4.7, 4.9_
  - [x] 5.2 Draw the brief of a started chat
    - `cardViewOf` gives a chat the `brief` of `ui.briefs[key]`; `initialUi` and `uiReduce` gain `briefs` and the actions `brief-sending`, `brief-failed` and `brief-sent`
    - A started card keeps its link and its state, and shows "Sending the brief…" (role `status`) while the brief is sent, or "The brief was not sent" (role `status`), the reason and a "Send the brief again" button (inside the controls layer above the stretched link) after a failed send; `renderBoard` actions gain `sendBrief(key)`
    - _Requirements: 4.9, 9.1, 9.2, 9.3, 9.4_
  - [x] 5.3 Wire it in `createBoard`
    - `start` passes `onSaved`, which adds the record, closes the question, sets the brief to sending, keeps the brief text in memory by key, and reads the chats at once; a send that ends well forgets the text and the note; a failure of the send sets the brief to failed and keeps the link; a failure before the save shows the step and offers the question again, as before
    - A `sendBrief(key)` action runs `retryBrief` from the text held in memory, ignores a second press while it runs, forgets the text and the note when the brief is sent or the chat already holds a message, and shows the failure again otherwise
    - The send timers are made through the component's `setTimeout` and cleared on unmount
    - _Requirements: 4.4, 4.5, 4.6, 4.7, 4.9_
  - [x] 5.4 Check the sequence in `tests/ui/start.test.mjs`
    - The order of the requests (reserve, create, save, `onSaved`, send) in one shared log; `onSaved` before the send; a chat that already holds a message is saved and not sent the brief; a **send that never answers** (the start ends 10,000 ms after the request with no error and not before, the chat is saved while the request is open, a later error is ignored, the request is not aborted, the timer is cleared); a send that answers early ends the wait; a send that fails before 10 seconds throws a `send` failure that carries `saved`; the `accepted the request` case; a failure of any step before the save sends nothing
    - `sendBrief` and `retryBrief` on their own: the cases above, a retry that sends only when `messages` is 0, one that sends nothing for `messages` greater than 0, a list that cannot be read, a missing row, no message count
    - _Requirements: 4.4, 4.5, 4.6, 4.7, 4.9_
  - [x] 5.5 Write property test for the new order in `tests/ui/start.test.mjs`
    - **Property 7: A chat is saved before its brief is sent, and the brief is never sent twice**
    - A fake backend and a fake Crew with failures before and after each call and sends that answer, fail before Crew has the message, fail after it, say Crew accepted it or never answer, over repeated starts and retries, at least 100 iterations with the seed printed on failure; check that no brief is sent while the record is `reserved`, that no brief is sent to a chat that holds a message, that at most one message and one chat exist, and that a start whose reservation, creation and saving succeed ends with the record `started` whatever the send does; and, apart, that the saving never waits for the send
    - **Validates: Requirements 4.3, 4.4, 4.5, 4.6, 4.7, 4.9**
  - [x] 5.6 Check the card, the controls state and the wiring
    - `tests/ui/chats.test.mjs` (`cardViewOf` carries the brief note only for a chat), `tests/ui/controls.test.mjs` (`uiReduce` for the three new actions), `tests/ui/render.test.mjs` (the note, the reason and the button, the controls layer, literal text, structure and roles), `tests/ui/board.test.mjs` (the link shows when the chat is saved and before the brief is sent; a conductor whose turn waits for an approval leaves the card with its link and Needs you, and the note goes after 10 seconds; a failed send keeps the link and a retry sends once only when the chat holds no message; a retry that cannot read the list sends nothing; a second press does nothing; unmounting clears the send timer)
    - Update the tests that described the old order: `board.test.mjs` ("a start: …") and `chats.test.mjs` (the shape of a chat view)
    - _Requirements: 4.7, 4.9, 9.1, 9.2, 9.3, 9.4_
  - [x] 5.7 Change the status words of the briefs in `backend/chats.py`
    - With no spec, the step that links the story's line in the epic page ends "Set its status to in progress." and no longer "Keep its status."
    - With a spec and an epic, a step before the commit says "If your group ticks the last task in tasks.md, set the story's line in the epic page to done, in the same pull request."; with no epic the step is left out and the steps are numbered again
    - `tests/test_chats.py` checks both sentences, the position of the new step, the numbering and that "Keep its status" is gone; `tests/test_chats_properties.py` (Property 4) checks that each sentence appears exactly for its variant and an epic, and that the brief stays at most 6,000 characters
    - _Requirements: 3.2, 3.3, 3.4_
  - [x] 5.8 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 3.2, 3.3, 4.3, 4.4, 4.5, 4.6, 4.7, 4.9_

- [x] 6. The state of a card is the story's state
  - [x] 6.1 Change the state rule in `ui/index.mjs`
    - `STATE_WORDS` becomes Needs you, Interrupted, Working, Stalled, Review and Your turn; `stateOf(row, lastRole, workers, now)` follows the design; add `workersOf`, `hasStalled`, `reviewOf` and `reviewWord`
    - `readChats` asks `GET /api/chat/slots?crew=all`, finds each conductor's workers, reads the conductor's last row only as Requirement 6, criterion 3 says, and keeps `review` ({number, url, failed}) on a Review entry
    - `cardViewOf` gives `stateWord` ("Review #N" or "Checks failed #N" for Review) and `stateHref` (the pull request, or null); the card draws the Review word as a link with `target="_blank"` and `rel="noopener noreferrer"`
    - A chat that is not in the list is still read on its own and ends as Working, Interrupted or Your turn (Requirement 8.1)
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 8.1_
  - [x] 6.2 Bring the tests in line and add the new ones
    - Changed because the expected states changed: the `stateOf` tests (Interrupted now comes before Working, Idle is Your turn), the state words, the fake gateway's list path in `tests/ui/chats.test.mjs`, `board.test.mjs` and `controls.test.mjs`, and the fixtures that named the `idle` state. The brief's own list read (`sendBrief`) is unchanged
    - New: workers by `crew_root` and `created_by`, the Stalled rule, Review and Checks failed, the order of the six states (Property 1 now covers workers), a Review entry keeping only the pull request, the Review link in `render.test.mjs`, and a page test that no text, title, preview or link of a worker's row reaches the page
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5_
  - [x] 6.3 Edit the other specs that name the state words
    - `.kiro/specs/board-design/` (Requirement 6.6 criterion 6, design decision 4, the task that draws the badge) and the epic page's "one of four states"
    - _Requirements: 6.4_
  - [x] 6.4 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 6.5, 8.1_
  - [ ] 6.5 Check the six states on a real conductor (done by you in the app)
    - With workers running: Working, though the conductor's own chat is idle; a worker waiting for an approval: Needs you on the card; a stalled ledger item: Stalled; an open pull request: "Review #N" linking to it, and "Checks failed #N" when its checks failed; none of these: Your turn
    - Confirm in the network log that the list read is `GET /api/chat/slots?crew=all`, that it holds the workers' rows, and that no worker's text appears on the page
    - Confirm that `source_links` carries `state` (and `ci`) for the app's token on a private repository. When it does not, the card shows Your turn where it should show Review
    - _Requirements: 6.1, 6.2, 6.4_

## Notes

- Each group is one pull request and is merged by the owner; start the next group from the updated main
- Group 3 is the one that brings the board story's checks in line with the edited criteria 1.2 and 1.3 of that spec; no file of the earlier specs is ticked, and their requirements were edited in place before this story's tasks (see "Edits to earlier specs and checks" in the design)
- No task is optional: every task checks a requirement of this spec
- The open questions in the design are for the owner; the host-dependent ones are checked in 4.2
- Requirement 7 (criteria 1, 5 and 6) and Requirement 6, criterion 6 were changed by `work-in-the-chat`, whose tasks build them. The ticked tasks of groups 3 and 5 describe the link as it was, and are not reopened
- Group 5 comes from using the board: `POST /api/chat` answers only when the conductor's turn ends, so a turn waiting for a tool approval left the card on "Starting…" with no link. Requirement 4 (criteria 4 to 7 and the new 9), the design's start sequence and Property 7 changed with it; Requirement 1.3 of the board spec now names Requirement 4 as one of the places card controls are defined. The briefs of Requirement 3 changed in the same group: a new spec's story is set to in progress, and a story whose last task is ticked is set to done in the same pull request (5.7)
- Group 6 comes from using the board: a conductor's chat is idle while its workers build, so "Idle" misled. Requirement 6 (criteria 1 to 5), the glossary, Requirement 8.1 and the design's state rule and Property 1 changed with it. The ticked tasks 2.2, 2.3 and 3.x describe the four states as they were, and are not reopened

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2", "1.3", "1.4"] },
    { "id": 1, "tasks": ["1.5", "1.6"] },
    { "id": 2, "tasks": ["1.7", "1.8"] },
    { "id": 3, "tasks": ["1.9"] },
    { "id": 4, "tasks": ["2.1", "2.2"] },
    { "id": 5, "tasks": ["2.3", "2.4", "2.8"] },
    { "id": 6, "tasks": ["2.5", "2.6", "2.9"] },
    { "id": 7, "tasks": ["2.7"] },
    { "id": 8, "tasks": ["2.10"] },
    { "id": 9, "tasks": ["3.1", "3.4"] },
    { "id": 10, "tasks": ["3.2", "3.3"] },
    { "id": 11, "tasks": ["3.5"] },
    { "id": 12, "tasks": ["3.6"] },
    { "id": 13, "tasks": ["4.1"] },
    { "id": 14, "tasks": ["5.1"] },
    { "id": 15, "tasks": ["5.2"] },
    { "id": 16, "tasks": ["5.3"] },
    { "id": 17, "tasks": ["5.4", "5.5", "5.6"] },
    { "id": 18, "tasks": ["5.7"] },
    { "id": 19, "tasks": ["5.8"] },
    { "id": 20, "tasks": ["4.2"] },
    { "id": 21, "tasks": ["6.1"] },
    { "id": 22, "tasks": ["6.2", "6.3"] },
    { "id": 23, "tasks": ["6.4"] },
    { "id": 24, "tasks": ["6.5"] }
  ]
}
```
