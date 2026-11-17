# Requirements Document

## Introduction

This story is the tenth of the Epic Board epic (`docs/epics/epic-board.md`). It builds on "Read the plan from main" (`.kiro/specs/read-the-plan-from-main/`), "Show the board" (`.kiro/specs/show-the-board/`), "Start a story" (`.kiro/specs/start-a-story/`, "the start spec"), "Set up projects" (`.kiro/specs/set-up-projects/`) and "Briefs that hold up on any agent" (`.kiro/specs/briefs-that-hold-up-on-any-agent/`), and does not restate them.

Today every conductor runs in the project's one checkout. When two stories are in progress at once, their conductors share the same files: one switching branches affects what the other sees, and the chat footer of every chat in the project shows the same branch. The brief never fetches and re-reads the epic page before it branches, so a conductor can work from a stale main.

This story changes the board so that each started story works in its own git worktree, made fresh from the latest origin/main. Several conductors can run on the same project without touching each other's files. The person chooses, per project, whether this applies. The brief gains a step that runs the project's setup inside the worktree and a step that merges the latest main before opening the pull request.

## Glossary

- **Worktree_Path**: the absolute path of a story's git worktree, computed from the repository path and the Chat_Record's name. The worktree is a sibling of the checkout: `<parent-of-checkout>/<checkout-basename>--<record-name>` (e.g. `my-project--epic-board-a3f2b1c4`).
- **Worktree_Setting**: the per-project "Start each story in its own worktree" flag, stored in `setup.json` as `"worktree": true|false`. Default is `true` when absent.
- **Worktree_Folder**: the Crew subfolder created for a worktree card, with `project_dir` set to the Worktree_Path. Its `id` is stored in the Chat_Record so the board can remove it when the worktree is cleaned up.
- **Setup_Step**: the brief step that tells the conductor to run the project's setup commands inside the worktree before anything else (for example `npm ci`).
- **Catch_Up_Step**: the brief step that tells the conductor to fetch and merge origin/main into its branch, resolve any conflicts, rerun the checks and say so, before opening or updating the pull request.
- **Finished_Chat**: a Chat_Record whose `state` is `finished`. The person finished the card; the chat itself stays open in Crew.
- **Chat_Record**, **Started_Chat**, **Data_Folder**, **Crew_Folder**, **Project**, **Saved_Config**: as the start spec and set-up-projects spec define them.

## Requirements

### Requirement 1: Per-project worktree setting

**User Story:** As a person who manages several projects, I want to turn the per-worktree behaviour on or off per project, so that projects that cannot use worktrees keep working as before.

#### Acceptance Criteria

1. EACH project entry in the Projects view SHALL show a checkbox labelled "Start each story in its own worktree". The checkbox SHALL be ticked by default when the entry has no saved value and when it is saved with `true`.
2. THE `Saved_Config` (`setup.json`) SHALL store the setting per entry as `"worktree": true|false`. WHEN the field is absent (entries saved before this story) the backend SHALL treat it as `true`.
3. WHEN the person saves the Projects view, the backend SHALL accept and persist the `worktree` field alongside `folder_id`, `name` and `repository`. The route's validation SHALL accept `true` and `false` only; anything else SHALL answer 400 `invalid_request`.
4. THE `GET .../setup` response SHALL include `worktree` for each project entry so the Projects view can pre-tick the checkbox from the saved value.
5. THE `GET .../projects` response SHALL include `worktree` for each project so the page knows whether to offer a worktree start.
6. WHEN the worktree setting is `false` for a project THEN every new start for that project SHALL work exactly as it does today, with no worktree and no Worktree_Folder. The start question SHALL say "Works in the shared checkout". Finish SHALL then only mark the chat finished (Requirement 5, criterion 10).
7. WHEN the worktree setting is `true` THEN the start question SHALL say "Works in its own worktree" and the start sequence SHALL follow Requirements 2 and 3.

### Requirement 2: Worktree creation

**User Story:** As a person starting a story, I want the board to make a fresh worktree from the latest main and open the conductor's chat there, so that the conductor reads an up-to-date plan and does not share files with other conductors.

#### Acceptance Criteria

