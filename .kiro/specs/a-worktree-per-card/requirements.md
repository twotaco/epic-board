# Requirements Document

## Introduction

This story is the tenth of the Epic Board epic (`docs/epics/epic-board.md`). It builds on "Read the plan from main" (`.kiro/specs/read-the-plan-from-main/`), "Show the board" (`.kiro/specs/show-the-board/`), "Start a story" (`.kiro/specs/start-a-story/`, "the start spec"), "Set up projects" (`.kiro/specs/set-up-projects/`) and "Briefs that hold up on any agent" (`.kiro/specs/briefs-that-hold-up-on-any-agent/`), and does not restate them.

Today every conductor runs in the project's one checkout. When two stories are in progress at once, their conductors share the same files: one switching branches affects what the other sees, and the chat footer of every chat in the project shows the same branch. The brief never fetches and re-reads the epic page before it branches, so a conductor can work from a stale main.

This story changes the board so that each started story works in its own git worktree, made fresh from the latest origin/main. Several conductors can run on the same project without touching each other's files. The person chooses, per project, whether this applies. The brief gains a step that runs the project's setup inside the worktree and a step that merges the latest main before opening the pull request.

## Glossary

- **Worktree_Path**: the absolute path of a story's git worktree, computed from the repository path and the branch name. The worktree is a sibling of the checkout: `<parent-of-checkout>/<checkout-basename>--<branch-name>`, where `<branch-name>` is `story/<spec-folder>` with `/` replaced by `--` (e.g. `story--filter-by-epic`).
- **Worktree_Branch**: the git branch the worktree is checked out on: `story/<spec-folder>` for a spec or `story/<spec-folder>-g<N>` for a task group, freshly cut from `origin/<main-branch>`.
- **Worktree_Setting**: the per-project "Start each story in its own worktree" flag, stored in `setup.json` as `"worktree": true|false`. Default is `true` when absent.
- **Worktree_Folder**: the Crew subfolder created for a worktree card, with `project_dir` set to the Worktree_Path. Its `id` is stored in the Chat_Record so the board can remove it when the worktree is cleaned up.
- **Setup_Step**: the brief step that tells the conductor to run the project's setup commands inside the worktree before anything else (for example `npm ci`).
- **Catch_Up_Step**: the brief step that tells the conductor to fetch and merge origin/main into its branch, resolve any conflicts, rerun the checks and say so, before opening or updating the pull request.
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
6. WHEN the worktree setting is `false` for a project THEN every new start for that project SHALL work exactly as it does today, with no worktree and no Worktree_Folder. The start question SHALL say "Works in the shared checkout".
7. WHEN the worktree setting is `true` THEN the start question SHALL say "Works in its own worktree" and the start sequence SHALL follow Requirements 2 and 3.

### Requirement 2: Worktree creation

**User Story:** As a person starting a story, I want the board to make a fresh worktree from the latest main and open the conductor's chat there, so that the conductor reads an up-to-date plan and does not share files with other conductors.

#### Acceptance Criteria

