# Requirements Document

## Introduction

This story is the seventh of the Epic Board epic (`docs/epics/epic-board.md`). It builds on "Read the plan from main" (`.kiro/specs/read-the-plan-from-main/`, "the first spec"), "Show the board" (`.kiro/specs/show-the-board/`, "the board spec"), "Start a story" (`.kiro/specs/start-a-story/`, "the start spec") and "Filter by epic" (`.kiro/specs/filter-by-epic/`, "the filter spec"), and does not restate them. Until now one board shows one repository, named in the app's config. A person who plans two projects with Kiro installs the app twice or edits the config and restarts.

This story lets one board hold several projects. `config.json` lists them, the backend keeps one plan and one file of chat records per project, and the page gets a project dropdown beside the epic filter. The dropdown shows only when there is more than one project. Choosing a project shows that project's plan and chats, and nothing of the other. A config that names one repository, as today's does, is one project, and nothing about it changes.

**Build order.** This story is built after "Work in the chat" (`.kiro/specs/work-in-the-chat/`, pull request 29) and after the change to the chat state of a card (branch `story/chat-state`, in progress by another worker). Both change the page's code that this story changes, the panel and the chat poller. This spec refers to them and does not edit their specs. Where it says "the panel" it means the panel of "Work in the chat". Where it says "the chat poller" it means the start spec's Requirement 6, criterion 7, as the chat state change leaves it. If either lands differently than this spec assumes, the first task of group 3 says what to check first.

The Select props below come from Crew's source at tag `v0.12.2`, in `website/src/kirocrew-ui/Select.tsx`. That is the file that defines the `Select` the host offers at `window.__kirocrew_modules['@kirocrew/ui']` (the filter spec, Requirement 1, criterion 5). `website/src/app-sdk/` holds the chat embed and the `useAppApi` client and does not define `Select`. The design names each prop.

The epic page changes with this story: "Several projects or repositories on one board" is removed from "Not in this epic", and the story is added to its list.

## Glossary