1. WHEN the person activates "Start" on a project with `worktree: true` THEN the start sequence SHALL, before creating the Crew chat:
   a. Tell the backend to fetch `origin` and create a detached git worktree at the Worktree_Path from `origin/<main-branch>`.
   b. Create a Crew subfolder (the Worktree_Folder) with `project_dir` equal to the Worktree_Path, as a child of the project's Crew_Folder.
   c. Create the Crew chat in the Worktree_Folder (not the project's Crew_Folder).
2. THE backend SHALL create the worktree by running `git fetch origin` then `git worktree add --detach <path> origin/<main-branch>`, via the same subprocess pattern as `gitsource.py`. The worktree starts with a detached HEAD at the latest origin/main commit; the conductor creates its own branch inside as the brief says. THE backend SHALL run no other git command on the shared checkout during this sequence.
3. THE Worktree_Path SHALL be `<parent-of-checkout>/<checkout-basename>--<record-name>`, where `<record-name>` is the Chat_Record's name (e.g. `epic-board-a3f2b1c4`). Example: checkout at `/home/alice/my-project`, record name `epic-board-a3f2b1c4` → path `/home/alice/my-project--epic-board-a3f2b1c4`.
4. WHEN the backend finds that a worktree already exists at the Worktree_Path (a `reserved` record from a previous attempt) THEN it SHALL reuse it, not create a second one.
5. THE Chat_Record SHALL gain two nullable fields: `worktree_path` (the absolute path as text, or `null`) and `worktree_folder_id` (the Crew subfolder id as text, or `null`). Both are `null` for non-worktree starts.
6. AFTER the chat is saved and started (the start spec's Requirement 4, criterion 4), the page SHALL save the `worktree_folder_id` alongside the chat key in the `POST .../chats/<name>/started` request.
7. THE backend SHALL validate `worktree_folder_id` with the same pattern as `key` (NAME_PATTERN: ASCII letters, digits, `.`, `_`, `-`, 1 to 193 characters); a missing or null field SHALL be accepted and treated as absent.
8. THE board SHALL create the Worktree_Folder through the page (via `useAppApi`, `POST /api/chat/folders`), not through the backend. The backend never calls Crew.

### Requirement 3: The brief in a worktree

**User Story:** As a conductor opened in a worktree, I want the brief to tell me to set up the worktree and to merge the latest main before opening a pull request, so that I start from a working state and my PR is up to date.

#### Acceptance Criteria

1. WHEN the brief is built for a worktree start (`worktree_path` is not null in the reserved record) THEN the brief SHALL include the Setup_Step as a numbered step, before the first work step (before "Read requirements.md..." or "Read the story's entry...").
2. THE Setup_Step SHALL read: "This story runs in its own worktree. Before anything else, run the project's setup (as AGENTS.md says — for example `npm ci`)."
3. WHEN the brief is built for a worktree start THEN the brief SHALL include the Catch_Up_Step as a numbered step, after the work steps and before the name-check step.
4. THE Catch_Up_Step SHALL read: "Before opening or updating the pull request, run `git fetch origin` and `git merge origin/<branch>` in the worktree. Resolve any conflicts, rerun the checks the project names and say so in this chat."
5. WHEN the brief is NOT built for a worktree start THEN neither step SHALL appear. The brief SHALL not change for non-worktree starts.
6. THE opening line SHALL remain "You are the conductor for one story of this project. Work in the checkout you were opened in." — the conductor is opened in the worktree, so "the checkout you were opened in" refers to the worktree.
7. THESE two steps SHALL appear in both brief variants (no-spec and with-spec).

### Requirement 4: Resuming a chat

**User Story:** As a person who reopens a started story, I want the board to reuse the story's existing worktree, so that the conductor picks up where it left off.

#### Acceptance Criteria

1. WHEN a card's chat is reopened (the chat already has a `started` Chat_Record with a `worktree_path`) THEN the board SHALL NOT create a new worktree. The conductor resumes in the worktree the record names.
2. WHEN a new task group is started on a card whose previous chat is finished (Requirement 5) THEN the board SHALL treat it as a new start: a new Chat_Record (with a new record name), a new worktree at the new record's Worktree_Path, a new Worktree_Folder and a new chat.

### Requirement 5: Finish

**User Story:** As a person whose story is done, I want to finish its card myself, so that the worktree folder is removed only when I say so, and never while the conductor may still be working.

The board cannot tell when a story is done. Crew gives an app no pull request state: the source links of a chat reach an app without their `state`. A story chat also opens one pull request per task group, so "a pull request is merged and none is open" is true between two groups. The board therefore removes nothing by itself. The person finishes a card.

#### Acceptance Criteria

1. EACH card with a Chat_Record whose state is `started` SHALL show a "Finish" control, whether the record has a `worktree_path` or not. It SHALL be a real button, reachable by keyboard, acting on Enter or Space. A card with no record, and a card whose record is `finished`, SHALL NOT show it.
2. ACTIVATING "Finish" SHALL open a confirm step in place of the button, with a "Finish" button and a "Cancel" button, and SHALL NOT change anything yet. Escape SHALL close it like "Cancel". The step SHALL say:
   a. WHEN the record has a `worktree_path`: the folder is removed, with the path as literal text, and files that git ignores in it (such as `.env` and `node_modules`) are deleted with it.
   b. WHEN the record has no `worktree_path`: only that the story is marked finished; no folder is touched.
   c. WHEN the card's tasks were read and not all are ticked on main: that not all tasks are ticked. The board SHALL say nothing about pull requests, because it cannot read their state.
3. BEFORE the backend removes a worktree it SHALL refuse, with plain git and no `gh`:
   a. WHEN the worktree has uncommitted or untracked changes: code `worktree_has_changes`.
   b. WHEN the worktree's branch has commits that are not on its upstream, or has no upstream and has commits that are not on `origin/<main-branch>` (a detached HEAD counts as having no upstream): code `worktree_has_unpushed`.
   Both are 409. The card SHALL show "Worktree kept: " and the reason, with a "Remove anyway" button that removes with `--force` and skips both checks.
4. WHEN the worktree is removed, or the record has none, the page SHALL send `PATCH /api/chat/folders/<worktree_folder_id>` with `{"project_dir": ""}` when the record has a folder id (a failure is ignored), and then ask the backend to mark the record `finished`. The record SHALL NOT be deleted.
5. A Chat_Record whose `worktree_path` is still set SHALL NOT become `finished`: the backend refuses with 409 `worktree_not_removed`.
6. THE chat SHALL NOT be closed or deleted. After the record is marked `finished`, the page SHALL post one note into the chat, once, with `POST /api/chat/slots/<key>/note`, which starts no agent turn. The note SHALL read: "This story is finished and its working folder was removed. For more work on this story, use Start again on its card in Epic Board to open a new chat." The note is information for the person reading the chat; the agent is not asked to do anything. The board cannot see what a person types in a chat, so it posts nothing at any other time. A failure to post SHALL be ignored.
7. A card whose record is `finished` SHALL show the badge "Finished" in place of the state words, and a link to the chat. The board SHALL NOT read the chat's state for a finished record.
8. A finished card SHALL show a "Start again" button in every column, Done included. It opens the start question. Starting SHALL create a new Chat_Record with a new name, and a new worktree from `origin/<main-branch>` when the setting is on, a new Worktree_Folder and a new chat. The card SHALL read its tasks from main as always, so work that was not merged shows as unticked tasks. WHEN the new chat is started, the backend SHALL delete the finished records of that card.
9. THE backend SHALL accept a start for a card that is Done on main when the card has a finished record. A Done card with no record keeps its refusal `card_done`.
10. WHEN the worktree setting is off for the project (Requirement 1, criterion 6) THEN Finish SHALL only mark the record finished.
11. THE board SHALL NOT remove a worktree or change a Chat_Record on its own, and SHALL NOT edit any epic page or story file.
12. THE backend routes SHALL require a valid gateway signature (the start spec's Requirement 5, criterion 7): `DELETE /chats/<name>/worktree` (with the checks of criterion 3; `?force=true` skips them) and `POST /chats/<name>/finished`. WHEN `worktree_path` is `null`, `DELETE /chats/<name>/worktree` SHALL answer 200 and do nothing. WHEN the folder is already gone from disk, it SHALL clear `worktree_path` and answer 200.
13. `GET /chats` SHALL return, for each record, `card_id`, `name`, `key`, `created`, `state`, `worktree_path` and `worktree_folder_id`.

### Requirement 6: Failure is visible

**User Story:** As a person starting a story, I want to see why a worktree could not be made, so that I can fix the problem without guessing.

#### Acceptance Criteria

1. IF the fetch fails during worktree creation THEN the backend SHALL return a failure with the reason. The card SHALL show "Could not create worktree: fetch failed — `<reason>`." and the question SHALL be offered again.
2. IF `git worktree add` fails THEN the backend SHALL return a failure with the reason. The card SHALL show "Could not create worktree: `<reason>`." and the question SHALL be offered again.
3. IF the Worktree_Folder creation fails (Crew rejects the POST) THEN the page SHALL remove the worktree (via `DELETE /chats/<name>/worktree`) and show "Could not create worktree folder: `<reason>`." and the question again.
4. THE board SHALL NEVER fall back to the shared checkout when a worktree fails. The start SHALL be fully retried, or not started at all.
5. WHEN a worktree failure leaves a partially created worktree at the path THEN the backend SHALL clean it up with `git worktree remove --force <path>` on the next reserve call for the same card.

### Requirement 7: Theme, accessibility and failures

**User Story:** As a person using Kiro Crew in a light or dark theme, I want the new controls to be readable and usable by keyboard and screen reader.

#### Acceptance Criteria

1. THE new controls (the worktree checkbox in the Projects view, the "Finish" and "Remove anyway" buttons and the confirm step) SHALL follow the board spec's Requirement 10, criterion 1: no opaque colour as a text colour or element background, borders and tints in `currentColor` or a colour with an alpha above 0 and below 1.
2. THE "Worktree kept" text SHALL have the role `status`. The confirm step SHALL be a `group` named "Finish this story". The "Finish", "Cancel" and "Remove anyway" buttons SHALL be reachable by keyboard and SHALL act on Enter or Space.
3. THE board SHALL show every path as literal text, not as an HTML or Markdown link.
4. THE worktree checkbox in the Projects view SHALL be reachable by keyboard, SHALL show the browser's focus indicator, and SHALL act on Enter or Space.
