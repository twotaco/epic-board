# Implementation Plan

## Overview

The work is six task groups. Each group is one pull request on its own branch, named `story/show-the-board-g1` to `story/show-the-board-g6`, cut from the latest main after the previous group's pull request is merged. Each group lands green on its own and leaves the app working. Every group ends with a sub-task that runs the tests and reports the counts run, passed and skipped. Tick each task in this file in the same branch, and tick nothing in the earlier spec (`.kiro/specs/read-the-plan-from-main/`). The backend adds no dependency.

The placeholder page (`ui/index.mjs`) stays in place until group 4 replaces it. Group 2 changes the backend answer (202 while nothing is held), so it also makes the smallest change that keeps the placeholder working. Group 3 only makes the module importable under Node and keeps the placeholder as its default export.

## Tasks

- [x] 1. Cards carry a description
  - [x] 1.1 Add `description` to the cards in `backend/plan.py`
    - `card(name, status, spec, tasks, epic, description)` puts `description` in the dict
    - `story_card(story, specs, epic_name)` passes `story.description` in both branches (spec exists, spec missing)
    - In `build_plan`, the card made for a spec folder that no story lists passes `""`
    - Do not change `backend/parse.py`; `Story.description` is already trimmed by `split_status`
    - _Requirements: 4.1, 4.2, 4.3_
  - [x] 1.2 Check the descriptions in `tests/test_plan.py`
    - Add cases to `PlanTests` for Requirement 4: a story whose spec exists and one whose spec is missing both carry the description; whitespace at both ends is removed and inner spacing, later full stops and punctuation are unchanged
    - No full stop after the dash, and only whitespace after the first full stop, give `""`
    - A spec no story lists gives `""` and takes nothing from its own files; a spec listed only by a line the parser ignores also gives `""`
    - A spec listed in two epics gives each epic card its own line's description
    - A spec listed twice in `standalone.md` gives its one "No epic" card the first line's description; a `standalone.md` line for a spec an epic uses produces no card
    - Check that the existing tests in `tests/test_plan.py` still pass unchanged
    - _Requirements: 4.1, 4.2, 4.3_
  - [x] 1.3 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and report the counts run, passed and skipped
    - _Requirements: 4.1, 4.2, 4.3_

