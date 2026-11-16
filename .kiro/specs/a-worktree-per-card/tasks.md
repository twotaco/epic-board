# Implementation Plan

## Overview

The work is four task groups. Each group is one pull request on its own branch, named `story/a-worktree-per-card-g1` to `story/a-worktree-per-card-g4`, cut from the latest main after the previous group's pull request is merged. Each group lands green on its own and leaves the app working.

**Before starting group 1:** confirm the answers to Open Questions A, B and C in the design. The build MUST NOT start until A is confirmed, because the start flow depends on how the conductor chat gets its working directory.

Group 1 covers all backend changes: git worktree operations, chat record fields, brief steps, project/setup setting, and new routes. Group 2 covers the page start flow: Projects view checkbox, start question, and start sequence creating the Worktree_Folder. Group 3 covers the page cleanup flow: detecting a merged or closed PR and removing the worktree. Group 4 is the check on a Crew host.

## Tasks

- [ ] 1. Backend: worktree operations, routes, setting and brief
  - [ ] 1.1 Confirm Open Questions A, B and C
    - Read Crew's source at `src/kiro_crew/dashboard/chat_folders_routes.py` to confirm whether `POST /api/chat/folders` accepts `project_dir` for apps
    - If not, check `chat_slots_routes.py` for a `project` parameter in `POST /api/chat/slots`
    - Read `website/src/types/index.chat.ts` or the app-kit docs to confirm whether `DELETE /api/chat/folders/<id>` exists for apps
    - Confirm whether `/api/chat/folders` in `app.json` covers POST and DELETE, or whether separate entries are needed
    - Write the answers into the design's Open Questions section (A, B and C)
    - _Requirements: 2.1, 2.8, 5.3, 7.1_
  - [ ] 1.2 Add `worktree_path` and `create_worktree` / `remove_worktree` to `backend/gitsource.py`
    - Add pure function `worktree_path(repository, branch)`: returns `<parent>/<basename>--<branch-slug>` where branch-slug replaces `/` with `--`
    - Add `create_worktree(repository, path, branch, main_branch)`: runs `git fetch origin` then `git worktree add -b <branch> <path> origin/<main_branch>`; returns `(True, None)` on success, `(False, error_text)` on failure; if path already exists as a worktree, returns `(True, None)`; on `worktree add` failure, force-removes the partial path
    - Add `remove_worktree(repository, path, force=False)`: runs `git worktree remove [--force] <path>`; returns `(True, None)` or `(False, error_text)`
    - _Requirements: 2.2, 2.3, 2.4, 5.2, 6.5_
  - [ ] 1.3 Update `chats.py`: Chat_Record fields and `build_brief`
    - Add `worktree_path` and `worktree_folder_id` to `RECORD_KEYS`
    - Update `_check_records`: treat missing keys as `null`; validate `worktree_folder_id` as `null` or matching `NAME_PATTERN`; validate `worktree_path` as `null` or a non-empty string of at most 1000 characters
    - Update the writer to always include both new fields (as `null` when absent)
    - Add `worktree_path=None` parameter to `build_brief`; when non-empty: insert Setup_Step as step 1 and Catch_Up_Step after the work steps, before the name-check step, in both variants
    - _Requirements: 2.5, 3.1–3.7_
  - [ ] 1.4 Update `setup.py` and `projects.py`
    - In `validate_setup_entry`: accept optional `"worktree"` key; must be a JSON boolean when present; reject non-boolean with an error message
    - In `load_setup`: include `worktree` from each entry (default `True` when absent)
    - Add `worktree` field to the `Project` namedtuple (default `True`)
    - In `load_projects`, `_load_from_saved` and `_load_multi`: read the `worktree` value from the entry and pass it to `Project`; treat absent as `True`
    - In `GET .../projects` and `GET .../setup` responses: include `worktree` for each project
    - _Requirements: 1.1–1.5_
  - [ ] 1.5 Update `server.py`: reserve, routes
    - In `ChatService.reserve`: when `project.worktree` is `True`, call `worktree_path` and `create_worktree`; on failure raise `ChatError("worktree_failed", 409, ...)`; pass `worktree_path` to `build_brief`; include `worktree_path` in the reserved record (non-worktree starts use `null`)
    - Extend `POST /chats/<name>/started` body: accept optional `worktree_folder_id`; validate as `NAME_PATTERN` or absent; store in the record
    - Add `DELETE /chats/<name>/worktree` route: requires gateway signature; calls `remove_worktree`; on success answers 200 `{"ok": true}` and sets `worktree_path` to `null` in the record; on `git worktree remove` failing with uncommitted changes, answers 409 `{"code": "worktree_has_changes", "path": "...", "message": "..."}`.
    - _Requirements: 2.1–2.7, 5.2, 5.6, 5.7, 6.1–6.5_
  - [ ] 1.6 Test `gitsource.py` additions in `tests/test_gitsource.py`
    - `worktree_path` pure-function cases: separates by `--`; replaces `/` with `--`; different checkouts and branches
    - `create_worktree` with mock `run_git`: success path; fetch failure returns `(False, error)`; `worktree add` failure returns `(False, error)` and cleans up; path already exists returns `(True, None)`
    - `remove_worktree` without `--force` and with `--force`; failure path
    - Property 1 as a seeded test with at least 50 iterations
    - _Requirements: 2.2, 2.3, 2.4, 5.2_
  - [ ] 1.7 Test brief changes in `tests/test_chats.py`
    - `build_brief` with `worktree_path` set: Setup_Step is numbered step 1; Catch_Up_Step appears after work steps and before the name-check step; both no-spec and with-spec variants; with and without epic; with and without instructions
    - `build_brief` with `worktree_path=None` or absent: brief is identical to today's (existing tests pass unchanged)
    - Record validation: new fields accepted as `null` or valid values; missing fields treated as `null`; bad `worktree_folder_id` rejected
    - Property 2 as a seeded test with at least 100 iterations, seed printed on failure
    - _Requirements: 2.5, 3.1–3.7_
  - [ ] 1.8 Test setup and projects in `tests/test_setup.py` and `tests/test_server.py`
    - `validate_setup_entry`: `worktree: true` accepted; `worktree: false` accepted; `worktree: "yes"` rejected; absent treated as `true`
    - `GET .../projects`: includes `worktree` per project
    - Reserve with `worktree: true`: calls `create_worktree`; record includes `worktree_path`; returned brief includes Setup_Step
    - Reserve with `worktree: false`: record has `worktree_path: null`; brief unchanged
    - `DELETE .../worktree`: removes worktree on success; 409 on uncommitted changes; `?force=true` passes through; 404 on unknown name
    - `POST .../started` with `worktree_folder_id`: stores in record; without it: stores `null`
    - _Requirements: 1.1–1.5, 2.1–2.7, 5.2, 5.6_
  - [ ] 1.9 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and report the counts run, passed and skipped
    - _All requirements of group 1_

