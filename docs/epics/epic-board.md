# Epic Board

Status: active

## The epic

Epic Board is for one person planning and building a project with Kiro. They open a Kiro Crew app and see the whole plan on one board: every spec as a card, in Planned, In progress and Done columns, with how many of its tasks are ticked. The board works on any Kiro project, because every spec in `.kiro/specs/` is a card whose column comes from its tasks. When the project also has epics, the cards are grouped under them, and stories that have no spec yet appear as planned cards. Specs that belong to no epic sit under "No epic". They click a card and start a Crew conductor on it: it writes the spec on a branch when there is none, or builds the next task group when there is one, and opens a pull request to review. It never merges. The conductor's chat opens beside the board, so they approve its tool calls, answer its questions and steer it without leaving the board.

It matters now because the plan already lives in files on main, and nothing shows it at a glance or turns "what's next?" into work started. The board reads only main and never edits it, so it always shows what has landed, and the plan changes through Kiro as before. A started story shows its chat's status (working, needs you, interrupted or idle) and opens its chat, and it changes column only when its work lands on main.

## Not in this epic

- Editing the plan from the board: moving cards, changing statuses or writing epic files.
- The board following a conductor's work for the person. The board shows one of six states for the story's chat and its workers and embeds Crew's own chat for the person to use. The board's own code does not read the chat's messages, and does not approve or answer anything for the conductor.
- Merging. The conductor opens pull requests and the person reviews and merges them.
- Creating or renaming Crew folders, or editing a folder's project directory. The board reads folders; Crew manages them.

## Stories

- [Read the plan from main](../../.kiro/specs/read-the-plan-from-main/) — done
- [Show the board](../../.kiro/specs/show-the-board/) — done
- [Start a story](../../.kiro/specs/start-a-story/) — in progress. Click a card to start a conductor on it, see the state of its chat on the card, and open the chat from the card.
- [Work in the chat](../../.kiro/specs/work-in-the-chat/) — in progress. Click a card to open its conductor's chat beside the board, and approve, answer and steer it without leaving the board. Built after the fix to starting a story.
- [Filter by epic](../../.kiro/specs/filter-by-epic/) — done. A dropdown at the top of the board shows one epic or all of them.
- [Board design](../../.kiro/specs/board-design/) — in progress. The board looks like part of Kiro Crew: Crew's own buttons, cards, badges, header and notices, column headers like Crew's Sessions board, bold card titles, quieter meta lines, and descriptions cut to three lines. Built after "Work in the chat".
- [Switch projects](../../.kiro/specs/switch-projects/) — in progress. One board for several projects: `config.json` lists them and a dropdown beside the epic filter switches between them. Built after "Work in the chat" and the chat state change.
- [Set up projects](../../.kiro/specs/set-up-projects/) — in progress. A Projects view lets the person pick which Crew folders the board shows, without editing `config.json` by hand. Built after "Start a story" and "Switch projects".