1. WHEN the person activates "Start" on a project with `worktree: true` THEN the start sequence SHALL, before creating the Crew chat:
   a. Tell the backend to fetch `origin` and create a git worktree at the Worktree_Path on a new Worktree_Branch freshly cut from `origin/<main-branch>`.
   b. Create a Crew subfolder (the Worktree_Folder) with `project_dir` equal to the Worktree_Path, as a child of the project's Crew_Folder.
   c. Create the Crew chat in the Worktree_Folder (not the project's Crew_Folder).
2. THE backend SHALL create the worktree by running `git fetch origin` then `git worktree add --no-checkout <path> -b <branch> origin/<main-branch>` then `git checkout` in the worktree, via the same subprocess pattern as `gitsource.py`. THE backend SHALL run no other git command on the shared checkout during this sequence.
3. THE Worktree_Path SHALL be `<parent-of-checkout>/<checkout-basename>--<branch-slug>`, where `<branch-slug>` is the Worktree_Branch with `/` replaced by `--`. Example: checkout at `/home/alice/my-project`, branch `story/filter-by-epic` → path `/home/alice/my-project--story--filter-by-epic`.
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
2. WHEN a new task group is started on a card whose previous group has a `started` record THEN the board SHALL treat it as a new start: a new Chat_Record, a new worktree at the new Worktree_Branch's path, a new Worktree_Folder and a new chat.

### Requirement 5: Cleanup

**User Story:** As a person whose pull request has been merged, I want the board to remove the worktree automatically, so that old worktrees do not pile up on my machine.

#### Acceptance Criteria

1. WHEN the board reads the Chat_List and a Started_Chat's `source_links` changes to include a pull request whose `state` is `merged` or `closed` THEN the page SHALL ask the backend to remove the worktree for that chat.
2. THE backend removal route SHALL run `git worktree remove <path>` on the shared checkout. WHEN the worktree has no uncommitted changes, the removal SHALL succeed. WHEN it has uncommitted changes, the removal SHALL fail and the backend SHALL answer with a reason.
3. WHEN the worktree is removed THEN the page SHALL also delete the Worktree_Folder via `DELETE /api/chat/folders/<worktree_folder_id>`, if the record has one. WHEN the folder cannot be deleted or the id is absent, the board SHALL proceed without it and not show an error.
4. WHEN the worktree cannot be removed because it has uncommitted changes THEN the card SHALL show "Worktree kept: uncommitted changes at `<path>`." in place of a state, with a "Remove anyway" button that force-removes with `git worktree remove --force <path>`.
5. WHEN the worktree removal succeeds THEN the board SHALL delete the Chat_Record and show the card as it was before the chat was started (with its Start button in the Planned or In progress column, or no controls in Done).
6. THE backend cleanup route SHALL require a valid gateway signature (the start spec's Requirement 5, criterion 7). It SHALL be: `DELETE /chats/<name>/worktree`.
7. WHEN the worktree_path is `null` for a record (a non-worktree start) THEN the cleanup route SHALL answer 200 immediately and do nothing.

### Requirement 6: Failure is visible

**User Story:** As a person starting a story, I want to see why a worktree could not be made, so that I can fix the problem without guessing.

#### Acceptance Criteria

1. IF the fetch fails during worktree creation THEN the backend SHALL return a failure with the reason. The card SHALL show "Could not create worktree: fetch failed — `<reason>`." and the question SHALL be offered again.
2. IF `git worktree add` fails THEN the backend SHALL return a failure with the reason. The card SHALL show "Could not create worktree: `<reason>`." and the question SHALL be offered again.
3. IF the Worktree_Folder creation fails (Crew rejects the POST) THEN the page SHALL remove the worktree (via the backend cleanup route) and show "Could not create worktree folder: `<reason>`." and the question again.
4. THE board SHALL NEVER fall back to the shared checkout when a worktree fails. The start SHALL be fully retried, or not started at all.
5. WHEN a worktree failure leaves a partially created worktree at the path THEN the backend SHALL clean it up with `git worktree remove --force <path>` on the next reserve call for the same card.

### Requirement 7: Theme, accessibility and failures

**User Story:** As a person using Kiro Crew in a light or dark theme, I want the new controls to be readable and usable by keyboard and screen reader.

#### Acceptance Criteria

1. THE new controls (the worktree checkbox in the Projects view, the "Remove anyway" button) SHALL follow the board spec's Requirement 10, criterion 1: no opaque colour as a text colour or element background, borders and tints in `currentColor` or a colour with an alpha above 0 and below 1.
2. THE "Worktree kept" text SHALL have the role `status`. The "Remove anyway" button SHALL be reachable by keyboard and SHALL act on Enter or Space.
3. THE board SHALL show every path as literal text, not as an HTML or Markdown link.
4. THE worktree checkbox in the Projects view SHALL be reachable by keyboard, SHALL show the browser's focus indicator, and SHALL act on Enter or Space.
