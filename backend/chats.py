"""Which chat belongs to which card: the brief, the spec folder name and the file of records.

No HTTP and no git. The store is one file, `chats.json`, in the app's data folder.
"""
import json
import os
import re
import secrets
import tempfile
import threading
from datetime import datetime, timezone

CHATS_FILE = "chats.json"
NAME_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,193}$")
RECORD_KEYS = {"card_id", "name", "key", "state", "created", "worktree_path", "worktree_folder_id"}
_OLD_RECORD_KEYS = {"card_id", "name", "key", "state", "created"}
STATES = ("reserved", "started", "finished")
MAX_CARD_ID_CHARS = 400
SLUG_MAX_CHARS = 60
BRIEF_NAME_MAX_CHARS = 200
BRIEF_PATH_MAX_CHARS = 255


class ChatError(Exception):
    """A refusal with a code, an HTTP status and a message that holds no repository path."""

    def __init__(self, code, status, message):
        super().__init__(message)
        self.code, self.status, self.message = code, status, message


# ---- Spec folder name and brief ----

def slugify(name, taken=()):
    """The folder name for a new spec: lower-case ASCII letters and digits joined by single hyphens,
    cut to 60 characters, `story` when nothing is left, then `-2`, `-3`... until it is unused."""
    slug = re.sub(r"[^A-Za-z0-9]+", "-", name or "").lower().strip("-")
    slug = slug[:SLUG_MAX_CHARS].rstrip("-") or "story"
    taken = set(taken)
    candidate, number = slug, 1
    while candidate in taken:
        number += 1
        candidate = f"{slug}-{number}"
    return candidate


_CONTROL = re.compile("[\x00-\x1f\x7f\u2028\u2029]")


def _inline(text, limit=BRIEF_PATH_MAX_CHARS):
    """A name from a file or a branch, safe to put in one line of the brief."""
    return _CONTROL.sub("?", str(text))[:limit]


def _quoted(name):
    """The story's name as a quoted string, so quotes and line breaks in it cannot end the line."""
    return json.dumps(str(name)[:BRIEF_NAME_MAX_CHARS], ensure_ascii=False).replace("\u2028", "\\u2028").replace("\u2029", "\\u2029")


def _rules(branch):
    return [
        "Rules:",
        f"- Never merge a pull request, never push to {branch}, never turn on auto-merge. The person reviews and merges.",
        "- Open exactly one pull request. When it is open, write its address in this chat and stop.",
        "- If you are blocked or unsure, ask in this chat. Do not guess.",
        "- Report the exact commands you ran and their results, including how many tests ran, how many passed and how many were skipped. Never claim a check you did not run.",
        "- If a check was skipped, say so.",
    ]


def _numbered(steps):
    return [f"{number}. {text}" for number, text in enumerate(steps, 1)]


_CONFIRM = "Confirm in this chat which project files you read."
_SPEC_CODE = ("Before writing the design, read the code the story touches and build on what exists. "
              "Say in the design what already exists and what is new.")
_SPEC_TASKS = ("Shape tasks.md so the whole story can be built in one run, with a review after each top-level group in tasks.md: "
               "each group ends with the project's checks passing and names the tests that prove it, and any step that "
               "needs the person (a deploy, a check on a live system or on hardware, a decision) goes in its own group "
               "at the end, marked as needing the owner.")
_REVIEW_STEP = ("After each group passes the checks, start a crew worker as its reviewer, with a fresh context. Give it "
                "the spec folder, the branch and the group number, not your summary. It reads the group's diff against the "
                "spec and the code, reruns the checks and reports what is wrong or missing; use a different model for it "
                "when Crew offers one. Fix what it finds, have it check again, and start the next group only when it reports "
                "nothing left to fix.")
_STOP_STEP = ("Stop only when a task needs the person (a deploy, a live or hardware check, a decision), the spec does not "
              "answer a question, you and the reviewer disagree on the same finding twice, or a model or rate limit stops "
              "you. Never retry a rate limit in a loop. When you stop, push, open the pull request with what is built so "
              "far, and say in this chat why you stopped.")
_REVIEW_REPORT = ("In the PR description, list each group built, what the reviewer found and how each finding was fixed, "
                  "and the checks that ran with their counts.")
_NAME_CHECK = ("Before opening the pull request, list every table, column, function, file, setting, endpoint and "
               "command your change adds or relies on. Mark each as existing (with the file where you found it) or "
               "new (with the task that creates it). Fix anything that is neither found nor created. "
               "Put the list in the PR description.")
