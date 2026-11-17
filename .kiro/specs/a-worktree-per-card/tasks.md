# Implementation Plan

## Overview

The work is five task groups. Each group is one pull request on its own branch, named `story/a-worktree-per-card-g1` to `story/a-worktree-per-card-g5`, cut from the latest main after the previous group's pull request is merged. Each group lands green on its own and leaves the app working.

**Before starting group 1:** confirm the answers to Open Questions B and C in the design (A is resolved). Task 1.1 covers this.

Group 1 covers all backend changes: git worktree operations, chat record fields, brief steps, project/setup setting, and new routes. Group 2 covers the page start flow: Projects view checkbox, start question, and start sequence creating the Worktree_Folder. Group 3 covers the page cleanup flow: detecting a merged or closed PR and removing the worktree. Group 4 is the check on a Crew host. Group 5 replaces the auto cleanup of group 3 with a person-started Finish step (found necessary on the group 4 host check: Crew gives an app no pull request state) and ends with a second host check.

## Tasks

- [x] 1. Backend: worktree operations, routes, setting and brief
  - [x] 1.1 Confirm Open Questions B and C
    - Confirm whether `DELETE /api/chat/folders/<id>` exists for apps (design Open Question B); check `chat_folders_routes.py` or the app-kit docs; update the design's Open Question B with the answer
    - Confirm whether `/api/chat/folders` in `app.json` covers POST and DELETE as well as GET (Open Question C); if separate entries are needed, add them to `app.json` and update the start spec's Requirement 1, criterion 3; update the design's Open Question C with the answer
    - _Requirements: 2.1, 2.8, 5.3_
  - [x] 1.2 Add `worktree_path` and `create_worktree` / `remove_worktree` to `backend/gitsource.py`
    - Add pure function `worktree_path(repository, name)`: returns `<parent>/<basename>--<name>` where `name` is the Chat_Record's name (e.g. `epic-board-a3f2b1c4`)
    - Add `create_worktree(repository, path, main_branch)`: runs `git fetch origin` then `git worktree add --detach <path> origin/<main_branch>`; returns `(True, None)` on success, `(False, error_text)` on failure; if path already exists as a worktree, returns `(True, None)`; on `worktree add` failure, force-removes the partial path
    - Add `remove_worktree(repository, path, force=False)`: runs `git worktree remove [--force] <path>`; returns `(True, None)` or `(False, error_text)`
    - _Requirements: 2.2, 2.3, 2.4, 5.2, 6.5_
  - [x] 1.3 Update `chats.py`: Chat_Record fields and `build_brief`
    - Add `worktree_path` and `worktree_folder_id` to `RECORD_KEYS`
    - Update `_check_records`: treat missing keys as `null`; validate `worktree_folder_id` as `null` or matching `NAME_PATTERN`; validate `worktree_path` as `null` or a non-empty string of at most 1000 characters
    - Update the writer to always include both new fields (as `null` when absent)
    - Add `worktree_path=None` parameter to `build_brief`; when non-empty: insert Setup_Step as step 1 and Catch_Up_Step after the work steps, before the name-check step, in both variants
    - _Requirements: 2.5, 3.1–3.7_
  - [x] 1.4 Update `setup.py` and `projects.py`
    - In `validate_setup_entry`: accept optional `"worktree"` key; must be a JSON boolean when present; reject non-boolean with an error message
    - In `load_setup`: include `worktree` from each entry (default `True` when absent)
    - Add `worktree` field to the `Project` namedtuple (default `True`)
    - In `load_projects`, `_load_from_saved` and `_load_multi`: read the `worktree` value from the entry and pass it to `Project`; treat absent as `True`
    - In `GET .../projects` and `GET .../setup` responses: include `worktree` for each project
    - _Requirements: 1.1–1.5_
  - [x] 1.5 Update `server.py`: reserve, routes
    - In `ChatService.reserve`: when `project.worktree` is `True`, call `worktree_path` and `create_worktree`; on failure raise `ChatError("worktree_failed", 409, ...)`; pass `worktree_path` to `build_brief`; include `worktree_path` in the reserved record (non-worktree starts use `null`)
    - Extend `POST /chats/<name>/started` body: accept optional `worktree_folder_id`; validate as `NAME_PATTERN` or absent; store in the record
    - Add `DELETE /chats/<name>/worktree` route: requires gateway signature; calls `remove_worktree`; on success answers 200 `{"ok": true}` and sets `worktree_path` to `null` in the record; on `git worktree remove` failing with uncommitted changes, answers 409 `{"code": "worktree_has_changes", "path": "...", "message": "..."}`.
    - _Requirements: 2.1–2.7, 5.2, 5.6, 5.7, 6.1–6.5_
  - [x] 1.6 Test `gitsource.py` additions in `tests/test_gitsource.py`
    - `worktree_path` pure-function cases: appends `--<name>` to the checkout basename; different repositories and record names; path is under the checkout's parent; never includes a branch slug
    - `create_worktree` with mock `run_git`: success path uses `--detach` and `origin/<main_branch>`; fetch failure returns `(False, error)`; `worktree add` failure returns `(False, error)` and cleans up; path already exists returns `(True, None)`
    - `remove_worktree` without `--force` and with `--force`; failure path
    - Property 1 as a seeded test with at least 50 iterations
    - _Requirements: 2.2, 2.3, 2.4, 5.2_
  - [x] 1.7 Test brief changes in `tests/test_chats.py`
    - `build_brief` with `worktree_path` set: Setup_Step is numbered step 1; Catch_Up_Step appears after work steps and before the name-check step; both no-spec and with-spec variants; with and without epic; with and without instructions
    - `build_brief` with `worktree_path=None` or absent: brief is identical to today's (existing tests pass unchanged)
    - Record validation: new fields accepted as `null` or valid values; missing fields treated as `null`; bad `worktree_folder_id` rejected
    - Property 2 as a seeded test with at least 100 iterations, seed printed on failure
    - _Requirements: 2.5, 3.1–3.7_
  - [x] 1.8 Test setup and projects in `tests/test_setup.py` and `tests/test_server.py`
    - `validate_setup_entry`: `worktree: true` accepted; `worktree: false` accepted; `worktree: "yes"` rejected; absent treated as `true`
    - `GET .../projects`: includes `worktree` per project
    - Reserve with `worktree: true`: calls `create_worktree`; record includes `worktree_path`; returned brief includes Setup_Step
    - Reserve with `worktree: false`: record has `worktree_path: null`; brief unchanged
    - `DELETE .../worktree`: removes worktree on success; 409 on uncommitted changes; `?force=true` passes through; 404 on unknown name
    - `POST .../started` with `worktree_folder_id`: stores in record; without it: stores `null`
    - _Requirements: 1.1–1.5, 2.1–2.7, 5.2, 5.6_
  - [x] 1.9 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and report the counts run, passed and skipped
    - _All requirements of group 1_