- [x] 2. Bring the first story in line, and add the held plan
  - [x] 2.1 Add `read_snapshot` and `Snapshot.fetched` to `backend/gitsource.py`
    - Split `open_snapshot` into `_open(repository, fetch)` and two entry points: `read_snapshot(repository)` (no fetch) and `open_snapshot(repository)` (fetch, then read, as before)
    - Add `Snapshot.fetched`: `True` when the fetch succeeded, `False` when it failed, `None` when none was tried; `fetch_error` stays set only when `fetched` is `False`
    - With `fetch=False`, skip the fetch step and the fetch lock; a ref that does not resolve raises `ref_unreadable` with no fetch reason; a path that is not a directory or not a checkout raises `not_a_checkout` in both
    - Keep the 30-second limit, `origin/HEAD` handling and file access unchanged
    - _Requirements: 5.4, 5.5_
  - [x] 2.2 Check the git access in `tests/test_gitsource.py`
    - Add `ReadSnapshotTests(Repos)`: after the origin gains a commit, `read_snapshot` still returns the old commit (no fetch); `fetched` is `None` and `fetch_error` is `None`; a checkout with no `origin/<branch>` raises `ref_unreadable` without a fetch reason; a plain directory raises `not_a_checkout`
    - Add an assertion on `fetched` to `OpenSnapshotTests.test_reads_main_when_origin_head_set` (`True`) and to `OpenSnapshotTests.test_failed_fetch_with_earlier_copy` (`False`)
    - Leave `FileAccessTests` and `RunnerTests` unchanged
    - _Requirements: 5.4, 5.5_
  - [x] 2.3 Write `backend/held.py`
    - `Holder(repository, read_snapshot, open_snapshot, build_plan, clock=time.monotonic, spawn=spawn_thread, interval=60)` with `start()`, `first_read()`, `request()` and `run_refresh()`; `spawn_thread(fn)` starts a daemon thread; import only `SourceError` from git code
    - Keep one immutable `State` (`plan`, `error`, `fetched_at`, `refreshing`, `last_refresh_ended`, `first_read_ended`), replaced as a whole under a lock that is never held across git or a plan build; a stored plan dict is never changed (a failed-fetch update stores a copy with a new `fetch`)
    - `first_read()`: no fetch; success holds the plan with `fetch` `{"ok": null}` and no `fetched_at`; `not_a_checkout` holds `repository_not_a_checkout`; any other failure holds nothing; always sets `first_read_ended`; then `start()` claims the first refresh in the same thread
    - `request()`: claim a refresh in one locked step when it is due (first read ended, none running, and none ended yet or the last ended 60 seconds or more ago), copy the state, release the lock, then spawn; answer `("pending", None)`, `("error", {code, message})` or `("plan", body)` where the body adds `age_seconds` (`max(0, int(clock() - fetched_at))`, or none) and `refreshing`
    - `run_refresh()`: apply each row of the design's transition table (fetch succeeded, fetch failed with an earlier copy, build failure with a plan held, build failure with none held); stamp `fetched_at` with `clock()` when `open_snapshot` returns; hold `not_a_checkout` as `repository_not_a_checkout` and any other exception as `internal` with the message "The plan could not be built." and the traceback on stderr; clear `refreshing` and set `last_refresh_ended` in a `finally`
    - The plan body holds `repository`, `branch`, `ref`, `commit`, `fetch`, `groups` and `problems`
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5_
  - [x] 2.4 Check the holder against the transition table in `tests/test_held.py`
    - Drive `Holder` with a fake clock, fake `read_snapshot`, `open_snapshot` and `build_plan`, and a `spawn` that queues jobs; no sleeping, no git
    - One test per row of the design's transition table: first read succeeds, first read fails not a checkout, first read fails for another reason, first refresh claimed, fetch succeeded, fetch failed with an earlier copy, build failure with a plan held, build failure with none held
    - Nothing held answers pending; a request answered while a refresh is blocked on a `threading.Event` returns at once; a request between the end of the first read and the startup claim claims the refresh and the startup thread then does nothing; an unexpected exception gives `internal` and does not leave `refreshing` set
    - A request 59 seconds after a refresh ended starts none, and 60 seconds starts one
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 6.1, 6.2, 6.3, 6.4, 6.5_
  - [x] 2.5 Write property test for the holder state
    - **Property 1: The holder never holds a plan and an error, and never loses a plan**
    - Seeded `random.Random` sequences of first-read results, requests, clock advances and refresh outcomes, at least 100 iterations, printing the seed on failure
    - **Validates: Requirements 5.5, 6.3, 6.4, 6.5**
  - [x] 2.6 Write property test for the refresh rule
    - **Property 2: At most one refresh, started only when due**
    - Same generator style; check that at most one refresh is claimed and unfinished, that `refreshing` is true exactly then, and that a refresh is claimed only when due
    - **Validates: Requirements 5.4, 6.1, 6.2**
  - [x] 2.7 Write property test for the plan age
    - **Property 3: Age follows the last successful fetch**
    - Check that `age_seconds` is none exactly when no refresh fetch has succeeded, equals the whole seconds since the latest successful fetch, and is not changed by the first-read plan or a failed fetch
    - **Validates: Requirements 5.2, 5.4, 6.3, 6.4, 6.5**
  - [x] 2.8 Rewrite `backend/server.py` so `/plan` answers from the holder
    - `plan_response(holder, error, config_path)`: a configuration error answers its status with `{"error": error}`; otherwise call `holder.request()` and answer 202 with `{"pending": true}`, the held error with the status from `STATUS`, or 200 with the plan including `age_seconds` and `refreshing`
    - Give a held `repository_not_a_checkout` the "Check EPIC_BOARD_REPOSITORY or the repository value in `<config.json>`" ending and `settings` at answer time, as the code does today
    - An exception in `plan_response` answers 500 `internal` with no repository path in the message
    - `make_handler` and `make_server(port, holder, error, config_path)` take the holder (none when `error` is set); `make_server` starts no thread and runs no git
    - In `__main__`, load the repository, build the server and bind the port, then build `Holder(repo, read_snapshot, open_snapshot, build_plan)`, call `start()` and then `serve_forever()`, so `/health` answers before the first read ends; with a configuration error build no holder, start no thread and run no git
    - Keep `load_repository`, `config_error`, `error_body`, `STATUS`, the route matching, the 404 and the ignoring of the query and body
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6_
  - [x] 2.9 Update `tests/test_server.py` as the design's table says
    - `ServeTests.get()` takes a holder or none and calls the new `make_server` signature; keep the real origin and checkout built in `setUp`; leave `LoadRepositoryTests` unchanged
    - Replace `test_plan_ignores_repo_in_query` with two tests on the same real checkout: after `first_read()` the body has `fetch` `{"ok": null}`, `age_seconds` null, `refreshing`, a `description` on the card and the repository unchanged by the `?repo=` and `repository=` query; after one queued refresh runs, `fetch` is `{"ok": true}` and `age_seconds` is 0
    - Update `test_not_a_checkout_is_409` to call `first_read()` first, with the 409 body and both setting names unchanged
    - Update `test_not_configured_is_409_with_both_names`, `test_health_works_without_configuration` and `test_unknown_path_is_404` for the signature only; the first also asserts that no git command ran and no holder exists
    - Add tests: 202 with `{"pending": true}` before the first read; a held `ref_unreadable` answers 502; a held `internal` answers 500 with no repository path in the message; the 200 answer has `age_seconds` and `refreshing`
    - _Requirements: 5.1, 5.2, 5.3, 5.5, 5.6_
  - [x] 2.10 Keep the placeholder page working with the new answers in `ui/index.mjs`
    - Make the smallest change: when the answer is 202 with `{"pending": true}`, show "Loading…" and ask again after 2 seconds; show `fetch failed` only when `plan.fetch.ok === false`, so `null` is not read as a failure
    - Change nothing else in the placeholder; group 4 replaces it
    - _Requirements: 1.1_
  - [x] 2.11 Re-read the four edited criteria of the earlier spec and confirm each now holds
    - Re-read earlier spec criteria 2.1, 2.2, 2.5 and 8.4 (`.kiro/specs/read-the-plan-from-main/requirements.md`) without editing the file or ticking its tasks
    - For each, confirm by a named test or by running the backend, and list the evidence (test name, or the command and the answer seen) in the pull request description: 2.1 (main branch from `origin/HEAD`, else `main`, on both the first read and a refresh); 2.2 (a refresh fetches and reads `origin/<branch>`, the first plan is read before any fetch: origin advances and the first-read commit stays old); 2.5 (a failed fetch with no `origin/<branch>` and no plan held answers `ref_unreadable` 502 with no plan, and with a plan held keeps the plan); 8.4 (a card has name, status, spec, tasks, description and epic, and `tasks` is none only for a card with no spec or an unreadable `tasks.md`)
    - Also confirm that the earlier spec's criteria 1.3 and 1.4 still hold (query ignored, configuration errors with no plan)
    - If a criterion does not hold, fix the code in this group and say so; if the spec text looks wrong, say so instead of changing it
    - _Requirements: 5.4, 5.5, 5.6, 6.3, 6.4, 6.5_
  - [x] 2.12 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and report the counts run, passed and skipped
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3, 6.4, 6.5_

