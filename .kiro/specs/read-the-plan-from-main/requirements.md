# Requirements Document

## Introduction

This story is the foundation of the Epic Board epic (`docs/epics/epic-board.md`). It delivers the Kiro Crew app and its backend, which reads a project's plan from the main branch and returns it as data: every spec as a card with a status, grouped under the epics that list it. Showing the board is the next story, and starting a story is the one after.

The plan comes from two places in the repository. Every spec in `.kiro/specs/` is a card, and its status comes from its `tasks.md`. Epics in `docs/epics/` are optional. When they exist they group the cards and add stories that have no spec yet. The backend reads files from the main branch of the repository's `origin` and never changes the repository.

In these requirements, the main branch is the branch that `origin/HEAD` points to in the configured checkout, or `main` when `origin/HEAD` is not set.

Statuses are `planned`, `in progress` and `done`.

## Requirements

### Requirement 1

**User Story:** As a person planning a project with Kiro, I want to install the app and point it at my repository once, so that the board always reads the project I work on.

#### Acceptance Criteria

1. WHEN the app is installed in Kiro Crew THEN the app SHALL declare a backend with a health route that answers when the backend is running.
2. WHEN the app starts THEN the backend SHALL take the repository to read from the environment variable `EPIC_BOARD_REPOSITORY` if it is set and not empty, and otherwise from the `repository` value in a file named `config.json` in the app's own folder, as the path of one local checkout. The first source that is present SHALL be used, and a bad value in it SHALL NOT fall through to the next source.
3. WHEN a request to the backend carries a repository path, in its query or its body THEN the backend SHALL ignore it and read only the configured repository.
4. IF neither source gives a repository, or `config.json` exists but cannot be read as an object with a text `repository` value, or the configured path is not a git checkout THEN the plan response SHALL be an error that names both the environment variable and `config.json` and says what is wrong, and SHALL contain no plan.
5. WHEN the app is committed to a repository THEN `config.json` SHALL NOT be part of it, so a person's repository path is never published.

### Requirement 2

**User Story:** As a person planning a project, I want the plan to come only from the main branch, so that the board shows what has landed and not what is half done on a branch.

#### Acceptance Criteria

1. WHEN the plan is built THEN the backend SHALL determine the main branch: the branch `origin/HEAD` points to in the checkout, or `main` if `origin/HEAD` is not set or does not name a branch.
2. WHEN the main branch is determined THEN the backend SHALL fetch it from `origin` and read every file from `origin/<main branch>`, except that the first plan after the backend starts is read before any fetch, as `show-the-board` Requirement 5 describes.
3. WHEN the plan is read THEN the backend SHALL read files from the git object store and SHALL NOT read the working tree, so uncommitted changes and local branches have no effect on the plan.
4. IF the fetch fails and a previously fetched `origin/<main branch>` exists THEN the backend SHALL read that copy and the plan response SHALL say that the fetch failed and give the reason.
5. IF the fetch fails, no `origin/<main branch>` exists and the backend holds no earlier plan (`show-the-board` Requirement 6) THEN the plan response SHALL be an error that says the ref could not be read, and SHALL contain no plan.
6. WHEN the plan is returned THEN the response SHALL name the repository, the main branch and the ref it was read from.

### Requirement 3

**User Story:** As a person planning a project, I want every spec in the project to appear on the board, so that the board works on any Kiro project, with or without epics.

#### Acceptance Criteria

1. WHEN the main branch contains a folder under `.kiro/specs/` THEN the plan SHALL contain a card for that spec. The card SHALL be named after the folder unless a story names it, as described in Requirement 5.
2. WHEN a spec folder has no `tasks.md` THEN its card SHALL still be in the plan, with status `planned` and task counts of 0 done out of 0.
3. WHEN the main branch has no `.kiro/specs/` folder THEN the plan SHALL contain no spec cards and SHALL NOT report an error.
4. WHEN a card comes from a spec THEN it SHALL record the spec folder name and the number of tasks done and the total number of tasks, counted as described in Requirement 4.

### Requirement 4

**User Story:** As a person building from specs, I want a spec's status to follow its tasks, so that the board moves as work is ticked off and lands on main.

#### Acceptance Criteria

1. WHEN a spec's `tasks.md` is read THEN every markdown checkbox item, at any nesting depth, SHALL count as one task, except an optional task, which is a checkbox item with `*` directly after the checkbox, as in `- [ ]*`. An optional task SHALL be left out of every count, whatever its mark.
2. WHEN a task is marked `[x]` THEN it SHALL count as done. WHEN a task is marked `[-]` THEN it SHALL count as under way.
3. WHEN a spec has at least one task and every task is done THEN its status SHALL be `done`.
4. WHEN a spec is not done and has at least one task that is done or under way THEN its status SHALL be `in progress`.
5. WHEN a spec has no tasks, or has tasks and none is done or under way THEN its status SHALL be `planned`.
6. IF a spec's `tasks.md` exists but cannot be read THEN the spec's card SHALL still be in the plan with status `planned` and no task counts, and the problem SHALL be reported as described in Requirement 7.

