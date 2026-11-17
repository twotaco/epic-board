# Requirements Document

## Introduction

This story is the eighth of the Epic Board epic (`docs/epics/epic-board.md`). It builds on "Read the plan from main" (`.kiro/specs/read-the-plan-from-main/`), "Show the board" (`.kiro/specs/show-the-board/`), "Start a story" (`.kiro/specs/start-a-story/`, "the start spec"), "Switch projects" (`.kiro/specs/switch-projects/`, "the switch spec") and does not restate them.

Today, setting up the board means writing `config.json` by hand with repository paths and Crew folder IDs that Crew's interface never shows, then running `kirocrew app update`. Nobody but the author can do that. This story removes that barrier.

Every Crew folder already has a `project_dir` field (`GET /api/chat/folders`, Crew 0.12.2). Setting up a project means picking a folder. A new Projects view on the board lists the person's Crew folders that have a project directory. The person ticks the ones the board should show, names each project (defaulting to the folder name), and saves. The repository comes from the folder's directory, and the folder is used for Start. This saves to the app's data folder and takes effect without a restart or `kirocrew app update`.

`config.json` keeps working. The Projects view is always shown. When a saved setup exists it wins; `config.json` is the fallback when no saved setup exists yet. This keeps every current installation working without change. When neither a saved setup nor `config.json` has a `projects` key, the legacy single-project form applies; otherwise, the board is Unconfigured and shows "Choose your projects" in place of the `repository_not_configured` error.

**Build order.** This story is built after "Switch projects" (`.kiro/specs/switch-projects/`, pull request 33, merged). It does not wait for "Start a story".

## Glossary

- **Selectable_Folder**: a folder from `GET /api/chat/folders` shown in the Projects view. Three rules determine eligibility: (1) **nearest-wins directory** — a folder's directory is its own `project_dir` when non-empty, or the nearest ancestor's `project_dir` following `parent_id` through the same list; a hidden, `owner_app` or `mate_home` folder is never an ancestor source; (2) **system folders excluded** — folders with `hidden: true`, a non-empty `owner_app`, or `mate_home: true` are excluded; (3) **no directory excluded** — folders whose directory is still empty after rule 1 are excluded. A Selectable_Folder is `{id, name, project_dir}` where `project_dir` is the resolved non-empty directory.
- **Saved_Config**: the file `setup.json` in the Data_Folder that holds the project entries the person saved from the Projects view. Its form is described in Requirement 6.
- **Unconfigured**: the board has no valid Project_List from any source (no `config.json` `projects` key, no valid Saved_Config, no legacy single-project repository).
- **Project_List**, **Data_Folder**, **Chat_Record**, **Started_Chat**, **Crew_Folder**, **Legacy_Repository**, **Project_Id**, **Records_File**, **Default_Project**: as the switch spec defines them.

## Requirements

### Requirement 1: Permissions

**User Story:** As the person who installs the board, I want adding the Projects view to need the smallest change to the app's permissions, so that I know what I am allowing.

#### Acceptance Criteria

1. THE `permissions.api` of `app.json` SHALL list exactly `/api/chat`, `/api/chat/slots` and `/api/chat/folders`. THIS criterion replaces the start spec's Requirement 1, criterion 3 in full; that criterion is edited in place in its file. `app.json` SHALL declare no other permission, in particular none of `sessionApproval`, `chatSlots`, `spawn`, `agentTurns`, `network` or `storage`. `app.json` SHALL keep its name, route, backend and platform declarations.
2. THE page SHALL read Crew's folder list with `GET /api/chat/folders` through `useAppApi` only inside the Projects view, and only when the view is opening. No other part of the page SHALL call that route.
3. THE backend SHALL never call Crew, as the start spec's Requirement 5, criterion 9 says.

### Requirement 2: Which source wins

**User Story:** As a person with a hand-written `config.json`, I want my setup to keep working unchanged until I choose to save a new one, so that nothing breaks.

#### Acceptance Criteria