- [x] 3. Page logic
  - [x] 3.1 Make `ui/index.mjs` importable under Node and add the page test helper
    - Move the `window.__kirocrew_modules.react` lookup from the top of the module into the default export, so importing the module needs no `window`; the placeholder stays the default export and keeps working
    - Create `tests/ui/support.mjs` (defines no tests) with a seeded generator that prints its seed on failure, and an `h` that returns `{type, props, children}` objects for inspecting trees
    - _Requirements: 1.1, 1.2_
  - [x] 3.2 Add the data functions to `ui/index.mjs`: `columnsOf`, `progressOf`, `ageText`, `nextDelay`
    - `columnsOf(plan)` returns Planned, In progress and Done, each with `key`, `title`, `count` and groups `{key, name|null, cards}`; keep only groups with a card of that status, in the plan's order, and name a group with no epic "No epic"
    - `progressOf(card)` gives "No spec yet", "Tasks could not be read", "No tasks yet" or "`<done>` of `<total>` task(s)" with a fraction clamped to 0..1 (none for the first three)
    - `ageText(seconds)` words the age as "Updated less than a minute ago", minutes, hours and days, singular when N is 1, and "Not yet updated from origin" for none
    - `nextDelay(result)` gives 2000 for pending or `refreshing` true and 15000 otherwise, including a failure
    - _Requirements: 2.1, 2.2, 3.3, 3.4, 3.5, 7.3, 8.2_
  - [x] 3.3 Add `classify`, `initialState`, `reduce` and `viewOf` to `ui/index.mjs`
    - `classify(status, body)` returns `pending` (202 and `{"pending": true}`), `error` (body with an `error` object), `plan` (body with a `groups` array) or `failure`
    - `reduce` follows the design's table: plan and error replace `content` and clear `unreachable`; pending keeps `content` and clears `unreachable`; failure keeps `content` and sets `unreachable`
    - `viewOf(state)` returns `loading`, `unreachable`, `error` or `plan`, with the fields `renderBoard` needs (notices, header, columns or empty-plan text, problems)
    - _Requirements: 7.4, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_
  - [x] 3.4 Add `STYLE` and `renderBoard(h, view)` to `ui/index.mjs`
    - `STYLE` is one string: classes prefixed `eb-`; one column, three columns inside `@container (min-width: 720px)` with an `@supports not (container-type: inline-size)` media-query fallback; `min-width: 0` on grid items and `overflow-wrap: anywhere` on card text; no text or background colour set; borders, bar tracks, bar fills and tints in `currentColor` or an alpha between 0 and 1; no named, hex or `rgb()` colour; no `outline: none`
    - `renderBoard` builds the title (`h1`, one constant for the level), the header (branch, first 7 characters of the commit, age text, an always-present "Checking for updates…" slot hidden with `visibility: hidden` unless refreshing), the three columns (`h2` with count, `h3` per group, one `ul` of `li` per group), cards (name, description when not empty, spec folder as plain text, progress text, bar `aria-hidden="true"` only when there is a fraction), "Nothing here", and the states of Requirement 9
    - Roles: `status` on "Loading…", the failed-fetch notice and the unreachable notice; `alert` on the backend error and on "Could not reach the backend."; no other `alert`
    - The problems disclosure is one native `details` with a `summary` ("N files could not be read", "1 file could not be read"), collapsed by default, listing every problem's file and reason; the `summary` is the only interactive element
    - Pass every plan text as a child; no `dangerouslySetInnerHTML`
    - _Requirements: 1.3, 1.4, 2.1, 2.2, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 8.1, 8.3, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 10.1, 10.2, 10.3, 10.4_
  - [x] 3.5 Add `createPoller({request, hidden, setTimer, clearTimer, onResult})` to `ui/index.mjs`
    - `start()` sends a request at once unless hidden; at most one request in flight; a 10-second abort timer through an `AbortController` counts as a failure
    - When a request settles, call `onResult` and set one timer for `nextDelay(result)`; when the timer fires and the page is hidden send nothing and set no timer
    - `visible()` clears the timer and sends at once unless a request is in flight; `stop()` clears the timer, aborts a request in flight and makes later results be ignored
    - _Requirements: 7.1, 7.2, 7.3, 7.4_
  - [x] 3.6 Write property test for grouping into columns in `tests/ui/columns.test.mjs`
    - **Property 4: Grouping puts each card in one column**
    - Generated plans (cards in several groups, a card in two epic groups, empty groups); at least 100 iterations with the seed printed on failure
    - Also check "Nothing here" input (a column with no cards) as an example
    - **Validates: Requirements 2.1, 2.2**
  - [x] 3.7 Write property test for progress text in `tests/ui/progress.test.mjs`
    - **Property 5: Progress text matches the counts**
    - Examples: no spec, `tasks` none, total 0, total 1 ("1 of 1 task")
    - **Validates: Requirements 3.4**
  - [x] 3.8 Write property test for age wording in `tests/ui/age.test.mjs`
    - **Property 6: Age wording follows the age**
    - Examples: none, 0, 59, 60, 3599, 3600, 86399, 86400 seconds
    - **Validates: Requirements 8.2**
  - [x] 3.9 Write property test for the poller in `tests/ui/poller.test.mjs`
    - **Property 7: The poller keeps one request in flight and sleeps when hidden**
    - Fake scheduler and fake request; random sequences of timer firings, visibility changes, answers, failures and timeouts
    - Examples: request at once on start and on becoming visible, delay 2000 and 15000, the 10-second abort, cleanup by `stop()`
    - **Validates: Requirements 7.1, 7.2, 7.3, 7.4**
  - [x] 3.10 Write property test for the reducer and views in `tests/ui/state.test.mjs`
    - **Property 8: A shown plan is replaced only by an answer**
    - Examples: `classify` of each answer shape, each row of the design's view table, an old error or notice replaced in one update, "Loading…" returning after the unreachable error state when an answer is pending
    - **Validates: Requirements 9.1, 9.5**
  - [x] 3.11 Check `renderBoard` and `STYLE` in `tests/ui/render.test.mjs`
    - No `button`, `a`, `input` or click handler in any view, and `summary` is the only interactive element; one `details`; heading levels in every view with no level skipped; the roles in each view, and no other `alert`; markup in names, descriptions and problems is a literal child
    - Description, folder name and "No spec yet" on cards; bar `aria-hidden` and absent without a fraction; header text; the "Checking for updates…" slot always in the tree; the failed-fetch notice with reason and age; the unreachable notice and error state; the empty-plan text; the error with message, code and each `settings` entry; disclosure summary counts and every problem untruncated
    - Scan `STYLE` for colour literals and `outline: none`, and check that it holds the 720px container query and its `@supports` fallback
    - _Requirements: 1.3, 1.4, 2.3, 2.4, 2.5, 3.1, 3.2, 3.3, 3.4, 3.5, 8.1, 8.3, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6, 10.1, 10.2, 10.3, 10.4_
  - [x] 3.12 Write `tests/test_ui.py`
    - Run `node --test` as a subprocess from the repository root with the sorted list of `tests/ui/*.test.mjs` files, built in Python (Node 22 rejects the directory form `tests/ui/`), and fail with node's output if it fails; skip with a stated reason when `node` is not on the path
    - Check that `app.json` keeps its route and backend declarations (name `epic-board`, backend entry point `backend/server.py`, health check, routes, the one UI page at `/apps/epic-board` with `index.mjs`) and adds no `permissions.api` entry
    - _Requirements: 1.1_
  - [x] 3.13 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each; a skipped page test is reported as skipped, not as passed
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 2.1, 2.2, 3.4, 7.1, 7.2, 7.3, 7.4, 8.2, 9.1, 9.5_