- [x] 2. Page: start flow
  - [x] 2.1 Projects view: worktree checkbox in `ui/index.mjs`
    - In `setupReduce` (or the equivalent state handler): add `worktree` per ticked folder, defaulting to `true`; persist across untick/retick
    - In `renderSetupView`: show the worktree checkbox below the name field for each ticked folder; hide when unticked; pre-tick from the saved value via `GET .../setup`
    - Include `worktree` in the POST body when saving
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - [x] 2.2 Start question: show mode
    - In `renderCard` (or the start question renderer): add one line after "Start a conductor on this story?" — "Works in its own worktree" or "Works in the shared checkout" — based on `project.worktree`
    - _Requirements: 1.6, 1.7_
  - [x] 2.3 Start sequence: create Worktree_Folder and open chat in it
    - When `project.worktree` is `true`, extend the start sequence after `POST .../chats {card_id}` and before `POST /api/chat/slots`:
      1. `POST /api/chat/folders {name: "<story-name> · <last-8-of-record-name>", project_dir: <worktree_path>, parent_id: <project-folder-id>}` → `{id: subfolder_id}`. The name is capped at 100 characters by shortening the story name part (max 89 chars); when the story name is empty, the name is just the last 8 characters of the record name.
      2. Create the chat in `subfolder_id` (not the project folder)
    - Include `worktree_folder_id: subfolder_id` in `POST .../chats/<name>/started`
    - If the folders call fails: call `DELETE .../chats/<name>/worktree` to clean up the backend worktree; show "Could not create worktree folder: `<reason>`." on the card
    - When `project.worktree` is `false`, the sequence is exactly as today
    - _Requirements: 2.1, 2.6, 2.8, 6.3_
  - [x] 2.4 Test in `tests/ui/setup.test.mjs` and `tests/ui/start.test.mjs`
    - Setup: worktree checkbox shown and hidden per ticked state; default ticked; value saved in POST body
    - Start: start question shows the right mode text; start sequence calls `POST /api/chat/folders` before `POST /api/chat/slots` when worktree on; folder_id in slots call is the subfolder id; `started` body includes `worktree_folder_id`; folder creation failure calls worktree cleanup and shows error
    - _Requirements: 1.1, 1.6, 1.7, 2.1, 2.6, 2.8, 6.3_
  - [x] 2.5 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _All requirements of group 2_