- [ ] 2. Page: start flow
  - [ ] 2.1 Projects view: worktree checkbox in `ui/index.mjs`
    - In `setupReduce` (or the equivalent state handler): add `worktree` per ticked folder, defaulting to `true`; persist across untick/retick
    - In `renderSetupView`: show the worktree checkbox below the name field for each ticked folder; hide when unticked; pre-tick from the saved value via `GET .../setup`
    - Include `worktree` in the POST body when saving
    - _Requirements: 1.1, 1.2, 1.3, 1.4_
  - [ ] 2.2 Start question: show mode
    - In `renderCard` (or the start question renderer): add one line after "Start a conductor on this story?" — "Works in its own worktree" or "Works in the shared checkout" — based on `project.worktree`
    - _Requirements: 1.6, 1.7_
  - [ ] 2.3 Start sequence: create Worktree_Folder and open chat in it
    - When `project.worktree` is `true`, extend the start sequence after `POST .../chats {card_id}` and before `POST /api/chat/slots`:
      1. `POST /api/chat/folders {name: <story-name>, project_dir: <worktree_path>, parent_id: <project-folder-id>}` → `{id: subfolder_id}`
      2. Create the chat in `subfolder_id` (not the project folder)
    - Include `worktree_folder_id: subfolder_id` in `POST .../chats/<name>/started`
    - If the folders call fails: call `DELETE .../chats/<name>/worktree` to clean up the backend worktree; show "Could not create worktree folder: `<reason>`." on the card
    - When `project.worktree` is `false`, the sequence is exactly as today
    - _Requirements: 2.1, 2.6, 2.8, 6.3_
  - [ ] 2.4 Test in `tests/ui/setup.test.mjs` and `tests/ui/start.test.mjs`
    - Setup: worktree checkbox shown and hidden per ticked state; default ticked; value saved in POST body
    - Start: start question shows the right mode text; start sequence calls `POST /api/chat/folders` before `POST /api/chat/slots` when worktree on; folder_id in slots call is the subfolder id; `started` body includes `worktree_folder_id`; folder creation failure calls worktree cleanup and shows error
    - _Requirements: 1.1, 1.6, 1.7, 2.1, 2.6, 2.8, 6.3_
  - [ ] 2.5 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _All requirements of group 2_