_OPEN_PRS = ("Before you change anything, list the project's open pull requests (for example with `gh pr list`). If one "
             "changes the same files, or takes the same migration number or other numbered file, say so in this chat and "
             "say how you will avoid the clash.")
_SETUP_STEP = ("This story runs in its own worktree. Before anything else, run the project's setup "
               "(as AGENTS.md says — for example `npm ci`).")


def build_brief(card, epic_file, branch, taken=(), instructions=None, worktree_path=None):
    """The first message of a conductor chat, as plain text built only from the card's name and spec
    folder, the epic file and the main branch. The same inputs give the same text. It never includes
    the story's description or any task text."""
    name = _quoted(card.get("name", ""))
    branch = _inline(branch)
    story_name = _inline(card.get("name", ""), limit=BRIEF_NAME_MAX_CHARS)
    epic = f"Epic page: docs/epics/{_inline(epic_file)}" if epic_file else "Epic page: none, this story has no epic"
    opening = ["You are the conductor for one story of this project. Work in the checkout you were opened in.", "",
               f"Story: {name}", epic]
    has_instructions = bool(instructions and instructions.strip())
    if has_instructions:
        from plan import INSTRUCTIONS_THRESHOLD, extract_headings
        opening.append("")
        if len(instructions) <= INSTRUCTIONS_THRESHOLD:
            opening.append("Project instructions (from AGENTS.md on main):")
            opening.append(instructions)
        else:
            opening.append("Project instructions (from AGENTS.md on main — read the full file before anything else):")
            for heading in extract_headings(instructions):
                opening.append(heading)
    provenance = (f" End each commit message with the trailer: Built-with: Kiro Crew, Epic Board (story: {story_name}). "
                  f"End the PR description with: Built with Kiro Crew, started from Epic Board · Story: {story_name} · "
                  '<your harness>, <your model>. Write "unknown" for harness or model unless the brief or Crew states them.')
    has_worktree = bool(worktree_path and worktree_path.strip())
    catch_up = (f"Before opening or updating the pull request, run `git fetch origin` and "
                f"`git merge origin/{branch}` in the worktree. Resolve any conflicts, rerun the checks "
                "the project names and say so in this chat.")
    spec = card.get("spec")
    if spec is None:
        folder = slugify(card.get("name", ""), taken)
        if has_instructions:
            step1 = f"Read the story's entry in the epic page. {_CONFIRM}" if epic_file else _CONFIRM
        else:
            if epic_file:
                step1 = ("Read the story's entry in the epic page, and the project's AGENTS.md and steering files. "
                         f"Follow them for how specs, branches and checks work. {_CONFIRM}")
            else:
                step1 = ("Read the project's AGENTS.md and steering files. "
                         f"Follow them for how specs, branches and checks work. {_CONFIRM}")
        work_steps = [
            step1,
            _OPEN_PRS,
            f"Create a branch named story/{folder} from origin/{branch}. If the project names branches another way, follow the project.",
            f"Write requirements.md, design.md and tasks.md in .kiro/specs/{folder}/, in the project's usual spec format.",
            _SPEC_CODE,
            _SPEC_TASKS,
        ]
        if epic_file:
            work_steps.append(f"Change the story's line in the epic page to link to .kiro/specs/{folder}/. Set its status to in progress.")
        steps = []
        if has_worktree:
            steps.append(_SETUP_STEP)
        steps.extend(work_steps)
        if has_worktree:
            steps.append(catch_up)
        steps.append(_NAME_CHECK)
        steps.append(f"Commit, push the branch, and open one pull request into {branch}.{provenance}")
        lines = opening + [f"Main branch: {branch}", "Your job: write this story's spec. It has none yet.", ""] + _numbered(steps)
    else:
        spec = _inline(spec)
        if has_instructions:
            step1 = f"Read requirements.md, design.md and tasks.md in .kiro/specs/{spec}/"
            step1 += f", and the epic page. {_CONFIRM}" if epic_file else f". {_CONFIRM}"
        else:
            step1 = f"Read the project's AGENTS.md and steering files, then requirements.md, design.md and tasks.md in .kiro/specs/{spec}/"
            step1 += f", and the epic page. {_CONFIRM}" if epic_file else f". {_CONFIRM}"
        work_steps = [
            step1,
            _OPEN_PRS,
            "Build every top-level task group that has a task not ticked yet, one group at a time, in order, starting "
            "with the first. If every task is ticked, change nothing and say so in this chat.",
            "If the spec has no tasks, write tasks.md as the only change of your pull request and build nothing.",
            f"Create a branch named story/{spec}-g<N> from origin/{branch}, where <N> is the number of the first group "
            "you build. Build every group on this one branch. If the project names branches another way, follow the project.",
            "Tick each task you finish in tasks.md, in the same branch. Run the checks the project names after each "
            "group, fix what fails, and commit.",
            _REVIEW_STEP,
            _STOP_STEP,
            _REVIEW_REPORT,
        ]
        if epic_file:
            work_steps.append("If your work ticks the last task in tasks.md, set the story's line in the epic page to done, "
                              "in the same pull request.")
        steps = []
        if has_worktree:
            steps.append(_SETUP_STEP)
        steps.extend(work_steps)
        if has_worktree:
            steps.append(catch_up)
        steps.append(_NAME_CHECK)
        steps.append(f"Commit, push the branch, and open one pull request into {branch}.{provenance}")
        lines = opening + [f"Spec: .kiro/specs/{spec}/", f"Main branch: {branch}",
                           "Your job: build every task group of this story's spec that is not done yet, with a review after each group.", ""] + _numbered(steps)
    return "\n".join(lines + [""] + _rules(branch))


