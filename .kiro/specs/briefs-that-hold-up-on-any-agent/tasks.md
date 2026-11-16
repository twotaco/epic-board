# Implementation Plan

## Overview

The work is three task groups. Each group is one pull request on its own branch, named `story/briefs-that-hold-up-on-any-agent-g1` to `story/briefs-that-hold-up-on-any-agent-g3`, cut from the latest main after the previous group's pull request is merged. Each group lands green on its own and leaves the app working. Every group ends with a sub-task that runs the tests and reports the counts run, passed and skipped. The page adds no dependency, and `app.json` is unchanged.

Group 1 reads AGENTS.md in the plan and rewrites the brief: the instructions section, the name-check step, the honest-reporting rules, the provenance rules and the confirmation. Group 2 adds the provenance meta line on the card. Group 3 checks the whole on a Crew host, which is the only place the brief, the provenance and the harness/model fields can be confirmed.

Start this story after "Show the board" (`.kiro/specs/show-the-board/`) group 6 has landed on main, because both the brief and the card's meta lines build on the code that story leaves.

## Tasks

- [ ] 1. Backend: instructions in the plan, and a brief that holds up
  - [ ] 1.1 Read AGENTS.md in `backend/plan.py`
    - Add `AGENTS_FILE = "AGENTS.md"`, `INSTRUCTIONS_THRESHOLD = 3000`, `read_instructions(source)` and `extract_headings(text)` as the design gives them
    - `read_instructions` reads `AGENTS.md` via `source.read_file`, returns the text or `None` on any exception; never raises, never adds a problem
    - `extract_headings` returns a list of Markdown heading lines (lines starting with one or more `#` followed by a space)
    - _Requirements: 1.1, 1.6_
  - [ ] 1.2 Include instructions in the plan body in `backend/held.py`
    - In `_plan_body`, call `read_instructions(snapshot)` and add `"instructions": <result>` to the returned dict
    - Update `first_read` and `_outcome` only if their call to `_plan_body` needs a change (it should not; they already pass the snapshot)
    - _Requirements: 1.1, 1.6_
  - [ ] 1.3 Pass instructions to `build_brief` in `backend/server.py`
    - In `ChatService.reserve`, pass `instructions=plan.get("instructions")` to `build_brief`
    - In `plan_response`, strip `instructions` from the plan before returning it to the page: `body = {k: v for k, v in value.items() if k != "instructions"}`
    - No other change to the handler
    - _Requirements: 1.2, 1.3, 1.4_
  - [ ] 1.4 Add the "Project instructions" section to `build_brief` in `backend/chats.py`
    - `build_brief(card, epic_file, branch, taken=(), instructions=None)` gains the keyword argument
    - When `instructions` is a non-empty string and within the threshold: add the section with the full text
    - When above the threshold: add the section with the headings summary (from `extract_headings`); when there are no headings, only the header line
    - When `None` or empty: no section
    - _Requirements: 1.2, 1.3, 1.4, 5.1_
  - [ ] 1.5 Update step 1 for the confirmation
    - When the instructions section is present, step 1 drops the AGENTS.md pointer and ends with the confirmation
    - When absent, step 1 keeps the pointer and appends the confirmation
    - Follow the eight variants in the design's step 1 table
    - _Requirements: 1.4, 1.5_
  - [ ] 1.6 Add the name-check step to both brief variants
    - A new numbered step after the work steps and before the commit step: "Before opening the pull request, list every table, column, function, file, setting, endpoint and command your change adds or relies on. Mark each as existing (with the file where you found it) or new (with the task that creates it). Fix anything that is neither found nor created. Put the list in the PR description."
    - Appears in the no-spec and with-spec variants
    - _Requirements: 2.1, 2.2, 2.3, 2.4_
  - [ ] 1.7 Add honest-reporting rules to the "Rules" section
    - Two new lines after the existing three rules: "Report the exact commands you ran and their results, including how many tests ran, how many passed and how many were skipped. Never claim a check you did not run." and "If a check was skipped, say so."
    - Both variants
    - _Requirements: 3.1, 3.2, 3.3_
  - [ ] 1.8 Add the commit-trailer and PR-footer rules
    - The last numbered step (commit, push, open PR) gains: "End each commit message with the trailer: Built-with: Kiro Crew, Epic Board (story: \<story name>). End the PR description with: Built with Kiro Crew, started from Epic Board · Story: \<story name> · \<your harness>, \<your model>. Write "unknown" for harness or model unless the brief or Crew states them."
    - `<story name>` is `_inline(card.get("name", ""), limit=BRIEF_NAME_MAX_CHARS)`, not the JSON-quoted form
    - _Requirements: 4.1, 4.2_
  - [ ] 1.9 Test `read_instructions` and `extract_headings` in `tests/test_plan.py`
    - `read_instructions` returns text for an existing file, `None` for a missing file (SourceError), `None` for an unreadable file (OSError, ValueError), `None` for a source with no `read_file`
    - `extract_headings` for: headings at levels 1–4, no headings, empty text, lines that look like headings but lack the space after `#`, indented headings
    - _Requirements: 1.1_
  - [ ] 1.10 Test the brief in `tests/test_chats.py`
    - `build_brief` with instructions: full text within the threshold, headings summary above it, `None`, empty string; the section is present or absent as expected
    - Step 1: keeps or drops the AGENTS.md pointer; always ends with the confirmation; the eight variants of the design's table
    - The name-check step in both variants
    - The honest-reporting rules in both variants
    - The commit-trailer and PR-footer rules with the story's plain-text name; the name in the trailer has no control characters
    - The existing three rules are unchanged
    - The existing brief tests pass unchanged (the `instructions` default is `None`)
    - The length test updated to < 10 000 with instructions at the threshold and worst-case names
    - Property 1 (threshold) and Property 2 (never breaks) as seeded tests with at least 100 iterations, seed printed on failure
    - _Requirements: 1.2, 1.3, 1.4, 1.5, 2.1, 2.4, 3.1, 3.3, 4.1, 4.2, 5.1, 5.2, 5.3_
  - [ ] 1.11 Test the plan body in `tests/test_held.py`
    - The plan body includes `instructions` (text or `None`) as `read_instructions` returns; the plan route response to the page does not include the `instructions` key
    - _Requirements: 1.1, 1.6_
  - [ ] 1.12 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and report the counts run, passed and skipped
    - Skip the page tests if only backend files changed in this group
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 2.1, 2.4, 3.1, 3.3, 4.1, 4.2, 5.1, 5.2, 5.3_