- [ ] 3. Page: cleanup flow
  - [ ] 3.1 Detect merged or closed PR in `ui/index.mjs`
    - In the chat poller state update: when a Started_Chat's `source_links` gains a PR with `state` `merged` or `closed` (a transition from `open`/`draft` to terminal), set a cleanup flag for that card
    - _Requirements: 5.1_
  - [ ] 3.2 Remove worktree and subfolder
    - When the cleanup flag is set for a card: call `DELETE .../chats/<name>/worktree`
    - On 200 `{ok: true}`: call `DELETE /api/chat/folders/<worktree_folder_id>` if the record has one (silently ignore failure); then call `DELETE .../chats/<name>` to remove the record; re-render the card
    - On 409 `worktree_has_changes`: show "Worktree kept: uncommitted changes at `<path>`." on the card with a "Remove anyway" button
    - "Remove anyway" calls `DELETE .../chats/<name>/worktree?force=true`; on success, proceeds as the 200 path above
    - When `worktree_path` is null (non-worktree record): skip the worktree route; delete the record directly
    - _Requirements: 5.1–5.5_
  - [ ] 3.3 Accessibility
    - The "Worktree kept" text has role `status`; "Remove anyway" is reachable by keyboard and acts on Enter or Space
    - _Requirement 7.2_
  - [ ] 3.4 Test in `tests/ui/board.test.mjs`
    - `source_links` PR transitions to `merged`: cleanup called; worktree removal route called; subfolder deletion called; record deleted; card reset
    - `worktree_has_changes` response: "Worktree kept" shown; "Remove anyway" button present
    - Non-worktree record: cleanup skips worktree route; deletes record directly
    - _Requirements: 5.1–5.5, 7.2_
  - [ ] 3.5 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _All requirements of group 3_

- [ ] 4. Check on a Crew host
  - [ ] 4.1 Confirm Open Questions A, B and C on the host (required before group 1 starts; this task records the results)
    - Confirm which of the two folder/project approaches works (see design Open Question A)
    - Confirm that `DELETE /api/chat/folders/<id>` works for the app (Open Question B)
    - Confirm that `/api/chat/folders` in `app.json` covers POST and DELETE (Open Question C); if not, add the needed entries and push a fix PR
    - Write the final answers into the design and update the requirements if needed
    - _Requirements: 2.1, 2.8, 5.3_
  - [ ] 4.2 Check start flow on the host
    - Start a story on a project with `worktree: true` and confirm: the worktree is created beside the checkout; the conductor's chat opens with `project_dir` set to the worktree; the brief carries the Setup_Step and Catch_Up_Step; the Projects view shows the checkbox and saves correctly
    - _Requirements: 1.1–1.7, 2.1–2.8, 3.1–3.7_
  - [ ] 4.3 Check cleanup on the host
    - Close a pull request (or merge one); confirm the board removes the worktree; confirm the card resets
    - Try a worktree with uncommitted changes; confirm "Worktree kept" is shown; confirm "Remove anyway" force-removes it
    - _Requirements: 5.1–5.6_

## Notes

- Each group is one pull request and is merged by the owner; start the next group from the updated main
- Group 1 must be built only after Open Questions A, B and C are confirmed (task 1.1); update the design before writing any code
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
    { "id": 12, "tasks": ["4.2", "4.3"] }
  ]
}
```
