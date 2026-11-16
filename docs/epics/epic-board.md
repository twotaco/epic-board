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
- [Show the board](../../.kiro/specs/show-the-board/) — in progress. Group 6: a story moves to In progress when work on it starts.
- [Start a story](../../.kiro/specs/start-a-story/) — done. Click a card to start a conductor on it, see the state of its chat on the card, and open the chat from the card.
- [Work in the chat](../../.kiro/specs/work-in-the-chat/) — done. Click a card to open its conductor's chat beside the board, and approve, answer and steer it without leaving the board. Built after the fix to starting a story.
- [Filter by epic](../../.kiro/specs/filter-by-epic/) — done. A dropdown at the top of the board shows one epic or all of them.
- [Board design](../../.kiro/specs/board-design/) — done. The board looks like part of Kiro Crew: Crew's own buttons, cards, badges, header and notices, column headers like Crew's Sessions board, bold card titles, quieter meta lines, and descriptions cut to three lines. Built after "Work in the chat".
- [Switch projects](../../.kiro/specs/switch-projects/) — done. One board for several projects: `config.json` lists them and a dropdown beside the epic filter switches between them. Built after "Work in the chat" and the chat state change.
- [Set up projects](../../.kiro/specs/set-up-projects/) — done. A Projects view lets the person pick which Crew folders the board shows, without editing `config.json` by hand. Built after "Switch projects".
- A worktree per card — planned. Each started story works in its own folder, made fresh from the latest main, so several conductors can work on one project at once without changing each other's files or reading an old copy of the plan. Decided:
  - The problem today. Every conductor works in the project's one checkout. Two started cards share its files, and one conductor switching branches changes the files under the other; the chat footer of every chat in the project shows the same branch. The brief never fetches and reads the epic page before it branches, so a conductor can work from a stale main (a conductor once reported its story missing from the epic page after it had been pushed).
  - What changes. Crew starts a new chat in its folder's project directory, the shared checkout, and only makes a worktree when a person presses "Start in new worktree" on a follow-up card, which apps may not call. The board does the same for every card by itself: it makes the worktree and opens the chat there. The chat stays filed in the project's folder; no folder is made per card.
  - The person chooses, per project. The Projects view gets a setting on each project, "Start each story in its own worktree", on by default. The Start question says which will happen: "Works in its own worktree" or "Works in the shared checkout". With the setting off, the board works as it does today.
  - Fresh before reading. When a card starts, the board fetches origin, creates a worktree beside the checkout on the brief's branch (`story/<folder>`, or `story/<spec>-g<N>` for a task group) from origin's main, and opens the conductor's chat there, so the conductor and its workers read and work only in it.
  - Ready to build. The brief's first step runs the project's setup in the new worktree (for example `npm ci`), as its AGENTS.md says, before any check.
  - Catch up before the pull request. Before opening or updating the pull request, the conductor fetches, merges origin's main into its branch, resolves any conflicts, reruns the checks and says so in the chat.
  - Resuming and cleaning up. Reopening a card's chat reuses its worktree. A later task group starts a new worktree from the fresh main. Once the pull request is merged or closed, the board removes the worktree, only when it has no uncommitted changes; otherwise the card says it was kept.
  - Failure is visible. If the fetch or the worktree fails, the card says why and no conductor starts. It never falls back to the shared checkout.
  - Not in this story: merging, auto-merge, or resolving conflicts for the person. Shared resources such as ports and test databases stay with the project's own rules.
  - Open question, checked in Crew 0.12.2's source: Crew's worktree endpoint (`POST /api/worktree/create`) is for dashboard users only and refuses apps, so the board's backend runs git itself, as it already does for the plan. Still to confirm first: how an app opens a chat in a given directory. Crew's follow-up card passes a `project` path, but chat creation for an app takes only a folder. If an app can't, the fallback is a subfolder of the project's folder per card, owned by the app (apps may create folders; Crew marks them `owner_app`), which "Not in this epic" would then need to allow.
