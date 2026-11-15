# Implementation Plan

## Overview

One pull request on branch `story/set-up-projects`, cut from `origin/main` after "Switch projects" has landed. Never merge; the owner reviews and merges.

The work has five numbered tasks, each with sub-tasks. Run the full test suite after tasks 1 and 3 and once at the end. Tick each sub-task in this file as it is done.

## Tasks

- [x] 1. Backend: setup.py, projects.py, server.py
  - [x] 1.1 Add `backend/setup.py`
    - `is_git_checkout(path)`: returns True when `path` is an existing directory with a `.git` entry (file or directory); uses `os.path.isdir` and `os.path.exists`; does not follow symlinks
    - `validate_setup_entry(entry, i)`: returns None on success or a human-readable error string; checks `folder_id` (non-empty str ≤ 200 chars), `name` (non-empty str ≤ 100 chars, not only whitespace), `repository` (str that expands via `os.path.abspath`/`expanduser` to an `is_git_checkout` path)
    - `load_setup(data_dir)`: reads `setup.json`; returns `([], None)` when the file is missing; `(entries, None)` on success where entries is a list of `{folder_id, name, repository}` dicts; `([], error_text)` on any parse or I/O failure; never raises
    - `save_setup(data_dir, entries)`: creates `data_dir` if it does not exist; writes `{"projects": entries}` to a temp file in `data_dir`, then renames it to `setup.json` atomically; raises `OSError` on failure
    - _Requirements: 6.1, 6.6, 7.2, 7.3, 7.4, 7.6_
  - [x] 1.2 Update `backend/projects.py`
    - `load_projects(environ=None, app_dir=None, data_dir=None)` gains `data_dir`
    - When `data_dir` is supplied, call `load_setup(data_dir)` first; if it returns non-empty entries, build a `Project` list from them (same id/name/folder/records_file rules as `_load_multi`); set `source = 'saved'`; skip config.json and env vars for the Project_List (but still read config.json to set `config_has_projects`)
    - When no `data_dir` or `setup.json` is absent, fall through to the existing logic; set `source` to `'config'`, `'legacy'` or `'unconfigured'` as the path taken
    - `config_has_projects` is `True` when `config.json` has a syntactically valid `projects` key (a non-empty list of objects with `name` and `repository`), regardless of which source is active
    - Return signature becomes `(projects, error, source, config_has_projects)`; callers in `server.py` updated to unpack all four
    - The existing `load_repository` and `load_folder` functions stay as they are
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 6.4, 6.5, 6.7_
  - [x] 1.3 Update `backend/server.py`
    - Add `import threading` at the top
    - Add `RuntimeState` class as the design gives it: `snapshot()` returns a copy of the running list under the lock; `rebuild(new_running, new_source)` swaps and returns the old list
    - `RuntimeState` also holds `config_has_projects`, `config_path`, `data_dir` and `secret` for use by `POST .../setup`
    - Change `make_handler(state: RuntimeState, ...)` to take `state` instead of `(running_projects, error, config_path)`; each request method calls `state.snapshot()` once; `state.error` replaces the old `error` closure; `state.config_path` replaces `config_path`
    - Add `GET .../setup` to `do_GET` (before `/projects`): no signature; returns `{"source": state.source, "config_has_projects": state.config_has_projects, "projects": [{id, name, folder_id or null}]}` from `state.snapshot()`; runs no git and reads no file
    - Add `POST .../setup` to `do_POST` (before the chats routing):
      1. Read body (up to `MAX_BODY_BYTES`; reuse the existing length-check pattern)
      2. Verify gateway signature with `proxyauth.verify` and `state.secret`; answer 401 `unauthorized` on failure
      3. Parse body as a JSON object with exactly `projects`; validate it is a list of 1–20 dicts each with exactly `folder_id`, `name`, `repository`; answer 400 `invalid_request` on any shape error
      4. `validate_setup_entry` for each entry; answer 400 on first failure naming the entry
      5. `save_setup(state.data_dir, entries)`; answer 500 on OSError
      6. `load_projects(data_dir=state.data_dir)` to build new Project list from the new file
      7. Build new `RunningProject` list: reuse existing `RunningProject` objects whose `id` is still in the new list (keep the same holder running); create new ones for new projects (new `Holder`, started at once); collect the old list from `state.rebuild(new_running, new_source)`
      8. Stop holders of `RunningProject` objects in the old list that are not in the new list; call `holder.stop()` if it exists, otherwise dereference
      9. Answer 200 `{"projects": [{id, name}], "source": new_source}`
    - Add `'setup': 400` to `CHAT_STATUS` (or handle the new `/setup` codes inline)
    - Update `__main__` to call `load_projects(data_dir=dd)`, unpack all four values, build `RuntimeState` and pass it to `make_handler`
    - `GET .../projects` route updated to read `state.snapshot()` instead of the closed-over `running_projects`
    - _Requirements: 1.3, 6.2, 6.3, 7.1, 8.1_
  - [x] 1.4 Tests in `tests/test_setup.py` (new) and `tests/test_server.py` (updated)
    - `tests/test_setup.py`:
      - `is_git_checkout`: True for a real checkout (`.git` dir), True for a worktree (`.git` file), False for a plain dir, False for a missing path
      - `validate_setup_entry`: None for a valid entry; error string for empty `folder_id`, `folder_id` over 200 chars, non-string `folder_id`; empty `name`, whitespace-only `name`, `name` over 100 chars; non-string `repository`, path that is not a checkout, relative path that expands to a checkout
      - `load_setup`: returns `([], None)` for missing file; `(entries, None)` for valid file; `([], msg)` for unreadable file, non-object file, missing `projects` key, non-list `projects`
      - `save_setup`: written file has the right form; second save replaces it; a failed write (bad path) raises `OSError`; temp file is gone after success
    - `tests/test_server.py`:
      - `GET .../setup`: returns `{source, config_has_projects, projects with folder_id}` for a one-project `RuntimeState`; returns source `'unconfigured'` for empty list; no signature required
      - `POST .../setup` happy path: saves the file, returns 200 with new list, `state.snapshot()` reflects new projects
      - `POST .../setup` failures: 401 for missing/bad signature; 400 for each shape error (not a list, too many entries, missing `folder_id`, `name` over 100 chars, `repository` not a checkout); file not written on 400
      - `POST .../setup` rebuild: a project id that stays keeps its old `RunningProject`; a new id gets a new `RunningProject`; a removed id's holder is stopped
      - Existing `server.py` tests updated: replace `make_handler(running, error, config_path)` calls with a `RuntimeState` and the new signature; every existing case still passes
    - _Requirements: 2.1, 2.3, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6, 8.1_
  - [x] 1.5 Run the tests
    - `python3 -m unittest discover -s tests -t .` and report the counts run, passed and skipped
    - _Requirements: all of task 1_