- **Project**: one repository the board can show, with a name, and optionally a Crew folder for its chats.
- **Project_List**: the Projects the app was configured with, in order.
- **Project_Id**: the text that names a Project in a request. It is made from the Project's name (Requirement 1, criterion 6).
- **Default_Project**: the first Project of the Project_List.
- **Current_Project**: the Project the page shows.
- **Legacy_Repository**: the repository today's setting names: the environment variable `EPIC_BOARD_REPOSITORY` when it is set and not empty, otherwise the top-level `repository` of `config.json`.
- **Records_File**: the file of Chat_Records of one Project in the Data_Folder (the start spec's Requirement 1, criterion 4).
- **Saved_Project**: the Project_Id kept in `localStorage` under the key `epic-board.project`, as plain text.
- **Chat_Record**, **Card_Id**, **Started_Chat**, **Crew_Folder**, **Data_Folder**: as the start spec defines them. **Filter_Key**: as the filter spec defines it.

## Requirements

### Requirement 1: Configuring projects

**User Story:** As the person who sets up the board, I want to list my projects in `config.json`, so that one board shows all of them, and I want my current setting to keep working, so that nothing breaks.

#### Acceptance Criteria

1. THE `config.json` file MAY hold a value `projects`: a list of objects of the form `{"name", "repository", "folder_id"}`. `name` and `repository` SHALL be text that is not only whitespace, and `name` SHALL be at most 100 characters. `folder_id` MAY be missing.
2. THE Project_List SHALL be the `projects` list, in its order, when `config.json` has that value. THE list SHALL hold from 1 to 20 Projects. A `repository` SHALL be handled as the first spec's Requirement 1 handles it (the home folder and relative paths expanded to one absolute path).
3. IF `projects` is not a list, is empty, holds more than 20 entries, holds an entry that is not an object, holds a `name` or `repository` that is missing, not text or only whitespace, or holds two entries whose repository is the same absolute path THEN the Project_List SHALL be empty, and the plan route SHALL answer the error `repository_not_configured` (the first spec's Requirement 1, criterion 4), with a message that names `config.json` and the entry that is wrong.
4. A `folder_id` SHALL follow the start spec's Requirement 1, criterion 1 for its own Project: a value that is not text, or only whitespace, or longer than 200 characters SHALL mean that this Project has no folder, with the reason, and SHALL NOT affect another Project or the plan. The backend SHALL NOT take a folder id from a request.
5. WHEN `config.json` has no `projects` value THEN the Project_List SHALL hold one Project made from the settings of today: the repository from `EPIC_BOARD_REPOSITORY` or `repository`, and the folder from `EPIC_BOARD_FOLDER` or `folder_id`, with the first-source-wins and bad-value rules of the first spec and the start spec. Its name SHALL be the last part of the repository path, or `Project` when that is empty. THIS Project SHALL behave exactly as the board behaved before this story: the same answers, the same Records_File and no dropdown.
6. THE Project_Id of a Project SHALL be its name written as `slugify` of `backend/chats.py` writes a spec folder name (lower-case ASCII letters and digits joined by single hyphens, at most 60 characters, `story` when nothing is left), with `-2`, `-3` and so on added in list order when an earlier Project already has that Id. A Project_Id SHALL match `^[a-z0-9-]{1,64}$`. THE Project_List SHALL be built once, when the app starts, as `config.json` is read today.
7. WHEN `projects` is present THEN `EPIC_BOARD_FOLDER` SHALL be ignored, and `EPIC_BOARD_REPOSITORY` and a top-level `repository` SHALL NOT add a Project. They keep one meaning, the Legacy_Repository (Requirement 3, criterion 2).
8. A Project whose repository is not a git checkout, or has no readable main branch, SHALL show its own error as the first spec says, and SHALL NOT stop, delay or change the plan, the chats or the errors of another Project.

### Requirement 2: The routes

**User Story:** As a person with several projects, I want every request to say which project it is about, so that I always get that project's plan and chats and no other.

#### Acceptance Criteria

1. THE backend SHALL keep one plan holder (the first spec's holder) for each Project, each with its own fetch, refresh and held plan. A request for one Project SHALL NOT start, wait for or change another Project's refresh. The holders SHALL all start when the app starts, and after that each SHALL refresh when it is asked for its plan, as today.
2. THE `plan` route and every `chats` route SHALL accept the query value `project=<Project_Id>`. WHEN it is missing THEN the request SHALL be about the Default_Project, so that a request of today's form is answered as before.
3. IF the value names no Project, or is empty THEN the backend SHALL answer 404 `project_not_found`, with a message that holds no repository path, and SHALL read and change nothing. IF the query holds `project` more than once THEN it SHALL answer 400 `invalid_request`. Any other query value SHALL be ignored.
4. THE backend SHALL answer `GET .../projects` with 200 and a JSON list `[{"id", "name"}]`, one entry per Project, in the order of the Project_List, and nothing else in the body: no repository path, no folder id and no error. WHEN the Project_List is empty (Requirement 1, criterion 3) THEN the list SHALL be `[]`. The route SHALL need no signature, like the `plan` and `health` routes, and SHALL run no git and read no file.
5. THE route SHALL be matched on the end of the path, as the first spec's routes are, so that the host's route prefix does not matter. A path that ends in `/projects` and a method other than GET SHALL answer 404 `not_found`.
6. THE body of the `plan` route SHALL stay as the first spec and the board spec define it. Its status codes and error codes SHALL stay too, with the one new code, `project_not_found`.
7. THE backend SHALL use only the Python standard library and SHALL add no dependency.

### Requirement 3: Chat records for each project

**User Story:** As a person who has started stories in a project, I want those chats to keep their links, and I want one project's chats never to appear on another project's board.

#### Acceptance Criteria

1. EACH Project SHALL have its own Records_File in the Data_Folder, and its own lock. A call for one Project SHALL read and write only that Project's file. The records of one Project SHALL never be shown, counted, changed or removed by a request about another.
2. THE Project whose repository is the Legacy_Repository (compared as absolute paths, after the expansion of Requirement 1, criterion 2) SHALL keep the file `chats.json`, as it is, so that the Chat_Records already saved keep their links. Every other Project SHALL use `chats-<Project_Id>.json`. WHEN no Project's repository is the Legacy_Repository, or there is no Legacy_Repository THEN `chats.json` SHALL stay unread and unchanged, and every Project SHALL use its own `chats-<Project_Id>.json`.
3. THE single Project of Requirement 1, criterion 5 SHALL use `chats.json`.
4. THE backend SHALL NOT move, copy, rename or delete a Records_File, and SHALL NOT create one for a Project until that Project's first write. It SHALL NOT change the form of a Chat_Record (the start spec's Requirement 5, criterion 1).
5. EVERY other rule of the start spec's Requirement 5 SHALL hold for each Project and its file: the atomic write, the serialized changes, the single record for a Card_Id, the limits on a request, `chats_unreadable` for a file that cannot be read, and the routes. An unreadable file of one Project SHALL NOT make another Project's `chats` routes fail.
6. A request to a `chats` route SHALL carry a valid gateway signature, as the start spec's Requirement 5, criterion 7 says, over the request target exactly as the backend receives it, with its query. A signed request for one Project SHALL NOT be accepted for another: changing, adding or removing `project=` in a signed target SHALL answer 401 `unauthorized`. THE backend SHALL check the signature before it looks at the Project, so that an unsigned request learns nothing about which Project_Ids exist.
7. THE answer of `GET .../chats` SHALL hold the `folder_id` and `folder_reason` of the Project named by the request, and a reservation SHALL read the plan the holder of that Project holds, and SHALL use that Project's folder, and no other (the start spec's Requirement 4, criterion 2).

### Requirement 4: The project dropdown

**User Story:** As a person with several projects, I want a dropdown beside the epic filter, so that I can choose which project the board shows.

#### Acceptance Criteria

1. WHEN the page loads THEN it SHALL read the Project_List from `GET .../projects` before it reads any plan or any chats, and SHALL show the page's loading state, as the board spec shows it before the first plan, until that read ends.
2. WHILE the Project_List has more than one Project, and the board shows a plan, THEN the page SHALL show one dropdown with the accessible name "Project" (`aria-label`), to the left of the epic dropdown and in the same row, with one option for each Project, in the list's order, labelled with its name. WHILE the Project_List has one Project or none THEN the page SHALL show no project dropdown and no space for one, and the epic dropdown SHALL be placed as the filter spec places it.
3. WHEN the page shows an error in place of a plan (the board spec) THEN it SHALL still show the project dropdown when the Project_List has more than one Project, so that the person can leave a Project whose repository is wrong. WHEN the Project_List read failed THEN there SHALL be no project dropdown (Requirement 7, criterion 4).
4. THE dropdown SHALL be Crew's `Select` from the host's `@kirocrew/ui` module when the module and its `Select` are there, found as the filter spec's Requirement 1, criterion 5 says. THE page SHALL pass it `aria-label="Project"`, `value` the Current_Project's Project_Id, `options` the Project_Ids as strings, `optionLabels` the names in the same order, and `onChange`, which receives the chosen Project_Id as a string. THE page SHALL pass no other prop. WHEN the module is missing, or has no `Select`, or the lookup throws THEN the dropdown SHALL be a native `select` with the same accessible name, options, order and choice.
5. THE Current_Project SHALL be the Saved_Project when it is in the Project_List, and the Default_Project otherwise. WHEN the Saved_Project is not in the Project_List THEN the Saved_Project SHALL be set to the Default_Project's Id. WHEN the list holds one Project or none THEN nothing SHALL be saved or changed.
6. WHEN the person chooses a Project THEN the page SHALL save its Project_Id as the Saved_Project, at once, and the page SHALL behave as Requirement 5 says.
7. WHEN `localStorage` is not there, throws on a read or a write, or holds a value that is not text THEN the page SHALL work as if nothing were saved: it SHALL start on the Default_Project, keep the choice in memory for that visit, and show no error. This is the filter spec's Requirement 3, criterion 8, for this key.
8. THE page SHALL read the Project_List once for each load of the page, and SHALL NOT read it again while it works, except as Requirement 7, criterion 4 says. A Project added to `config.json` shows after the app restarts and the page loads again.

### Requirement 5: Switching projects

**User Story:** As a person who switches projects, I want the board to be the other project's board at once, with nothing of the first left on it.

#### Acceptance Criteria

1. WHEN the person chooses a Project other than the Current_Project THEN the page SHALL, in one update: show the loading state of the board spec in place of the old plan; remove the old plan, the old chats, their notices and the old flows of the cards (the question, a start's progress and failure, the resume and the brief notes); set the Filter_Key to `all` and save `all` as the filter spec's Requirement 3, criterion 5 saves it; and close the panel of "Work in the chat", with no card marked and focus moved nowhere.
2. WHEN the person chooses the Current_Project again THEN nothing SHALL change.
3. WHEN the page has switched THEN it SHALL stop the plan poller and the chat poller of the old Project, cancel the requests in flight, clear their timers, and start both again for the new Project, so that the first plan and the first read of the chats are asked for at once. THE pollers SHALL otherwise work as the board spec and the start spec say, including the pause while the page is hidden.
4. THE page SHALL NOT show any answer to a request made for another Project than the Current_Project. An answer that arrives after the switch, from the plan poller, the chat poller, a read of Crew for a chat of the old Project, or a start, SHALL change nothing on the page.
5. THE page SHALL NOT carry a state from one Project to the other: the chat states, the missing marks and the last-row caches of the old Project's chats SHALL NOT be reused for the new one, even for a Card_Id or a chat key that is the same.
6. A start that is running when the person switches SHALL finish its requests for the Project it was started in, so that a reservation is not left half made, and its result SHALL NOT be shown (criterion 4). The chat it saved shows on the card when the person comes back.
7. THE switch SHALL NOT change the Saved_Choice of the filter, other than setting it to `all`, and SHALL NOT change the Saved_Project other than as Requirement 4, criterion 6 says.
8. WHEN the Current_Project's plan is an error (for example the repository is not a checkout) THEN choosing another Project SHALL work as in criteria 1 to 4, and the error SHALL NOT follow the person to the other Project.

### Requirement 6: Cards, chats and Start in a project

**User Story:** As a person with several projects, I want every card's chat state and Start button to act on its own project, so that a conductor works in the right repository.

#### Acceptance Criteria

1. EVERY request the page makes to the backend for the plan or the chats SHALL carry `project=<Current_Project's Project_Id>` as a query value, once the Project_List holds that Project. The `chats` requests are the reads of the records, the reservation, the `started` call and the removal (the start spec's Requirement 5, criterion 6). WHEN the Project_List is empty or its read failed THEN the page SHALL send no `project` value, and the backend answers for the Default_Project.
2. A card's Start SHALL reserve and save its chat in the Current_Project's records, and the reservation's brief and `folder_id` SHALL be that Project's (Requirement 3, criterion 7). A card's chat state, link, resume and "Start again" SHALL work on that Project's records and chats only.
3. THE page SHALL read the state of a chat in Crew only for a Started_Chat of the Current_Project's records, so that a chat key of another Project is never asked for.
4. THE card's Card_Id SHALL be unique only inside its Project. The page SHALL NOT use a Card_Id to find a card or a record of another Project.
5. THE panel SHALL show a chat of the Current_Project only. WHEN the Current_Project changes THEN the panel SHALL close (Requirement 5, criterion 1), and no chat of the old Project SHALL stay mounted in it.
6. THE page SHALL add no field to the plan, to a Chat_Record or to a request body, and the Start flow SHALL send the same bodies as before.

### Requirement 7: Reach, theme, accessibility and failures

**User Story:** As the person who installs the board, I want this story to add no permission and no dependency, and to work for a person who uses a keyboard or a dark theme.

#### Acceptance Criteria

1. THE `permissions.api` of `app.json` SHALL stay exactly as the start spec's Requirement 1, criterion 3 says, and this story SHALL add no entry and no other permission. THE page SHALL add no dependency and no build step, and the backend SHALL use only the standard library.
2. THE dropdown SHALL follow the board spec's Requirement 10, criterion 1: no opaque colour as a text colour or an element background, borders and tints in `currentColor` or a colour with an alpha above 0 and below 1. THE dropdown SHALL be reachable and usable by keyboard, SHALL keep the browser's focus indicator, and SHALL add no heading element. THE heading levels of the board spec's Requirement 10, criterion 2 SHALL stay as they are in every state.
3. THE page SHALL show every Project name as literal text and not as HTML or Markdown, in the option labels and wherever else it shows one.
4. IF the read of the Project_List fails (the connection fails, the answer is not a list of `{id, name}`, or it takes more than 10 seconds) THEN the page SHALL show the notice "Could not read the list of projects." with the role `status`, SHALL continue as if the list were empty (Requirement 6, criterion 1) so that the board still works for the Default_Project, and SHALL try the read again 15 seconds after it ended, none while the page is hidden and one at once when it becomes visible. WHEN a later read succeeds THEN the page SHALL remove the notice and apply Requirement 4, criteria 2 and 5, and, if the Current_Project changes as a result, Requirement 5, criterion 1.
5. A failure of one request SHALL NOT change what the page shows for another. In particular a failed read of the Project_List SHALL NOT remove a plan or chats already shown.
6. THE new text SHALL have no `alert` role, and the new elements SHALL be reachable by keyboard.