- [x] 3. Page: cleanup flow
  - [x] 3.1 Detect merged or closed PR in `ui/index.mjs`
    - On every read of a Started_Chat: when the record has a `worktree_path` and its `source_links` has at least one PR with `state` `merged` or `closed` and none with `open` or `draft`, set a cleanup flag for that card. No earlier read is needed; a fresh load after a merge triggers cleanup immediately. The flag is set once per record key per page load.
    - _Requirements: 5.1_
  - [x] 3.2 Remove worktree and subfolder
    - When the cleanup flag is set for a card AND `worktree_path` is set: call `DELETE .../chats/<name>/worktree`
    - On 200 `{ok: true}`: if the record has a `worktree_folder_id`, send `PATCH /api/chat/folders/<worktree_folder_id>` with `{"project_dir": ""}` (silently ignore failure); then call `DELETE .../chats/<name>` to remove the record; re-render the card
    - On 409 `worktree_has_changes`: show "Worktree kept: uncommitted changes at `<path>`." on the card with a "Remove anyway" button
    - On any other failure from the worktree route: stop — do not PATCH, do not delete the record; the next load retries
    - "Remove anyway" calls `DELETE .../chats/<name>/worktree?force=true`; on success, proceeds as the 200 path above
    - When `worktree_path` is null (non-worktree record): do nothing — do not call the worktree route and do not delete the record; the card stays as is
    - _Requirements: 5.1–5.5_
  - [x] 3.3 Accessibility
    - The "Worktree kept" text has role `status`; "Remove anyway" is reachable by keyboard and acts on Enter or Space
    - _Requirement 7.2_
  - [x] 3.4 Test in `tests/ui/board.test.mjs`
    - Started_Chat with `worktree_path` set and `source_links` showing a merged PR (no open PR): cleanup fires on first read; worktree route called; subfolder PATCH called; record deleted; card reset
    - `worktree_has_changes` (409): "Worktree kept" shown; "Remove anyway" triggers force-remove; on success card resets
    - Non-worktree record (`worktree_path` null): no cleanup at all; card unchanged
    - Non-409 failure from worktree route: record is kept; next load retries
    - _Requirements: 5.1–5.5, 7.2_
  - [x] 3.5 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _All requirements of group 3_