- [x] 2. Page: pure parts
  - [x] 2.1 Add `readFolders(body)` to `ui/index.mjs`
    - Returns `null` when `body` is not an array
    - Builds a `Map(id → item)` from body for parent lookup
    - For each item in `body` order: skip items where `hidden === true`, `owner_app` is a non-empty string, or `mate_home === true`; resolve directory by walking `parent_id` chain (following up to 20 hops to guard against cycles; a cycle stops at the hop limit and counts as no directory); skip items with no resolved directory; push `{id, name, project_dir: resolved}` into result
    - When walking the parent chain, skip a parent that is itself excluded (hidden/owner_app/mate_home)
    - `id` and `name` must be strings; skip items where either is not a string
    - _Requirements: 3.2, 3.4, 3.5_
  - [x] 2.2 Add `initialSetup` and `setupReduce(state, action)` to `ui/index.mjs`
    - `initialSetup = { phase: 'closed', folders: null, setupInfo: null, checks: {}, names: {}, saveError: null }`
    - Actions and transitions:
      - `'setup-open'` → `{ ...initialSetup, phase: 'opening' }` (clears all prior state)
      - `'setup-loaded'` (`{folders, setupInfo}`) → `phase: 'ready'`; pre-fill `checks` and `names`: for each folder, tick it and set its name if `folder.id` matches a `folder_id` in `setupInfo.projects`, using that project's `name`; otherwise untick and leave name as `''` (the input defaults to `folder.name`)
      - `'setup-load-failed'` (`{message}`) → `phase: 'error', saveError: message`
      - `'setup-check'` (`{folderId, checked}`) → toggle `checks[folderId]`; when unticking, do not clear `names[folderId]`
      - `'setup-name'` (`{folderId, value}`) → set `names[folderId]`
      - `'setup-saving'` → `phase: 'saving', saveError: null`
      - `'setup-save-failed'` (`{message}`) → `phase: 'ready', saveError: message`
      - `'setup-close'` → `initialSetup`
    - _Requirements: 4.2, 4.3, 4.4, 4.5, 4.6, 4.7_
  - [x] 2.3 Tests in `tests/ui/setup.test.mjs` (new)
    - `readFolders`: null/non-array body → null; empty array → []; item missing id or name → skipped; `hidden: true` → excluded and not an ancestor source; `owner_app: 'x'` → excluded; `mate_home: true` → excluded; item with no `project_dir` and no parent → excluded; item with no `project_dir` but parent has one → included with parent's dir; chain of two parents → resolves to grandparent's dir; cycle (A→B→A) hits hop limit → excluded; item excluded by hidden whose child would otherwise use it → child excluded too
    - `setupReduce`: each action case; `'setup-loaded'` with a matching folder_id pre-ticks and fills name; `'setup-loaded'` with no match leaves folder unticked; `'setup-check'` toggles without clearing the name; `'setup-open'` resets all state
    - _Requirements: 3.2, 3.4, 3.5, 4.2, 4.3, 4.4_
  - [x] 2.4 Run the tests
    - `python3 -m unittest discover -s tests -t .` and report counts