### Requirement 5

**User Story:** As a person who plans with epics, I want the epics to group the cards and add the stories that have no spec yet, so that the whole plan is visible before every spec is written.

#### Acceptance Criteria

1. WHEN the main branch contains Markdown files in `docs/epics/` THEN each file SHALL be read as an epic, except `README.md`, which SHALL be ignored, and `standalone.md`, which is read as described in criterion 9.
2. WHEN an epic is read THEN its name SHALL be the text of its first level-one heading, or its file name if it has none.
3. WHEN an epic has a `## Stories` section THEN each list item in that section of the form `- [Name](link) — status` or `- Name — status` SHALL be a story of that epic, in the order written.
4. WHEN the text after a story's dash is read THEN the status SHALL be the text before its first full stop, or all of it if it has none, and anything after that full stop SHALL be the story's description. WHEN the status, ignoring case and surrounding spaces, is `planned`, `in progress` or `done` THEN that SHALL be the story's epic status. Any other text, or no text, SHALL mean the story has no epic status.
5. WHEN a story's link points to a spec folder under `.kiro/specs/` that exists on the main branch THEN the story SHALL be that spec's card, named as the story is named.
6. WHEN a story has no link, or its link points to a spec folder that does not exist on the main branch THEN the story SHALL be a card with no spec, whose status is its epic status, or `planned` if it has none.
7. WHEN the same spec is listed in more than one epic THEN its card SHALL appear under each of those epics.
8. WHEN the main branch has no `docs/epics/` folder, or it has no epic files THEN the plan SHALL contain no epics and SHALL NOT report an error.
9. WHEN `docs/epics/standalone.md` exists THEN its stories SHALL be read as in criteria 3 to 6, taken from its `## Stories` section if it has one and from the whole file if it has none, and their cards SHALL belong to no epic.
10. WHEN a spec is listed in `standalone.md` and also in an epic THEN the line in `standalone.md` SHALL be ignored.

### Requirement 6

**User Story:** As a person who closes stories by decision, I want an epic to be able to mark a story done while tasks remain, so that the board matches the decision I recorded.

#### Acceptance Criteria

1. WHEN a story is a spec card and its epic status is `done` THEN the card's status SHALL be `done`, whatever its tasks say, and its recorded task counts SHALL still be those of its `tasks.md`.
2. WHEN a story is a spec card and its epic status is `planned`, `in progress`, or absent THEN the card's status SHALL come from its tasks, as described in Requirement 4.
3. WHEN a spec is listed in more than one epic THEN the epic status in each epic SHALL apply only to the card under that epic.

### Requirement 7

**User Story:** As a person reading the plan, I want one broken file not to hide the rest, so that the board stays useful while I fix it.

#### Acceptance Criteria

1. WHEN an epic file or a `tasks.md` cannot be read THEN the plan response SHALL still contain everything that could be read.
2. WHEN a file cannot be read THEN the plan response SHALL list a problem naming the file and the reason.
3. WHEN a story line in an epic does not match the story form THEN the line SHALL be skipped and SHALL NOT be reported as a problem.
4. WHEN no problem occurred THEN the plan response SHALL contain an empty list of problems.

### Requirement 8

**User Story:** As a person planning a project, I want the plan grouped the way I would read it, so that the board can show it without further work.

#### Acceptance Criteria

1. WHEN the plan is returned THEN it SHALL contain one group per epic, in order of epic file name, each holding its cards in the order the stories are written.
2. WHEN a spec is listed in no epic, or a story comes from `standalone.md` THEN its card SHALL be in a group named "No epic". A spec SHALL appear there once, however many times `standalone.md` lists it, and the cards SHALL be ordered by name, ignoring case.
3. WHEN the "No epic" group would have no cards THEN the plan SHALL omit it.
4. WHEN a card is returned THEN it SHALL contain its name, its status, its spec folder name or none, its task counts, its description (`show-the-board` Requirement 4), the name of the epic it is under or none, and its `id`. The task counts SHALL be none only for a card with no spec, or for a spec whose `tasks.md` exists but cannot be read. The `id` SHALL be the file name of the epic the card is under, a `#`, and the card's name, for example `epic-board.md#Start a story`, or a `#` and the card's name for a card in the "No epic" group. The `id` does not change when a story's spec is merged to main, because a story's name and epic stay the same.

### Requirement 9

**User Story:** As the owner of the repository, I want reading the plan to leave the repository untouched, so that the app is safe to run against a project I am working in.

#### Acceptance Criteria

1. WHEN the backend reads the plan THEN it SHALL NOT change the working tree, the index, any local branch or any git configuration. Its only writes SHALL be those of a fetch of the main branch: new objects, the `origin/<main branch>` ref and `FETCH_HEAD`.
2. WHEN the backend runs git THEN it SHALL pass the repository path and every other value as separate arguments and SHALL NOT build a shell command from them.
3. WHEN a git command runs THEN the backend SHALL stop it after a fixed time limit and SHALL report a timeout as a failed read.
4. WHEN a git command would ask for input, such as a password or a host key confirmation THEN it SHALL fail instead of waiting.