- [x] 4. Page component
  - [x] 4.1 Add `createBoard(React)` to `ui/index.mjs`
    - Use `useReducer(reduce, initialState)` and `useEffect`; render a `<style>` element with `STYLE` and `renderBoard(h, viewOf(state))` inside one root element
    - In the effect, create the poller with `request` as a GET of `/apps/epic-board/api/plan` (same origin, no cache, with the abort signal) resolving `{status, body}` and rejecting on a connection failure or invalid JSON, `hidden` as `() => document.hidden`, `setTimer` and `clearTimer` as `setTimeout` and `clearTimeout`, and `onResult` as `dispatch(result)` (the poller has already classified the answer)
    - Add a `visibilitychange` listener that calls `visible()` when `document.hidden` is false; the cleanup calls `stop()` and removes the listener
    - Make no request other than reads of the plan route; use no added dependency or build step
    - _Requirements: 1.2, 7.1, 7.2, 7.3, 7.4, 9.1, 9.3, 9.4, 9.5_
  - [x] 4.2 Replace the placeholder with the board as the default export
    - The default export reads `window.__kirocrew_modules.react` on first call, builds the component once with `createBoard`, and returns `createElement(Board, props)`; remove the placeholder component and its request code
    - Leave `app.json` unchanged
    - _Requirements: 1.1, 1.2_
  - [x] 4.3 Check the component wiring in `tests/ui/board.test.mjs`
    - Use a fake React (`useReducer`, `useEffect` with cleanup, `createElement`), a fake `document` and a fake `fetch`
    - Opening the page sends one GET of the plan route and no other request; a hidden page sends none; becoming visible requests at once; unmounting stops the poller and removes the listener; the default export builds the component once; importing the module needs no `window`
    - Scan `ui/index.mjs` for `innerHTML` and `dangerouslySetInnerHTML`
    - _Requirements: 1.1, 1.2, 1.4, 7.1, 7.2_
  - [x] 4.4 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 7.1, 7.2, 7.3, 7.4_