- [ ] 2. Page: provenance on the card
  - [ ] 2.1 Read harness and model from the chat slot row in `ui/index.mjs`
    - In `readChats` (or the function that builds the byKey entries from the chat list), read the model from `row.served_model` (the model the session ran on), falling back to `row.model` (the hand-picked one, often empty); treat anything but a non-empty string as absent (Crew sends `served_model` as `""` while it is not known, and then `model` is used)
    - Store it in the entry as `model`; pass it through to the card's view as `view.model`
    - The row has no harness field; the card shows the model only
    - _Requirements: 4.3, 4.4, 4.6_
  - [ ] 2.2 Show the provenance meta line on the card in `ui/index.mjs`
    - After the chat state badge (when the card has a Started_Chat and its state has been read), show a meta line: model present → the model text; model absent → "unknown"
    - The line is a `span` or `p` in the card's meta style (12px, `var(--muted)`, same class as the spec folder name), as literal text, not a link or badge or button
    - When the card has no Started_Chat or the state has not been read, show nothing
    - _Requirements: 4.3, 4.4, 4.5_
  - [ ] 2.3 Test the provenance display in `tests/ui/render.test.mjs` and `tests/ui/board.test.mjs`
    - `render.test.mjs`: the provenance meta line with `served_model` present, with only `model` present, with neither ("unknown"), and absent when no chat; the line is in the meta style
    - `board.test.mjs`: `createBoard` reads the model from `served_model` (falling back to `model`) in the chat slot and shows it; a row without either field shows "unknown"; a card with no chat shows no provenance
    - _Requirements: 4.3, 4.4, 4.5_
  - [ ] 2.4 Run the tests
    - Run `python3 -m unittest discover -s tests -t .` and `node --test tests/ui/*.test.mjs` and report the counts run, passed and skipped for each
    - _Requirements: 4.3, 4.4, 4.5, 4.6_

- [ ] 3. Check on a Crew host
  - [ ] 3.1 Install the app in Kiro Crew and check the brief and the card (done by you in the app)
    - Start a story from the board on a project that has an AGENTS.md and confirm the brief carries the "Project instructions" section with the file's text
    - Confirm step 1 asks the conductor to say which files it read, and does not repeat the AGENTS.md pointer
    - Confirm the name-check step, the honest-reporting rules and the provenance rules are in the brief
    - Confirm the card shows the model from `served_model` (or `model`) on the chat slot
    - Confirm a card whose chat slot has no `served_model` or `model` shows "unknown"
    - If a project's AGENTS.md is above 3000 characters, confirm the headings summary appears instead of the full text; if none is that long, note it and test with a temporary file
    - Write the owner's answers to the open questions of the design into the design
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 2.1, 3.1, 4.1, 4.2, 4.3, 4.4, 5.1_

## Notes

- Each group is one pull request and is merged by the owner; start the next group from the updated main
- The existing brief tests pass with no `instructions` argument because the default is `None`
- The page tests in group 2 need a fake chat slot row with `served_model` and `model` fields
- No task is optional: every task checks a requirement of this spec

## Task Dependency Graph

```json
{
  "waves": [
    { "id": 0, "tasks": ["1.1"] },
    { "id": 1, "tasks": ["1.2"] },
    { "id": 2, "tasks": ["1.3", "1.4", "1.5"] },
    { "id": 3, "tasks": ["1.6", "1.7", "1.8"] },
    { "id": 4, "tasks": ["1.9", "1.10", "1.11"] },
    { "id": 5, "tasks": ["1.12"] },
    { "id": 6, "tasks": ["2.1"] },
    { "id": 7, "tasks": ["2.2"] },
    { "id": 8, "tasks": ["2.3"] },
    { "id": 9, "tasks": ["2.4"] },
    { "id": 10, "tasks": ["3.1"] }
  ]
}
```
