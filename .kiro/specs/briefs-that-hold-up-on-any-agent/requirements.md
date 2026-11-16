# Requirements Document

## Introduction

This story is part of the Epic Board epic (`docs/epics/epic-board.md`). It builds on "Start a story" (`.kiro/specs/start-a-story/`, "the start spec"), which defines the brief that the board sends to a conductor when a card is started, and on "Read the plan from main" (`.kiro/specs/read-the-plan-from-main/`), whose backend reads files from the main branch. This story does not restate those specs.

Today the brief tells the conductor "Read the project's AGENTS.md and steering files", but different harnesses load different instructions. Crew's Claude Code harness, when a project has its own `.claude/settings.local.json`, runs with only the machine's user settings, so the project's CLAUDE.md and the AGENTS.md it points to never load; the brief's one line is all the conductor has. In a live case, a conductor on Claude Sonnet 4.6 wrote a design naming a database schema, a session setting and a table that don't exist. All three would have been caught by reading the code, and fixing them took two review rounds.

This story changes four things. First, the brief carries the project's own agent instructions instead of only a pointer to them, so every harness starts from the same rules. Second, a new step asks the conductor to verify every name the change adds or relies on against the code, and to fix anything that doesn't match, before opening the pull request. Third, the brief requires honest reporting: exact commands, exact counts, no false claims. Fourth, every commit and pull request records what built it — the story name, harness and model — and the card on the board shows the harness and model of the conductor's chat.

## Glossary

- **Agent_Instructions**: the text of the project's `AGENTS.md`, read from the main branch. When the file does not exist or cannot be read, Agent_Instructions is absent.
- **Instructions_Threshold**: 3000 characters. When the Agent_Instructions are longer than this, the brief carries only their headings.
- **Headings_Summary**: the Markdown headings of the Agent_Instructions (lines that start with one or more `#` characters followed by a space), each on its own line, preceded by a line that says the file should be read in full. When the text has no headings, only that line appears.
- **Name_Check**: the list in the PR description that names every table, column, function, file, setting, endpoint and command the change adds or relies on, each marked as existing (with the file where it was found) or new (with the task that creates it).
- **Provenance_Line**: the footer of a PR description: "Built with Kiro Crew, started from Epic Board · Story: \<story name> · \<harness>, \<model>".
- **Commit_Trailer**: the last line of a commit message: "Built-with: Kiro Crew, Epic Board (story: \<story name>)".
- **Harness_Name**: the harness that runs the conductor. Crew's chat slot row has no harness field, so the conductor itself writes it in the PR footer; the card does not show it. When the conductor does not know its harness, it writes "unknown".
- **Model_Name**: the model the conductor uses, from the chat slot row's `served_model` field (the model the session ran on), falling back to `model` (the hand-picked one, often empty). When neither is present, it is absent.

## Requirements

### Requirement 1: Agent instructions in the brief

**User Story:** As a person who starts stories from the board, I want the conductor's brief to carry my project's own rules for agents, so that every harness and model gets the same instructions without relying on the harness to load them.

#### Acceptance Criteria

1. THE plan SHALL read the file `AGENTS.md` at the root of the project's repository on the main branch, the same way it reads specs and epics. WHEN the file does not exist or cannot be read THEN the plan SHALL hold no Agent_Instructions and SHALL NOT add a problem or show an error.
2. WHEN the Agent_Instructions are present and their length is at most the Instructions_Threshold THEN the brief SHALL include their full text in a section headed "Project instructions (from AGENTS.md on main):", after the opening lines and before the numbered steps.
3. WHEN the Agent_Instructions are present and their length is above the Instructions_Threshold THEN the brief SHALL include the Headings_Summary in the same section, headed "Project instructions (from AGENTS.md on main — read the full file before anything else):".
4. WHEN the Agent_Instructions are absent THEN the brief SHALL have no "Project instructions" section. The brief's step 1 SHALL keep the pointer to AGENTS.md that the start spec gives ("Read the project's AGENTS.md and steering files. Follow them for how specs, branches and checks work."), so the conductor can still find the file if the harness puts it in the working directory.
5. THE brief's step 1 SHALL tell the conductor to confirm in the chat which project files it read. WHEN the "Project instructions" section is present THEN step 1 SHALL NOT repeat the pointer to AGENTS.md, because the instructions are already in the brief.
6. THE reading of AGENTS.md SHALL happen once when the plan is built (in the same git read as the specs and epics) and be held in memory with the plan, so that a reserve request adds no git operation. THE `/plan` response that the page polls SHALL NOT include the instructions text.