def find_card(plan, card_id):
    """Return (epic file or None, card) for the card with this id in a plan body, or None."""
    for group in plan.get("groups", []):
        epic = group.get("epic")
        for card in group.get("cards", []):
            if card.get("id") == card_id:
                return (epic["file"] if epic else None), card
    return None


def spec_folders(plan):
    """Every spec folder named by a card of the plan."""
    return {card["spec"] for group in plan.get("groups", []) for card in group.get("cards", []) if card.get("spec")}


# ---- The store ----

def default_new_name():
    return "epic-board-" + secrets.token_hex(4)


def utc_now():
    return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")


def _unreadable(path, why):
    return ChatError("chats_unreadable", 500, f"{path} cannot be read as the board's file of chats: {why}.")


def _check_records(path, data):
    if not isinstance(data, dict) or set(data) != {"chats"} or not isinstance(data["chats"], list):
        raise _unreadable(path, "it must be an object with a \"chats\" list")
    cards, names, keys = set(), set(), set()
    for record in data["chats"]:
        if not isinstance(record, dict):
            raise _unreadable(path, "a record has the wrong fields")
        rec_keys = set(record)
        if rec_keys != RECORD_KEYS and rec_keys != _OLD_RECORD_KEYS:
            raise _unreadable(path, "a record has the wrong fields")
        if "worktree_path" not in record:
            record["worktree_path"] = None
        if "worktree_folder_id" not in record:
            record["worktree_folder_id"] = None
        card_id, name, key, state, created = (record[k] for k in ("card_id", "name", "key", "state", "created"))
        if not (isinstance(card_id, str) and 0 < len(card_id) <= MAX_CARD_ID_CHARS):
            raise _unreadable(path, "a record has a bad card_id")
        if not (isinstance(name, str) and NAME_PATTERN.match(name)):
            raise _unreadable(path, "a record has a bad name")
        if not isinstance(created, str) or state not in STATES:
            raise _unreadable(path, "a record has a bad state or time")
        if state in ("started", "finished"):
            if not (isinstance(key, str) and NAME_PATTERN.match(key)):
                raise _unreadable(path, "a started or finished record has no key")
            if key in keys:
                raise _unreadable(path, "two records have the same key")
            keys.add(key)
        elif key is not None:
            raise _unreadable(path, "a reserved record has a key")
        wt_path = record["worktree_path"]
        wt_folder_id = record["worktree_folder_id"]
        if wt_path is not None:
            if not isinstance(wt_path, str) or not wt_path or len(wt_path) > 1000:
                raise _unreadable(path, "a record has an invalid worktree_path")
        if wt_folder_id is not None:
            if not (isinstance(wt_folder_id, str) and NAME_PATTERN.match(wt_folder_id)):
                raise _unreadable(path, "a record has an invalid worktree_folder_id")
        # A card holds one record, plus one finished record until its next chat is started.
        card_slot = (card_id, state == "finished")
        if card_slot in cards or name in names:
            raise _unreadable(path, "two records have the same card_id or name")
        cards.add(card_slot)
        names.add(name)
    return data["chats"]


