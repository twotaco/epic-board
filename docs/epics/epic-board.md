# Epic Board

Status: active

## The epic

Epic Board is for one person planning and building a project with Kiro. They open a Kiro Crew app and see the whole plan on one board: every spec as a card, in Planned, In progress and Done columns, with how many of its tasks are ticked. The board works on any Kiro project, because every spec in `.kiro/specs/` is a card whose column comes from its tasks. When the project also has epics, the cards are grouped under them, and stories that have no spec yet appear as planned cards. Specs that belong to no epic sit under "No epic". They click a card and start a Crew conductor on it: it writes the spec on a branch when there is none, or builds the next task group when there is one, and opens a pull request to review. It never merges.

It matters now because the plan already lives in files on main, and nothing shows it at a glance or turns "what's next?" into work started. The board reads only main and never edits it, so it always shows what has landed, and the plan changes through Kiro as before. A started story shows its chat's status (working, needs you, interrupted or idle) and a link to the chat, and it changes column only when its work lands on main.

## Not in this epic

- Several projects or repositories on one board. A board shows one repository, set in the app's config.
- Editing the plan from the board: moving cards, changing statuses or writing epic files.
- Following a conductor's work inside its chat. The board shows one of four states for the chat and links to it. It does not read the chat's messages, and it does not approve or answer anything for the conductor.
- Merging. The conductor opens pull requests and the person reviews and merges them.

## Stories

- [Read the plan from main](../../.kiro/specs/read-the-plan-from-main/) — done
- [Show the board](../../.kiro/specs/show-the-board/) — done
- [Start a story](../../.kiro/specs/start-a-story/) — in progress. Click a card to start a conductor on it, see the state of its chat on the card, and open the chat from the card.
- Filter by epic — planned. A dropdown at the top of the board shows one epic or all of them.
- Board design — planned. A clearer type scale, bold column and card titles, quieter meta lines, and descriptions cut to three lines.