- [x] 5. Check it works end to end
  - [x] 5.1 Run the backend on this repository and on throwaway checkouts
    - Start `backend/server.py` with a `PORT` and `EPIC_BOARD_REPOSITORY` set to this repository and request `/health` and `/plan`; the first answer is 202 `{"pending": true}` or a first-read plan with `fetch` `{"ok": null}` and `age_seconds` null; later answers have `fetch` `{"ok": true}`, `age_seconds` of 0 or more and `refreshing`
    - Compare the cards with the epic and spec files on main: each story line's description appears on its card, a card with no description has `""`, and the spec counts match `tasks.md`
    - On a throwaway clone, push a commit to its origin, wait 60 seconds, request `/plan` and see a second plan with the new commit; break the throwaway origin (rename it) and see a plan that keeps its groups with `fetch.ok` false, the reason and an unchanged `age_seconds`
    - On a throwaway clone, set `remote.origin.uploadpack` to `sleep 20; git-upload-pack` so the fetch is slow; request `/plan` while the refresh runs and see an answer within 1 second with `refreshing` true
    - Try the error cases: no setting (409 on every request, no git run), a path that is not a checkout (409), and a query string carrying another `repo` path (ignored); do not change this repository's own settings or `config.json`
    - _Requirements: 4.1, 4.2, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 6.1, 6.2, 6.3, 6.4, 6.5_
  - [x] 5.2 Install the app in Kiro Crew and check the page (done by you in the app)
    - Install the app, set `config.json` or the environment variable, and open the page; confirm the host loads the default export and shows the board, and "Loading…" gives way to the board without a reload
    - Check light and dark themes (text and backgrounds from the host, nothing disappears), three columns at 720 px and wider and stacked below with the host sidebar open and closed, long names wrapping inside cards, the reserved space (columns do not move when "Checking for updates…" appears), the focus ring on the disclosure summary and Enter and Space toggling it, and that switching tabs stops requests and switching back requests at once
    - Check the heading level: if the host already has an `h1`, change the one constant in `ui/index.mjs` to move the title, column headings and group headings down together; confirm that the host ignores the page module's named exports (open question 3 in the design)
    - _Requirements: 1.1, 2.4, 2.5, 3.1, 7.1, 7.2, 8.3, 10.1, 10.2, 10.4_