- [ ] 4. Check on a Crew host
  - [ ] 4.1 Confirm Open Questions B and C on the host (builds on task 1.1 which checks the source)
    - Confirm that `DELETE /api/chat/folders/<id>` works for the app on a live install (Open Question B); update the design if the route is absent
    - Confirm that `/api/chat/folders` in `app.json` covers POST and DELETE as the live host enforces them (Open Question C); verify that the worktree subfolder was created with `owner_app` set
    - Write the final answers into the design
    - _Requirements: 2.1, 2.8, 5.3_
  - [ ] 4.2 Check start flow on the host
    - Start a story on a project with `worktree: true` and confirm: the worktree is created beside the checkout; the conductor's chat opens with `project_dir` set to the worktree; the brief carries the Setup_Step and Catch_Up_Step; the Projects view shows the checkbox and saves correctly
    - _Requirements: 1.1–1.7, 2.1–2.8, 3.1–3.7_
  - [ ] 4.3 Check cleanup on the host
    - Close a pull request (or merge one); confirm the board removes the worktree; confirm the card resets
    - Try a worktree with uncommitted changes; confirm "Worktree kept" is shown; confirm "Remove anyway" force-removes it
    - _Requirements: 5.1–5.6_

- [ ] 5. Finish replaces auto cleanup
  - [x] 5.1 Git safety checks in `backend/gitsource.py`
    - Add `worktree_has_changes(path)`: `git -C <path> status --porcelain`; returns `(True, None)` when it prints anything, `(False, None)` when empty, `(None, error_text)` when git fails
    - Add `worktree_has_unpushed(path, main_branch)`: when `rev-parse --abbrev-ref @{upstream}` succeeds count `@{upstream}..HEAD`, otherwise count `origin/<main_branch>..HEAD`; same return shape. Add the `shortcut:` comment from the design
    - _Requirements: 5.3_
  - [x] 5.2 Chat_Record state `finished` in `backend/chats.py`
    - Add `finished` to `STATES`; accept it in `_check_records` like `started`
    - `ChatStore.started()` returns every field of each `started` and `finished` record, including `state`, `worktree_path` and `worktree_folder_id`
    - Add `ChatStore.mark_finished(name)` with the refusals of the design (`chat_not_found`, `chat_not_started`, `worktree_not_removed`); already finished answers as success
    - `ChatStore.reserve` skips `finished` records; `ChatStore.mark_started` removes the card's `finished` records
    - _Requirements: 5.5, 5.8, 5.13_
  - [x] 5.3 Routes in `backend/server.py`
    - `CHATS_ROUTE` gains `finished`; add `POST /chats/<name>/finished` calling `mark_finished`
    - `remove_worktree_route`: when `worktree_path` is set but the folder is gone, clear it and answer 200; without `force`, run `worktree_has_changes` then `worktree_has_unpushed` and answer 409 `worktree_has_changes` or `worktree_has_unpushed` with the reason; any other `git worktree remove` failure answers 409 `worktree_remove_failed`; add the two new codes to the status table (`CHAT_STATUS`-style map near line 129)
    - `ChatService.reserve`: accept a Done card when the card has a `finished` record
    - _Requirements: 5.3, 5.5, 5.9, 5.12_
  - [x] 5.4 Backend tests
    - `tests/test_gitsource.py`: both checks on a real temporary repository (clean, modified, untracked, ignored-only; upstream ahead and equal; no upstream with and without commits; detached HEAD; git failure)
    - `tests/test_chats.py`: `finished` records accepted by validation; `started()` fields; `mark_finished` cases; `reserve` skips finished; `mark_started` removes finished
    - `tests/test_server.py`: worktree route refusals and `force`; folder gone from disk; `POST .../finished`; `GET /chats` fields; Done card with and without a finished record
    - _Requirements: 5.3, 5.5, 5.8, 5.9, 5.12, 5.13_
  - [x] 5.5 Remove the auto cleanup in `ui/index.mjs` and its tests
    - Delete the `prTerminated` flag in `readChats`, the `cleanups` set and the loop in the poller's `onResult`, and `cleanupRecord`; rewrite `finishCleanup` as the Finish sequence (task 5.6)
    - Replace the auto-cleanup tests in `tests/ui/board.test.mjs` and `tests/ui/chats.test.mjs` with tests of the new behaviour; add a test that a merged PR link causes no call. Change the "There is no finished" comment on `STATE_WORDS`
    - _Requirements: 5.11_
  - [x] 5.6 Finish control, confirm step, sequence and finished card
    - `STATE_WORDS.finished = 'Session finished'`; `STATE_VARIANT.finished = 'muted'`; `readChats` sets `byKey[key] = {state: 'finished'}` for a finished record without reading it
    - `cardViewOf`: prefer a `started` record over a `finished` one; mode `finished`; the question opens from a finished card; `started` set for `columnsOf` excludes finished cards
    - `uiReduce`: `finish-ask`, `finish-cancel`; `worktree-kept` carries the reason
    - `renderChatPart`: "Finish session" button for cards with a started record; the confirm group "Finish this session" (path, ignored-files line, tasks warning, "Finish session", "Cancel", Escape); in mode `finished` the badge, the card name as the link to the ended chat, and "Restart session" (`actions.ask`), shown in every column
    - `actions.finish(name, force)`: the five steps of the design; the note text exactly as in Requirement 5, criterion 6, posted with `gateway.post('/api/chat/slots/<key>/note', {content, source: 'epic-board'})`; `actions.removeWorktree` calls it with `force`
    - Keyboard and `role` rules of Requirement 7
    - _Requirements: 5.1, 5.2, 5.3, 5.4, 5.6, 5.7, 5.8, 5.10, 7.1, 7.2_
  - [x] 5.7 Page tests in `tests/ui/board.test.mjs`, `tests/ui/chats.test.mjs` and `tests/ui/state.test.mjs`
    - The cases listed under the page tests of the design's Testing Strategy; include the exact note text and `source`, a note that fails (404 or any error) leaving the card showing "Session finished", that `POST /api/chat` is never called by Finish, a worktree-off record (Finish only marks), and Restart session on a finished Done card
    - _Requirements: 5.1–5.13, 7.2_
  - [x] 5.8 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _All requirements of group 5_
  - [ ] 5.9 Check Finish on a Crew host
    - On a worktree story: Finish session with a clean pushed worktree removes the folder and shows "Session finished"; the note appears in the chat and starts no agent turn; with an uncommitted file and with an unpushed commit "Worktree kept" shows the reason and "Remove anyway" removes it; on a story with the worktree setting off Finish session only marks it
    - Restart session on the finished card (also one in Done) opens a new chat and a new worktree from origin/main
    - _Requirements: 5.1–5.13_