1. WHEN a valid Saved_Config exists THEN the backend SHALL build the Project_List from it as Requirement 6 describes. The `config.json` `projects` key and the legacy single-project form SHALL be ignored for the Project_List.
2. WHEN no valid Saved_Config exists AND `config.json` has a valid `projects` key THEN the backend SHALL use it. The board behaves exactly as the switch spec describes.
3. WHEN neither criterion 1 nor criterion 2 gives a project list AND the legacy single-project form (`EPIC_BOARD_REPOSITORY` or the top-level `repository` in `config.json`) gives a repository THEN the backend builds one Project from that, as the switch spec's Requirement 1, criterion 5 describes.
4. WHEN none of the above gives a project THEN the board is Unconfigured, and the page SHALL show the first-run notice of Requirement 5 instead of the plan columns.
5. THE precedence, in order, is: Saved_Config, then `config.json` projects, then legacy single-project, then Unconfigured.
6. THE Projects view control SHALL be shown on the page in all states, including when `config.json` has projects, when the legacy single-project form is in use, and when Unconfigured. WHEN the person saves for the first time, the Saved_Config is created and takes effect at once; subsequent saves replace it.

### Requirement 3: Reading Crew folders

**User Story:** As a person opening the Projects view, I want to see my Crew folders that have a project directory, so that I can pick which ones to show on the board.

#### Acceptance Criteria

1. WHEN the Projects view opens THEN the page SHALL call `GET /api/chat/folders` through `useAppApi` and SHALL show a loading state inside the view until the call ends.
2. THE page SHALL apply the three rules in the glossary's Selectable_Folder definition to build the list from the response: resolve each folder's directory by nearest-wins through `parent_id`; exclude hidden, `owner_app` and `mate_home` folders (and never use them as ancestor sources); exclude folders with no resolved directory. Each row SHALL show the folder's name and its resolved directory as literal text. Rows SHALL be in the order the response gives them.
3. IF the call fails, times out (more than 10 seconds) or the response is not a list THEN the view SHALL show the message "Could not read Crew folders." and a "Try again" button, SHALL NOT show the Save button, and SHALL NOT pre-tick any folder.
4. FOLDERS with `hidden: true`, a non-empty `owner_app`, or `mate_home: true` SHALL be excluded. Folders whose directory is still empty after nearest-wins resolution SHALL also be excluded. Folders whose `id` is in the `worktree_folder_ids` that `GET .../setup` returns (the folders the board made for worktrees) SHALL also be excluded. All are omitted with no notice to the person.
5. IF no Selectable_Folder exists THEN the view SHALL show "No Crew folders have a project directory. Set a project directory in Crew first." and no other content besides a close control.
6. THE page SHALL treat the folder list as fresh for each opening of the Projects view and SHALL NOT cache it between openings.

### Requirement 4: The Projects view

**User Story:** As a person setting up the board, I want to tick folders, name each project and save, so that the board shows exactly the projects I chose.

#### Acceptance Criteria

1. THE Projects view SHALL be opened from a button (or icon button) in the board's header row at all times, regardless of the source of the current Project_List. WHEN the board is Unconfigured, the view SHALL also be reachable from the button of Requirement 5, criterion 2.
2. THE view SHALL show a checkbox for each Selectable_Folder. A folder is ticked by default when its `id` matches the `folder_id` of a project already in the current Project_List (from whichever source is active); the name field for that folder SHALL default to that project's name. All other folders are unticked by default.
3. WHEN the view is open AND the Saved_Config is the active source (Requirement 2, criterion 1) AND `config.json` also has a valid `projects` key THEN the view SHALL show one line of text: "config.json also has a projects list; this saved setup takes priority." This text SHALL have the role `status`.
4. FOR each ticked folder, the view SHALL show a text field for the project name, defaulting to the folder's name when no match exists (criterion 2). The page fills the name with the folder's name when the folder is ticked and the name is empty. WHEN the person unticks a folder, the name field SHALL be hidden. WHEN they tick it again, the field SHALL restore the last value they typed, or the default if they had not typed one.
5. THE Save button SHALL be active only when at least one folder is ticked and every ticked folder's name field is non-empty.
6. WHEN the person activates Save THEN the view SHALL show a saving state (Save button disabled, indication that saving is in progress) and SHALL send the validated list to the backend's save route (Requirement 6, criterion 2). ON success, the view SHALL close and the board SHALL update as Requirement 8, criterion 2 says. ON failure, the view SHALL show the backend's error message, with the Save button re-enabled.
7. THE view SHALL have a "Cancel" or close (×) control that closes it without saving. WHEN the view closes by any means, any unsaved changes are discarded.
8. THE view SHALL be a panel or modal on the same page and SHALL not navigate away. The Save and Cancel controls SHALL be clearly labelled.
9. WHILE the view is open, the board behind it SHALL remain visible.