- [x] 6. A started story moves to In progress
  - [x] 6.1 Place started cards in `columnsOf`
    - Give `columnsOf(plan, started)` a second argument, the set of card ids that have a chat record, empty when it is not given; a card whose status is planned and whose id is in `started` goes to In progress, and every other card stays in the column of its status
    - In the board component, build `started` from the chat records (`chats.records`, their `card_id`) and pass it through `viewOf` to `columnsOf`, so the filter and the column counts use the same columns
    - Change no backend file: the plan stays what main says, and the card's status field is unchanged
    - _Requirements: 2.1, 2.2, 2.6_
  - [x] 6.2 Test the placement in `tests/ui/`
    - Update the test of Property 4 to generate a set of started ids as well, and check that every card is in exactly one column, In progress for a planned started card and its status's column otherwise
    - Add examples: a planned card with a chat record is in In progress and counts there; an in-progress card with a record stays in In progress; a done card with a record stays in Done; a card whose record is removed goes back to Planned
    - _Requirements: 2.1, 2.2, 2.6_
  - [x] 6.3 Update the README and the epic
    - In `README.md`, change "Cards come from `main` only, so a card moves when its work lands" to say that a card moves to In progress when you start it and to Done when its work lands on main
    - In `docs/epics/epic-board.md`, change "it changes column only when its work lands on main" to the same rule
    - _Requirements: 2.6_
  - [x] 6.4 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 2.1, 2.2, 2.6_
  - [ ] 6.5 Check it on the board (done by you in the app)
    - Start a conductor on a planned card and see the card move to In progress at once, with its chat state; see a done card stay in Done
    - _Requirements: 2.6_

