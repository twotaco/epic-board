# Implementation Plan

## Overview

The work is five task groups. Each group is one pull request on its own branch, named `story/switch-projects-g1` to `story/switch-projects-g5`, cut from the latest main after the previous group's pull request is merged. Each group lands green on its own and leaves the app working. Every group ends with a sub-task that runs the tests and reports the counts run, passed and skipped. Tick each task in this file in the same branch, and tick nothing in the earlier specs. The backend uses the standard library only, the page adds no dependency, and `app.json` does not change.

Start this story after "Work in the chat" (`.kiro/specs/work-in-the-chat/`, pull request 29) and the chat state change (branch `story/chat-state`) have both landed on main, because groups 3 and 4 change the page code those two change. Groups 1 and 2 touch the backend only, and could start sooner, but the chat state change may also touch `backend/server.py`, so cut them from the latest main anyway. Do not edit the specs of those two stories.

Group 1 reads the projects from the config and names their files. Group 2 makes the routes project-aware and adds `GET /projects`. Group 3 is the page's pure logic. Group 4 draws the dropdown and wires the switch into the component. Group 5 checks the whole on a Crew host, which is the only place the signature with a query and the Select can be confirmed.

## Tasks

- [ ] 1. Backend: read the projects
  - [ ] 1.1 Add `backend/projects.py` and the shared folder check
    - `load_projects(environ, app_dir)` returning `(projects, error)` as the design gives it, with `Project` as a namedtuple of `id`, `name`, `repository`, `folder`, `folder_reason` and `records_file`
    - Cut the value rules of `load_folder` into `check_folder(value, source)` in `backend/server.py` or `projects.py` (one place), and make `load_folder` and `load_projects` both use it, so that today's `load_folder` answers are unchanged
    - Ids by `slugify` of `backend/chats.py`, in list order; the Records_File is `chats.json` for the Project whose repository is the Legacy_Repository and `chats-<id>.json` for the others; the messages for a bad `projects` name the file and the entry number and hold no repository path
    - `load_repository` and `load_folder` keep their signatures and answers
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 3.2, 3.3_
  - [ ] 1.2 Let a `ChatStore` take its file name
    - `ChatStore(data_dir, filename=CHATS_FILE, new_name=..., clock=...)`; the path is `os.path.join(data_dir, filename)`; every other behaviour is as it was. The existing calls keep working because `filename` is keyword-only with the old default
    - _Requirements: 3.1, 3.4, 3.5_
  - [ ] 1.3 Check them in `tests/test_projects.py` and the existing files
    - Every fault of Requirement 1, criterion 3 (not a list, empty, more than 20, entry not an object, `name` or `repository` missing, not text or only whitespace, a `name` of 101 characters, two entries with one absolute path) answers the error with the entry named and no repository path in the message
    - A bad `folder_id` affects only its Project; `EPIC_BOARD_FOLDER` is ignored when `projects` is present; `EPIC_BOARD_REPOSITORY` and the top-level `repository` give the Legacy_Repository and add no Project; no `projects` gives one Project named after the folder, with `Project` for an empty name
    - The file rules: the Project of the Legacy_Repository gets `chats.json`, the others `chats-<id>.json`, no match and no legacy leave every Project on its own file, and `chats.json` is not read or created
    - Ids: equal names, names that slug to nothing, long names, case and punctuation differences
    - `ChatStore` with a file name reads and writes that file only, and `tests/test_chats*.py` pass unchanged
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 3.1, 3.2, 3.3, 3.4_
  - [ ] 1.4 Write property tests for ids, files and the single repository in `tests/test_projects.py`
    - **Property 2: Ids and files are unique and stable**
    - **Property 3: A single repository behaves as it did** (the loading half: one Project, today's repository and folder, `chats.json`)
    - Seeded generators of names and configs, at least 100 iterations, with the seed printed on failure
    - **Validates: Requirements 1.5, 1.6, 3.2, 3.3**
  - [ ] 1.5 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and report the counts run, passed and skipped; the page tests run through `tests/test_ui.py` and are reported as skipped when Node is missing
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 3.1, 3.2, 3.3, 3.4, 3.5_

- [ ] 2. Backend: the routes
  - [ ] 2.1 Make the server project-aware in `backend/server.py`
    - A running Project of a holder (or none when its repository has no plan), a `ChatService` with its own store, folder and holder; `ChatService.handle` is split so that the signature check is a `ChatRouter`'s and the rest, `handle_verified(method, path, body)`, is the Project's; the signature code in `backend/proxyauth.py` does not change
    - `pick_project(projects, query)` as the design gives it; `make_handler(projects, error, config_path)`; `GET .../projects` answering `[{id, name}]` with no signature, no git and no file read; the `plan` route and the `chats` routes resolve the Project (the `chats` routes after the signature check); 404 `project_not_found` and 400 `invalid_request` as Requirement 2, criterion 3 says, and the new code added to the status table
    - Start every Project's holder at launch, and make each Project's Records_File from `load_projects`; a config error leaves the list empty, answers the plan route with the error and the `chats` routes with 409 `repository_not_configured` after the signature check
    - The body of the `plan` route and every other status code are as they were
    - _Requirements: 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.5, 3.6, 3.7_
  - [ ] 2.2 Check them in `tests/test_server.py` and the existing files
    - `pick_project` for none, one, many, unknown and empty values; `GET /projects` for two Projects, none, no signature, and a method other than GET; the `plan` route for two Projects with two fake holders (the right one answers, and one Project's error does not touch the other's plan); the `chats` routes for two Projects with two stores in a temporary folder (a reservation, a `started` call and a removal in one leave the other's records as they were); a record for a Card_Id in both Projects
    - An unreadable Records_File in one Project leaves the other's `chats` routes working; a Project whose repository is not a checkout leaves the other's plan working
    - Update the existing server tests to the new handler shape and keep every case as a single-Project case, with no case deleted or weakened
    - _Requirements: 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 3.1, 3.5, 3.6, 3.7_
  - [ ] 2.3 Write property tests for the routes in `tests/test_server.py`
    - **Property 1: A project's answers come from that project only**
    - **Property 3: A single repository behaves as it did** (the routes half: the same bodies and status codes with no `project` and with the Project's own Id)
    - **Property 4: The signature covers the project**
    - Seeded Project lists and request sequences, at least 100 iterations, with the seed printed on failure
    - **Validates: Requirements 1.5, 2.1, 2.2, 2.3, 2.6, 3.1, 3.6, 3.7**
  - [ ] 2.4 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and report the counts run, passed and skipped
    - _Requirements: 1.8, 2.1, 2.2, 2.3, 2.4, 2.5, 2.6, 2.7, 3.1, 3.5, 3.6, 3.7_
  - [ ] 2.5 Update the earlier specs for the backend
    - Edit in place, as "Edits to earlier specs and checks" in the design lists: the first spec's Requirement 1, the board spec's `plan` route, the start spec's Requirement 1 (criteria 1 and 4) and Requirement 5 (criteria 4 to 7). Each edit is a short pointer to this story's requirement, with the old rule kept for one project. Tell the owner in the pull request which specs changed
    - _Requirements: 1.5, 2.2, 3.2, 3.6_

- [ ] 3. Page: the pure parts
  - [ ] 3.1 Read the landed code, then add the pure functions and the state to `ui/index.mjs`
    - Read what "Work in the chat" and the chat state change left in `ui/index.mjs`: the chats state, the chat poller, `makeBackend`, the panel's `open` and the `uiReduce` actions. Write down any name that differs from this design's, and use the landed names. If the panel's `open` or the chats poller has moved out of the places the design assumes (Open Questions 6 and 7), stop and report it with `work_report` as a question
    - `readProjects`, `resolveProject`, `projectOptions`, `loadProject`, `saveProject` and `projectQuery` as the design gives them, sharing one try/catch with `loadChoice` and `saveChoice`, which keep their names and behaviour
    - A `projects` reducer with `projects-read`, `projects-failed` and `switch` (the same state for the current Id); a `reset` action in the plan, chats and `ui` reducers that returns the initial value
    - `makeBackend(fetchFn, projectId)` appends `projectQuery(projectId)` to every path it is given, and the plan URL is built with it too; nothing else in the file changes
    - _Requirements: 4.4, 4.5, 4.6, 4.7, 5.1, 5.2, 6.1_
  - [ ] 3.2 Check them in `tests/ui/projects.test.mjs` and the existing files
    - `readProjects` for a good list, an empty list, a list that is not a list, a duplicate Id, an Id that does not match the pattern and a name that is not text; `resolveProject` for a saved Id that is in the list, not in it, `null` and an empty list; `projectOptions` for none, one and several (null below two); `loadProject` and `saveProject` with no storage, a storage that throws on each call and a stored value that is not text; `projectQuery` for an Id with characters that need encoding and for `null`
    - The reducers: `switch` to the current Id returns the same state, `reset` returns the initial value in the three reducers, and no other action changes `projects`
    - `makeBackend` with an Id adds the query to `/chats`, `/chats/<name>/started` and `/chats/<name>`, and with `null` adds nothing
    - _Requirements: 4.4, 4.5, 4.6, 4.7, 5.1, 5.2, 6.1_
  - [ ] 3.3 Write property tests for the switch in `tests/ui/projects.test.mjs`
    - **Property 6: A switch resets exactly what it should**
    - Seeded page states and switches, at least 100 iterations, with the seed printed on failure
    - **Validates: Requirements 4.5, 4.6, 5.1, 5.7**
  - [ ] 3.4 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 4.4, 4.5, 4.6, 4.7, 5.1, 5.2, 6.1_

- [ ] 4. Page: the dropdown and the switch
  - [ ] 4.1 Draw the dropdown in `ui/index.mjs`
    - `renderProjects` as the design gives it: Crew's `Select` with exactly `aria-label`, `value`, `options` (strings), `optionLabels` and `onChange`, and a native `select` otherwise; `renderFilters` draws the project dropdown and then the epic dropdown in `div.eb-filters`, the project dropdown only when `view.projects` is not null; the error branch draws it too
    - The notice "Could not read the list of projects." with the role `status`; the `.eb-filters` rule in `STYLE`, with no colour and no outline rule; names are children and values, never markup
    - _Requirements: 4.2, 4.3, 4.4, 7.2, 7.3, 7.4, 7.6_
  - [ ] 4.2 Wire the switch into `createBoard`
    - Read the Project_List first (the board's loading state until it ends), resolve the Current_Project with the saved choice, and run no poller until then; the plan and chat effects depend on the Current_Project and its phase, close over their Project_Id, and make every request, including the start's, with that Id; a guard (`live()`) wraps every dispatch from an effect run, `onRecords`, the Crew reads and a start's dispatches
    - `switchTo(id)` as the design gives it: one handler, one render; the old pollers are stopped and their requests aborted by the effects' own cleanup; a start in flight finishes its requests with its own Id and shows nothing
    - The failed read of the list: the notice, a retry after 15 seconds with the injected timer, none while hidden, one at once when visible, and the effect of a later success on Requirement 4, criteria 2 and 5 and Requirement 5, criterion 1
    - `actions.switchProject` ignores a value that is not in the list; nothing in the file reads a project from a request or calls a path with `approve`, `question` or `approvals`
    - _Requirements: 4.1, 4.5, 4.6, 4.8, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.4, 7.5_
  - [ ] 4.3 Check the markup in `tests/ui/render.test.mjs`
    - The dropdown's props (exactly the five, `options` as strings, names in `optionLabels`), the native fallback with the same name, options and choice, no dropdown with one or no Project, the dropdown in the error branch and not on the empty board with no plan to show, the order (project, then epic), the notice and its role, literal text for a name with markup, no heading added and the same heading levels, and the `STYLE` scans for colour and outline
    - Update the interactive-element check to allow the project dropdown
    - _Requirements: 4.2, 4.3, 4.4, 7.2, 7.3, 7.4, 7.6_
  - [ ] 4.4 Check the wiring in `tests/ui/board.test.mjs` and `tests/ui/support.mjs`
    - Give the fake `fetch` a `GET /projects` and make every path carry the query; with two Projects: the list is read first and no plan before it; every plan and chats path has `project=`; a switch resets the plan, chats, `ui`, the panel and the filter, saves the choice and the filter, and restarts both pollers (the old timers cleared, the old request aborted); an answer of the old Project that arrives late changes nothing, from the plan poller, the chat poller, a Crew read and a start; a start in flight finishes its calls with the old `project=` and shows nothing; a switch to the current Project changes nothing; a saved Id that is not in the list falls back to the first and saves it; with no storage the choice is held in memory
    - With one Project the requests are the same as before but for the query, and no dropdown shows; a failed list read shows the notice, the board works with no `project` value, the retry runs and a later success removes the notice and shows the dropdown; unmounting leaves no listener or timer
    - Update the tests that start the pollers once with `[]`, and those that read a path without a query
    - _Requirements: 4.1, 4.5, 4.6, 4.7, 4.8, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.4, 7.5_
  - [ ] 4.5 Write property test for the stale answers in `tests/ui/projects.test.mjs`
    - **Property 5: The page never shows another project's answer**
    - Seeded sequences of switches and answers tagged by Project, delivered late and out of order, against the real `createBoard` with fake pollers; at least 100 iterations, with the seed printed on failure
    - **Validates: Requirements 5.2, 5.4, 5.5, 5.6, 6.1, 6.3**
  - [ ] 4.6 Check the permissions and the scan
    - `tests/test_ui.py`: `permissions.api` is exactly `/api/chat` and `/api/chat/slots` and `app.json` declares none of `sessionApproval`, `chatSlots`, `spawn`, `agentTurns`, `network` or `storage`; add the number of this story to the assertion's comment
    - The source scan of `ui/index.mjs` still finds no `approve`, `question` or `approvals` path, no `innerHTML` and no `dangerouslySetInnerHTML`; `app.json` and the backend's imports show no new dependency
    - _Requirements: 7.1_
  - [ ] 4.7 Update the earlier specs for the page
    - Edit in place: the start spec's Requirement 6, criterion 7 (the chat poller belongs to a project and a switch restarts it) and the filter spec's Requirement 3 (a switch of project sets the filter to `all`), each as a short pointer to this story's requirement. Do not edit "Work in the chat" or the chat state spec; if the landed code makes a sentence there false, say so in the pull request
    - _Requirements: 5.1, 5.3_
  - [ ] 4.8 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 4.1, 4.2, 4.3, 4.4, 4.5, 4.6, 4.7, 4.8, 5.1, 5.2, 5.3, 5.4, 5.5, 5.6, 5.7, 5.8, 6.1, 6.2, 6.3, 6.4, 6.5, 6.6, 7.1, 7.2, 7.3, 7.4, 7.5, 7.6_

- [ ] 5. Check it on a Crew host
  - [ ] 5.1 Install the app in Kiro Crew with two projects and check it (done by you in the app)
    - Use Crew 0.12.2 or later and the app's `app.json` as it is. Put two projects in `config.json`, one of them the repository the board uses today, with its `chats.json` in place
    - **Check the signature with a query.** Start a story in the second project. Confirm the `chats` calls with `?project=` are accepted (no 401 `unauthorized`), and that the record lands in `chats-<id>.json` and not in `chats.json`. If the gateway drops or changes the query, stop and report it: the design's fallback is a path segment for the project (Open Questions 4)
    - Check the legacy file: the project whose repository is the old one still shows the chats it showed before, with their links and states, and nothing of them shows on the other project
    - Check the Select: the project dropdown is Crew's own, sits beside the epic filter, shows the names, does not show with one project (a config of today's form), and keyboard and screen reader names are "Project" and "Epic"
    - Check switching: the board shows the loading state and then the other project's plan; the epic filter is "All epics"; an open chat panel closes; the cards' chat states are the other project's; switch quickly three times and confirm the board ends on the last project and shows nothing of the others; reload and confirm the last project is kept, and that a project removed from the config falls back to the first
    - Check Start in each project: the conductor opens in that project's Crew folder and works in that project's repository
    - Check the failures: a project whose repository is not a checkout shows its own error, the dropdown stays, and the other project works; stop the backend's answer of `/projects` (for example by a wrong path) and confirm the notice and the retry
    - Check a start while switching, and what the person sees when coming back (Open Questions 5)
    - Check the order with the chat state change and "Work in the chat": the panel, the card's chat state and the Start button work in each project
    - Check light and dark themes and the focus ring on the dropdown
    - _Requirements: 3.2, 3.6, 4.2, 4.4, 5.1, 5.3, 5.4, 6.1, 6.2, 7.2, 7.4_

## Notes

- Each group is one pull request and is merged by the owner; start the next group from the updated main
- Starting this story waits for "Work in the chat" (pull request 29) and the chat state change (`story/chat-state`), as the overview says
- This story edits requirements that other specs own, in place, as "Edits to earlier specs and checks" in the design lists (tasks 2.5 and 4.7). Their ticked tasks are not reopened. It does not edit the specs of "Work in the chat" or the chat state change
- No task is optional: every task checks a requirement of this spec
- The open questions in the design are for the owner; the host-dependent ones are checked in 5.1

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1", "1.2"] },
    { "id": 1, "tasks": ["1.3", "1.4"] },
    { "id": 2, "tasks": ["1.5"] },
    { "id": 3, "tasks": ["2.1"] },
    { "id": 4, "tasks": ["2.2", "2.3"] },
    { "id": 5, "tasks": ["2.4", "2.5"] },
    { "id": 6, "tasks": ["3.1"] },
    { "id": 7, "tasks": ["3.2", "3.3"] },
    { "id": 8, "tasks": ["3.4"] },
    { "id": 9, "tasks": ["4.1"] },
    { "id": 10, "tasks": ["4.2"] },
    { "id": 11, "tasks": ["4.3", "4.4", "4.5", "4.6", "4.7"] },
    { "id": 12, "tasks": ["4.8"] },
    { "id": 13, "tasks": ["5.1"] }
  ]
}
```