### Requirement 5: First run

**User Story:** As a person who installs the board for the first time, I want a clear prompt instead of an error, so that I know what to do.

#### Acceptance Criteria

1. WHEN the board is Unconfigured THEN it SHALL show a notice reading "Choose your projects" and a "Set up projects" button in place of the plan columns. It SHALL NOT show the `repository_not_configured` error text of earlier specs in this state.
2. WHEN the person activates "Set up projects" THEN the Projects view SHALL open.
3. THE notice SHALL have the role `status`. It SHALL add no `alert` role.
4. WHEN a save succeeds and gives at least one project THEN the board SHALL remove the notice and show the plan at once (Requirement 8, criterion 2), without a full page reload.

### Requirement 6: Saving and loading the Saved_Config

**User Story:** As a person who saved their project choices, I want the board to remember them after a restart and to show them at once after I save without restarting.

#### Acceptance Criteria

1. THE backend SHALL save the Saved_Config as `setup.json` in the Data_Folder. The file's form SHALL be `{"projects": [{"folder_id": "<text>", "name": "<text>", "repository": "<text>"}]}`, one entry per saved project, in the order the page sends them.
2. THE backend SHALL offer `POST .../setup` with a JSON body matching criterion 1: `projects` is a list of 1 to 20 entries, each an object with `folder_id`, `name` and `repository`. The route SHALL require a valid gateway signature (the start spec's Requirement 5, criterion 7). The route SHALL be matched on the end of the path as the other routes are. A path ending in `/setup` with a method other than POST SHALL answer 404 `not_found`.
3. ON receiving `POST .../setup`, the backend SHALL validate each entry as Requirement 7 says. IF any entry is invalid THEN it SHALL answer 400 `invalid_request` with a message naming the entry number and the reason, and SHALL save nothing. IF all entries are valid THEN it SHALL: write the Saved_Config atomically (write to a temp file, rename), rebuild the Project_List in memory from the new file, start holders for projects not in the old list, stop holders for projects no longer in the new list, and answer 200 `{"projects": [{"id": "<id>", "name": "<name>"}]}`, one entry per new project in list order. The rebuild is as Requirement 8, criterion 1 describes.
4. WHEN the backend starts and no Saved_Config exists THEN `load_projects` behaves as the switch spec describes.
5. WHEN the backend starts and a Saved_Config exists THEN `load_projects` reads `setup.json` and builds the Project_List from it, applying Requirement 7's validity check, regardless of whether `config.json` has a `projects` key. An invalid entry in the file SHALL be skipped with a logged message rather than causing a startup failure.
6. THE write of `setup.json` SHALL be atomic, as the switch spec's chat records describe.
7. EXISTING chat records keep their links as the switch spec's Requirement 3 describes. WHEN rebuilding the Project_List from the Saved_Config, the Records_File assignment rule of that Requirement SHALL apply: the project whose repository is the Legacy_Repository (if any) keeps `chats.json`; all others use `chats-<id>.json`.
8. THE backend SHALL NOT call Crew from the `POST .../setup` route. The backend SHALL use only the Python standard library.

### Requirement 7: Security

**User Story:** As the person who installs the board, I want the backend to validate the saved project paths and folder IDs, so that only an existing repository can be added.

#### Acceptance Criteria

1. EVERY request to `POST .../setup` SHALL carry a valid gateway signature (the start spec's Requirement 5, criterion 7). An unsigned request SHALL answer 401 `unauthorized` and change nothing.
2. FOR each entry in the list, the backend SHALL check: `folder_id` is a non-empty string of at most 200 characters; `name` is a non-empty string of at most 100 characters and not only whitespace; `repository` is a string that, when expanded as `load_projects` expands a repository path (home directory and relative path expansion to one absolute path), is an existing directory that is a git checkout (has a `.git` entry or is inside a git worktree). An entry that fails any check SHALL cause a 400 `invalid_request` answer (Requirement 6, criterion 3).
3. THE request body SHALL be at most 4,096 bytes and a JSON object. Any body that is not a JSON object, is too large, or holds a `projects` field that is not a list of 1 to 20 objects SHALL answer 400 `invalid_request` and change nothing.
4. THE backend SHALL NOT validate `folder_id` against Crew's real folder list, because the backend never calls Crew. It checks only that the value is well-formed text.
5. THE backend SHALL NOT restrict `repository` to any subtree of the filesystem beyond the existing git checkout check. The owner can already open any directory in Crew, so a path restriction protects nothing; the signed check prevents a cross-site or replayed request from saving a path the person did not choose. No further restriction is applied.

### Requirement 8: The updated Project_List and live update

**User Story:** As a person who just saved their choices, I want the board to show the right projects at once without a restart.

#### Acceptance Criteria

1. THE switch spec's Requirement 1, criterion 6 says "THE Project_List SHALL be built once, when the app starts". THIS story extends that: the Project_List SHALL also be rebuilt in memory when `POST .../setup` succeeds (Requirement 6, criterion 3). The rebuilding replaces the in-memory list atomically, so that requests arriving during the rebuild are answered by either the old or the new list and not a mix. The backend MUST remain thread-safe across this rebuild.
2. THE page SHALL, after a successful `POST .../setup`: call `GET .../projects` to get the new Project_List, keep the project the person was on when its id is still in the new list (as the switch spec's Requirement 4, criterion 5 does), otherwise select the first project, reset the epic filter to "all", trigger a fresh plan and chats poll, and close the Projects view. It SHALL NOT do a full page reload.
3. WHEN the Projects view closes after a successful save THEN no plan or chat state from before the save SHALL remain on the page; the state SHALL be as fresh as a page load with the new Project_List.

### Requirement 9: Theme, accessibility and failures

**User Story:** As a person using Kiro Crew in a light or dark theme, I want the new controls to be readable and usable by keyboard and screen reader.

#### Acceptance Criteria

1. THE new elements SHALL follow the board spec's Requirement 10, criterion 1: no opaque colour as a text colour or element background, borders and tints in `currentColor` or a colour with an alpha above 0 and below 1.
2. EVERY control the story adds (the Projects open button, checkboxes, name fields, Save, Cancel, "Set up projects", "Try again") SHALL be reachable by keyboard, SHALL show the browser's focus indicator, and SHALL act on Enter or Space for buttons and checkboxes.
3. WHEN the Projects open button is an icon-only button, it SHALL carry an accessible name (via `aria-label` or visually hidden text). WHEN the view is open, the button or its trigger SHALL carry `aria-expanded="true"`.
4. THE notice of Requirement 5 SHALL have the role `status`. All saving and error texts in the view SHALL have the role `status`. No new text SHALL have the role `alert`.
5. THIS story SHALL add no heading element that breaks the board spec's heading hierarchy, and the heading levels SHALL hold in every state.
6. THE page SHALL show every text it takes from Crew or the backend as literal text and not as HTML or Markdown.
7. A failure of the `POST .../setup` request SHALL NOT change the plan the page shows. A failure of the `GET .../projects` call after a save SHALL be treated as a failed save: the view SHALL show the error message and SHALL NOT close.
