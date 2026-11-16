"""Build the plan from a source. No git, no HTTP.

A source has `list_files(*prefixes)` (repo-relative file paths) and
`read_file(path)` (text; raises on failure).
"""
import posixpath

from parse import parse_epic, parse_stories, parse_tasks, spec_folder

SPECS = ".kiro/specs"
EPICS = "docs/epics"
AGENTS_FILE = "AGENTS.md"
INSTRUCTIONS_THRESHOLD = 3000


def spec_status(counts):
    if counts.total > 0 and counts.done == counts.total:
        return "done"
    if counts.done + counts.under_way > 0:
        return "in progress"
    return "planned"


def card(name, status, spec, tasks, epic, description):
    return {"name": name, "status": status, "spec": spec, "tasks": tasks, "epic": epic,
            "description": description}


def read_specs(source, files, problems):
    """Return {folder: (status, tasks or None)} for every spec folder."""
    folders = sorted({p.split("/")[2] for p in files if p.startswith(SPECS + "/") and p.count("/") >= 3})
    specs = {}
    for folder in folders:
        path = f"{SPECS}/{folder}/tasks.md"
        if path not in files:
            specs[folder] = ("planned", {"done": 0, "total": 0})
            continue
        try:
            counts = parse_tasks(source.read_file(path))
        except Exception as error:
            problems.append({"file": path, "reason": str(error)})
            specs[folder] = ("planned", None)
            continue
        specs[folder] = (spec_status(counts), {"done": counts.done, "total": counts.total})
    return specs


def story_card(story, specs, epic_name):
    folder = spec_folder(story.link)
    if folder in specs:
        status, tasks = specs[folder]
        if story.status == "done":
            status = "done"
        return folder, card(story.name, status, folder, tasks, epic_name, story.description)
    return None, card(story.name, story.status or "planned", None, None, epic_name, story.description)


def read_text(source, path, problems):
    try:
        return source.read_file(path)
    except Exception as error:
        problems.append({"file": path, "reason": str(error)})
        return None


def add_ids(groups):
    """Give every card its `id`: the epic file, a `#` and the card's name, or `#` and the name
    for the "No epic" group. A story's name and epic stay put when its spec lands, so its id does too."""
    for group in groups:
        prefix = group["epic"]["file"] if group["epic"] else ""
        for item in group["cards"]:
            item["id"] = f"{prefix}#{item['name']}"


def build_plan(source):
    """Return (groups, problems)."""
    problems = []
    files = set(source.list_files(SPECS, EPICS))
    specs = read_specs(source, files, problems)

    epic_files = sorted(
        posixpath.basename(p) for p in files
        if posixpath.dirname(p) == EPICS and p.endswith(".md")
        and posixpath.basename(p) not in ("README.md", "standalone.md"))
    groups, claimed = [], set()
    for file in epic_files:
        text = read_text(source, f"{EPICS}/{file}", problems)
        if text is None:
            continue
        epic = parse_epic(text, file)
        cards = []
        for story in epic.stories:
            folder, built = story_card(story, specs, epic.name)
            if folder:
                claimed.add(folder)
            cards.append(built)
        groups.append({"epic": {"name": epic.name, "file": file}, "cards": cards})

    loose, used = [], set(claimed)
    standalone = f"{EPICS}/standalone.md"
    text = read_text(source, standalone, problems) if standalone in files else None
    for story in parse_stories(text, True) if text is not None else []:
        folder = spec_folder(story.link)
        if folder in specs:
            if folder in used:
                continue
            used.add(folder)
        loose.append(story_card(story, specs, None)[1])
    for folder in specs:
        if folder not in used:
            status, tasks = specs[folder]
            loose.append(card(folder, status, folder, tasks, None, ""))
    if loose:
        loose.sort(key=lambda c: c["name"].casefold())
        groups.append({"epic": None, "cards": loose})
    add_ids(groups)
    return groups, problems


def read_instructions(source):
    try:
        return source.read_file(AGENTS_FILE)
    except Exception:
        return None


def extract_headings(text):
    headings = []
    for line in text.splitlines():
        stripped = line.lstrip()
        if stripped and stripped[0] == '#':
            rest = stripped.lstrip('#')
            if rest and rest[0] == ' ':
                headings.append(stripped)
    return headings