- [x] 3. Page: render and wiring
  - [x] 3.1 Add `renderSetupView(h, setupState, actions)` to `ui/index.mjs`
    - Returns `null` when `setupState.phase === 'closed'`
    - `'opening'` → spinner or "Loading…" text with `role="status"` and a close control
    - `'error'` → error message with `role="status"` and a "Try again" button and a close control
    - `'ready'` with no Selectable_Folders → "No Crew folders have a project directory. Set a project directory in Crew first." and a close control; no Save button
    - `'ready'` with folders → folder list; each row: a checkbox labelled with the folder name, the folder's resolved directory as a secondary line of literal text, and (when ticked) a text input defaulting to the folder's name when `names[id]` is `''`; above the list, the config.json notice when `setupState.setupInfo?.source === 'saved' && setupState.setupInfo?.config_has_projects` with `role="status"`; a Save button active only when at least one folder is ticked and all ticked folders have a non-empty name; a Cancel control
    - `'saving'` → same view with Save button disabled and a "Saving…" text with `role="status"` on the button or beside it; Cancel control absent while saving
    - `saveError` (non-null in `'ready'`) → error message with `role="status"` above the Save button
    - All folder names and directory paths shown as literal text (never innerHTML or Markdown)
    - Every control reachable by keyboard; focus indicator not suppressed; Save and Cancel act on Enter/Space
    - No heading element added
    - _Requirements: 3.3, 3.5, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 4.9, 9.1, 9.2, 9.3, 9.4, 9.5, 9.6_
  - [x] 3.2 Add the Projects button and Unconfigured state to `renderBoard`
    - Projects button: always rendered in the header row (or in the filter row); `aria-label="Set up projects"` when icon-only; `aria-expanded="true"` when `setupState.phase !== 'closed'`; fires `actions.openSetup`
    - Unconfigured state: when `view.unconfigured === true`, render the first-run notice ("Choose your projects" text with `role="status"`) and a "Set up projects" button that also fires `actions.openSetup`; no columns rendered in this state
    - `renderBoard` receives `{..., setupState, unconfigured}` in its `view` and `{..., openSetup}` in its `actions`
    - _Requirements: 4.1, 5.1, 5.2, 5.3, 9.3, 9.5_
  - [x] 3.3 Wire setup into `createBoard`
    - `const [setupState, setupDispatch] = useReducer(setupReduce, initialSetup)`
    - `openSetup()`: dispatch `'setup-open'`; then fire `Promise.allSettled([api.get('/api/chat/folders'), makeBackend(fetchFn).get('/setup')])` with a 10-second timeout (abort signal); on success dispatch `'setup-loaded'` with `{folders: readFolders(foldersBody) ?? [], setupInfo: setupBody}`; on any failure dispatch `'setup-load-failed'` with the error message
    - `tryAgain()`: same as `openSetup()` but from within the error state; re-dispatch `'setup-open'` and re-fetch
    - `saveSetup(checkedFolders)`: build the body `{projects: [{folder_id, name, repository}]}` from `setupState`; dispatch `'setup-saving'`; call the backend with `makeBackend(fetchFn).post('/setup', body)` (the host's gateway signs it automatically); on 200 dispatch `'setup-close'` then re-read `GET .../projects` and dispatch `{kind: 'projects-read', ...}` to trigger the existing switch-project reset; on failure dispatch `'setup-save-failed'` with the error message
    - `unconfigured` passed to `renderBoard` when `projectsPhase === 'ready' && (!projects || projects.length === 0)`; plan and chats pollers do not start in this state (guard the plan-poller `useEffect` with `!unconfigured`)
    - After a successful save and re-read of `/projects`: dispatch `{kind: 'projects-read', projects, savedId: loadProject(storage)}` so the existing switch-project logic keeps the current project when its id is still in the new list and falls back to the first project when it is not; the epic filter resets to `'all'` (send `{kind: 'filter', value: 'all'}` and `saveChoice(storage, 'all')`), the board state resets as a project switch does
    - _Requirements: 1.2, 3.1, 3.6, 4.5, 4.6, 5.4, 8.2, 8.3, 9.7_
  - [x] 3.4 Tests in `tests/ui/board.test.mjs` and `tests/ui/setup.test.mjs`
    - `board.test.mjs`: Projects button is in the render output when `projects.length > 0` (not unconfigured), when `projects.length === 1` (button still present), and when `unconfigured = true` (button still present in the notice); Unconfigured state: notice text present, columns absent
    - `setup.test.mjs`: `renderSetupView` with phase `'closed'` → null; phase `'ready'` with no folders → "No Crew folders" text; phase `'ready'` with two folders → two checkboxes; config.json notice shown when source=saved and config_has_projects; Save button disabled when nothing ticked; Save button disabled when a ticked folder has an empty name; Save button enabled when one ticked folder has a non-empty name; `'saving'` → Save disabled; `saveError` shown; `'error'` → error text and Try again button
    - `createBoard` integration (reuse existing test harness): after `openSetup` resolves with a valid folders + setupInfo response, `setupState.phase === 'ready'`; after a successful `saveSetup`, `setupState.phase === 'closed'` and projects are updated; Unconfigured: plan poller does not fire when `projects = []`
    - _Requirements: 2.4, 3.1, 3.3, 4.1, 4.3, 4.4, 4.5, 4.6, 5.1, 5.2, 5.3, 5.4, 8.2, 8.3_
  - [x] 3.5 Run the tests
    - `python3 -m unittest discover -s tests -t .` and report counts

- [x] 4. Plumbing and spec edits
  - [x] 4.1 Update `app.json`: add `/api/chat/folders` to `permissions.api` so the list reads `["/api/chat", "/api/chat/slots", "/api/chat/folders"]`
    - _Requirements: 1.1_
  - [x] 4.2 Edit `.kiro/specs/start-a-story/requirements.md` Requirement 1, criterion 3 in place
    - Change "SHALL list exactly `/api/chat` and `/api/chat/slots`" to "SHALL list exactly `/api/chat`, `/api/chat/slots` and `/api/chat/folders`"
    - Leave the rest of that criterion unchanged
    - _Requirements: 1.1_
  - [x] 4.3 Run all tests and report final counts
    - `python3 -m unittest discover -s tests -t .`

- [x] 5. Manual check on a Crew host
  - [x] 5.1 Fresh install (no `config.json`, no `setup.json`): open board, see "Choose your projects" notice; activate "Set up projects", see the Projects view open with the person's Crew folders (excluding hidden, owner_app and mate_home folders); tick one, name it, save; board shows that project's plan at once
    - _Not checked on the host: on 15 November 2026 a fresh install was checked against the real backend in the review of pull request 36 (a signed save, then the plan and the chats answered without a restart), and is covered by tests._
  - [x] 5.2 Config.json override: with `config.json` having a valid `projects` key, open the Projects view; it pre-fills from that config (folder IDs match); save; the board uses the saved setup; reopen the view and see the config.json notice
    - _Checked on the Crew host on 15 November 2026. Pre-filled from `config.json`, saved, and the notice shown on reopening._
  - [x] 5.3 Restart: stop and start the backend; the saved `setup.json` is used; the same project loads
    - _Checked on the Crew host on 15 November 2026. Crew's gateway was restarted; the board loaded both projects from `setup.json`._
  - [x] 5.4 Signed request: confirm `POST .../setup` is accepted by the host gateway (the same kind of check as switch-projects group 5)
    - _Checked on the Crew host on 15 November 2026. The save through the host was accepted and `setup.json` was written._