class ChatStore:
    """The records of a chats file. One lock serializes every call; each call reads the file afresh."""

    def __init__(self, data_dir, filename=CHATS_FILE, new_name=default_new_name, clock=utc_now):
        self.data_dir, self.new_name, self.clock = data_dir, new_name, clock
        self.path = os.path.join(data_dir, filename)
        self._lock = threading.Lock()

    def _load(self):
        try:
            with open(self.path, encoding="utf-8") as f:
                data = json.load(f)
        except (FileNotFoundError, NotADirectoryError):
            return []  # no file is no records; a write then fails as `internal` if the folder cannot be made
        except (OSError, ValueError) as error:
            raise _unreadable(self.path, str(error)[:120])
        return _check_records(self.path, data)

    def _save(self, records):
        """Write the whole new content to a temporary file in the data folder, then replace the file."""
        tmp = None
        try:
            os.makedirs(self.data_dir, exist_ok=True)
            with tempfile.NamedTemporaryFile("w", dir=self.data_dir, prefix=".chats-", suffix=".tmp",
                                             delete=False, encoding="utf-8") as f:
                tmp = f.name
                json.dump({"chats": records}, f, indent=2, ensure_ascii=False)
                f.write("\n")
                f.flush()
                os.fsync(f.fileno())
            os.replace(tmp, self.path)
            tmp = None
        except OSError:
            raise ChatError("internal", 500, "The board's file of chats could not be written.")
        finally:
            if tmp is not None:
                try:
                    os.unlink(tmp)
                except OSError:
                    pass

    def started(self):
        """The started and finished records, in the order they were made, with every field."""
        with self._lock:
            return [dict(r) for r in self._load() if r["state"] in ("started", "finished")]

    def reserve(self, card_id):
        """The record for a card: the existing reserved one, or a new reserved one."""
        with self._lock:
            records = self._load()
            for record in records:
                if record["card_id"] == card_id and record["state"] != "finished":
                    if record["state"] == "started":
                        raise ChatError("chat_exists", 409, "This story already has a chat.")
                    return dict(record)
            names = {r["name"] for r in records}
            name = self.new_name()
            while name in names:
                name = self.new_name()
            record = {"card_id": card_id, "name": name, "key": None, "state": "reserved", "created": self.clock(),
                      "worktree_path": None, "worktree_folder_id": None}
            self._save(records + [record])
            return dict(record)

    def mark_started(self, name, key, worktree_folder_id=None):
        if not (isinstance(key, str) and NAME_PATTERN.match(key)):
            raise ChatError("invalid_request", 400, "The key is not valid.")
        with self._lock:
            records = self._load()
            for record in records:
                if record["name"] != name:
                    continue
                if record["state"] in ("started", "finished"):
                    if record["key"] == key:
                        return dict(record)
                    raise ChatError("chat_exists", 409, "This story already has a chat.")
                if any(other["key"] == key for other in records):
                    raise ChatError("chat_exists", 409, "That chat belongs to another story.")
                record["key"], record["state"] = key, "started"
                if worktree_folder_id is not None:
                    record["worktree_folder_id"] = worktree_folder_id
                records = [r for r in records if not (r["card_id"] == record["card_id"] and r["state"] == "finished")]
                self._save(records)
                return dict(record)
            raise ChatError("chat_not_found", 404, "There is no chat record with that name.")

    def mark_finished(self, name):
        """Set a started record to finished. Refused while its worktree_path is set."""
        with self._lock:
            records = self._load()
            for record in records:
                if record["name"] != name:
                    continue
                if record["state"] == "finished":
                    return dict(record)
                if record["state"] != "started":
                    raise ChatError("chat_not_started", 409, "This story has no started chat to finish.")
                if record["worktree_path"]:
                    raise ChatError("worktree_not_removed", 409, "The worktree has not been removed yet.")
                record["state"] = "finished"
                self._save(records)
                return dict(record)
            raise ChatError("chat_not_found", 404, "There is no chat record with that name.")

    def update_worktree_path(self, name, path):
        with self._lock:
            records = self._load()
            for record in records:
                if record["name"] == name:
                    record["worktree_path"] = path
                    self._save(records)
                    return
            raise ChatError("chat_not_found", 404, "There is no chat record with that name.")

    def get_record(self, name):
        with self._lock:
            records = self._load()
            for record in records:
                if record["name"] == name:
                    return dict(record)
            raise ChatError("chat_not_found", 404, "There is no chat record with that name.")

    def remove(self, name):
        with self._lock:
            records = self._load()
            kept = [r for r in records if r["name"] != name]
            if len(kept) == len(records):
                raise ChatError("chat_not_found", 404, "There is no chat record with that name.")
            self._save(kept)