### Requirement 2: Verify every name before the pull request

**User Story:** As a person who reviews pull requests, I want every name in the change — every table, function, file, setting, endpoint and command — checked against the code before I see the PR, so that a conductor on a model that invents names is caught before the review.

#### Acceptance Criteria

1. THE brief SHALL include a step, after the work steps and before the commit step, that says: "Before opening the pull request, list every table, column, function, file, setting, endpoint and command your change adds or relies on."
2. THE step SHALL say: "Mark each as existing (with the file where you found it) or new (with the task that creates it). Fix anything that is neither found nor created."
3. THE step SHALL say: "Put the list in the PR description."
4. THIS step SHALL appear in both variants of the brief (no spec and with spec).

### Requirement 3: Honest reporting of checks

**User Story:** As a person who reads what a conductor says it ran, I want it to report the exact commands and counts, and never claim a check it did not run, so that I can trust the report.

#### Acceptance Criteria

1. THE brief SHALL include a rule: "Report the exact commands you ran and their results, including how many tests ran, how many passed and how many were skipped."
2. THE brief SHALL include a rule: "Never claim a check you did not run. If a check was skipped, say so."
3. THESE rules SHALL appear in the "Rules" section of both variants of the brief.

### Requirement 4: Provenance — what built the change

**User Story:** As a person who tracks how stories are built, I want every commit and pull request to say which harness and model built it, and the card to show the same, so that I can compare models on real work.

#### Acceptance Criteria

1. THE brief SHALL include a rule that tells the conductor to end each commit message with the Commit_Trailer, where \<story name> is the story's name as plain text (not the JSON-quoted form of the opening line).
2. THE brief SHALL include a rule that tells the conductor to end the PR description with the Provenance_Line, where \<harness> and \<model> are what the brief or Crew states, and "unknown" for what is not stated. The conductor SHALL NOT guess.
3. WHEN a card has a Started_Chat THEN the card SHALL show the Model_Name as a meta line in the card's meta style (the same size and muted colour as the spec folder name). WHEN the Model_Name is absent THEN the line SHALL show "unknown".
4. WHEN a card has no Started_Chat, or its state has not been read, THEN the card SHALL show no provenance meta line.
5. THE provenance meta line SHALL be shown as literal text and SHALL NOT be a link, a badge or a button.
6. THIS story SHALL NOT change how the board creates a chat (the `agent`, `folder_id` and `name` of the start spec), and SHALL NOT choose a harness or model for the conductor. The harness and model come from Crew's own settings.

### Requirement 5: Project checks pass through

**User Story:** As a person whose project has its own checks, I want the brief to carry them from AGENTS.md instead of inventing others, so that the project stays in control.

#### Acceptance Criteria

1. THE "Project instructions" section SHALL carry the full Agent_Instructions or their Headings_Summary as Requirement 1 says, including whatever checks the project names in AGENTS.md. THE board SHALL NOT add project-specific check commands of its own.
2. WHEN the Agent_Instructions are absent THEN the brief's existing rules (the start spec's step about reading AGENTS.md and following the checks the project names) SHALL be the only guidance the conductor gets about project checks. THE board SHALL add no check command beyond the rules of Requirements 2 and 3.
3. THIS story SHALL NOT change the brief's existing three rules of the start spec (never merge, one PR, ask if blocked) except to add the rules of Requirements 3 and 4 after them.
