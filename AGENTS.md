# Agent guide

Epic Board is a Kiro Crew app: a kanban of a project's specs and epics, read from its main branch, with a Start button that hands a story to a Crew conductor.

Read these before planning or changing anything:

- `docs/epics/`: the epics. Each spec in `.kiro/specs/` is a story in an epic.
- `.kiro/specs/<story>/`: the requirements, design and tasks for each story. Build what the spec says. If the spec looks wrong, say so instead of quietly building something different.
- `docs/spike/`: the spike that proved the approach on a real crew. It is a reference, not code to extend.

## How to work

- Work on a branch named `story/<spec-folder>`, one pull request per task group. Never merge; the owner reviews and merges.
- Tick each task in `tasks.md` as you finish it, in the same branch.
- The backend uses the Python standard library only. Add no dependencies.

## Checks before you report work as done

Run the tests and report how many ran and passed:

- `python3 -m unittest discover -s tests -t .`

The page tests need Node. They run through `tests/test_ui.py`, which runs `node --test tests/ui/*.test.mjs` and is reported as skipped when Node is missing. A skipped test is not a pass; report it as skipped.

Skip the tests only when you changed nothing but Markdown, and say so.
