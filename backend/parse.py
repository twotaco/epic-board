"""Parse tasks.md and epic pages. No git, no HTTP."""
import re
from collections import namedtuple

TaskCounts = namedtuple("TaskCounts", "done under_way total")
Epic = namedtuple("Epic", "name stories")
Story = namedtuple("Story", "name link status description")

TASK = re.compile(r"^\s*[-*+]\s+\[([ xX-])\](\*)?")
STORY = re.compile(r"^[-*] (?:\[([^\]]*)\]\(([^)]*)\)|(.+?)) —(?: (.*))?$")
SPEC_LINK = re.compile(r"\.kiro/specs/([^/)#?\s]+)")
STATUSES = ("planned", "in progress", "done")


def parse_tasks(text):
    done = under_way = total = 0
    for line in text.splitlines():
        match = TASK.match(line)
        if not match or match.group(2):
            continue
        total += 1
        if match.group(1) in "xX":
            done += 1
        elif match.group(1) == "-":
            under_way += 1
    return TaskCounts(done, under_way, total)


def parse_epic(text, file):
    match = re.search(r"^# (.+)$", text, re.M)
    return Epic(match.group(1).strip() if match else file, parse_stories(text, False))


def split_status(text):
    """Return (status or None, description). The status is the text before the first full stop."""
    head, _, rest = text.partition(".")
    head = head.strip().lower()
    return (head if head in STATUSES else None), rest.strip()


def parse_stories(text, whole_file):
    lines = text.splitlines()
    start = next((i + 1 for i, line in enumerate(lines) if line.rstrip() == "## Stories"), None)
    if start is not None:
        end = next((i for i in range(start, len(lines)) if re.match(r"#{1,2} ", lines[i])), len(lines))
        lines, first_column_only = lines[start:end], False
    elif whole_file:
        first_column_only = True
    else:
        return []
    stories = []
    for line in lines:
        # Section mode accepts indented items; whole-file mode takes only first-column ones.
        match = STORY.match(line if first_column_only else line.strip())
        if not match:
            continue
        name = (match.group(1) if match.group(1) is not None else match.group(3)).strip()
        link = match.group(2)
        status, description = split_status(match.group(4) or "")
        stories.append(Story(name, link, status, description))
    return stories


def spec_folder(link):
    match = SPEC_LINK.search(link or "")
    return match.group(1) if match else None