## Notes

- Each group is one pull request and is merged by the owner; start the next group from the updated main
- Group 2 is the one that makes the first story's code and tests match the edited criteria of the earlier spec; no file of the earlier spec is edited
- No task is optional: every task checks a requirement of this spec
- The owner answered the Node question by asking group 1 to add a line to `AGENTS.md` saying the page tests need Node and run through `tests/test_ui.py`; the other open questions (a property-testing library, the heading level and named exports) are for the owner

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3"] },
    { "id": 3, "tasks": ["2.1", "2.3"] },
    { "id": 4, "tasks": ["2.2", "2.4", "2.8", "2.10"] },
    { "id": 5, "tasks": ["2.5", "2.9"] },
    { "id": 6, "tasks": ["2.6"] },
    { "id": 7, "tasks": ["2.7"] },
    { "id": 8, "tasks": ["2.11"] },
    { "id": 9, "tasks": ["2.12"] },
    { "id": 10, "tasks": ["3.1"] },
    { "id": 11, "tasks": ["3.2"] },
    { "id": 12, "tasks": ["3.3", "3.6", "3.7", "3.8"] },
    { "id": 13, "tasks": ["3.4", "3.10"] },
    { "id": 14, "tasks": ["3.5", "3.11"] },
    { "id": 15, "tasks": ["3.9", "3.12"] },
    { "id": 16, "tasks": ["3.13"] },
    { "id": 17, "tasks": ["4.1"] },
    { "id": 18, "tasks": ["4.2"] },
    { "id": 19, "tasks": ["4.3"] },
    { "id": 20, "tasks": ["4.4"] },
    { "id": 21, "tasks": ["5.1"] },
    { "id": 22, "tasks": ["5.2"] },
    { "id": 23, "tasks": ["6.1"] },
    { "id": 24, "tasks": ["6.2", "6.3"] },
    { "id": 25, "tasks": ["6.4"] },
    { "id": 26, "tasks": ["6.5"] }
  ]
}
```