## Notes

- Each group is one pull request and is merged by the owner; start the next group from the updated main
- Group 1 must be built only after Open Questions B and C are confirmed (task 1.1; A is resolved); update the design before writing any code
- The existing start tests (no worktree) pass unchanged because `worktree_path=None` leaves the brief and the start sequence identical to today's
- The `app.json` permission change (if any, from Open Question C) is part of group 1

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2", "1.3", "1.4"] },
    { "id": 2, "tasks": ["1.5"] },
    { "id": 3, "tasks": ["1.6", "1.7", "1.8"] },
    { "id": 4, "tasks": ["1.9"] },
    { "id": 5, "tasks": ["2.1", "2.2", "2.3"] },
    { "id": 6, "tasks": ["2.4"] },
    { "id": 7, "tasks": ["2.5"] },
    { "id": 8, "tasks": ["3.1", "3.2", "3.3"] },
    { "id": 9, "tasks": ["3.4"] },
    { "id": 10, "tasks": ["3.5"] },
    { "id": 11, "tasks": ["4.1"] },
    { "id": 12, "tasks": ["4.2", "4.3"] },
    { "id": 13, "tasks": ["5.1", "5.2"] },
    { "id": 14, "tasks": ["5.3"] },
    { "id": 15, "tasks": ["5.4", "5.5"] },
    { "id": 16, "tasks": ["5.6"] },
    { "id": 17, "tasks": ["5.7"] },
    { "id": 18, "tasks": ["5.8"] },
    { "id": 19, "tasks": ["5.9"] }
  ]
}
```
