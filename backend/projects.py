"""Read the project list from the app config. Standard library only."""
import json
import os
import sys
from collections import namedtuple

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from chats import slugify  # noqa: E402
from setup import load_setup, is_git_checkout  # noqa: E402

Project = namedtuple("Project", ["id", "name", "repository", "folder", "folder_reason", "records_file"])

CHATS_FILE = "chats.json"
PROJECTS_MAX = 20
NAME_MAX_CHARS = 100
FOLDER_MAX_CHARS = 200
ENV_NAME = "EPIC_BOARD_REPOSITORY"
FOLDER_ENV_NAME = "EPIC_BOARD_FOLDER"


def _config_error(message, config_path):
    return {
        "code": "repository_not_configured",
        "settings": [ENV_NAME, config_path],
        "message": f"{message} Set {ENV_NAME}, or put {{\"repository\": \"<path>\"}} in {config_path}.",
    }


def _multi_error(config_path, message):
    return {"code": "repository_not_configured", "settings": [ENV_NAME, config_path], "message": message}


def check_folder(value, source):
    """Return (folder_id or None, reason or None). Callers handle the missing-key case before calling."""
    if not isinstance(value, str) or not value.strip():
        return None, f"{source} must be text and not empty."
    value = value.strip()
    if len(value) > FOLDER_MAX_CHARS:
        return None, f"{source} is longer than {FOLDER_MAX_CHARS} characters."
    return value, None


def _expand(path):
    return os.path.abspath(os.path.expanduser(path.strip()))


def _read_config(config_path):
    """Return (data, error_text). data is the parsed JSON or None; error_text is None on success."""
    try:
        with open(config_path, encoding="utf-8") as f:
            return json.load(f), None
    except (OSError, ValueError) as error:
        return None, str(error)


def load_projects(environ=None, app_dir=None, data_dir=None):
    """Return (projects, error, source, config_has_projects).
    projects is a list of Project; error is None or an error body.
    source is 'saved' | 'config' | 'legacy' | 'unconfigured'.
    config_has_projects is True when config.json has a valid non-empty 'projects' list.
    When error is set, projects is []. Never raises."""
    environ = os.environ if environ is None else environ
    if app_dir is None:
        app_dir = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    config_path = os.path.join(app_dir, "config.json")

    env_repo = environ.get(ENV_NAME, "")
    legacy_path = _expand(env_repo) if env_repo.strip() else None

    data, read_error = None, None
    if os.path.exists(config_path):
        data, read_error = _read_config(config_path)

    # Determine config_has_projects: True when config.json has a syntactically valid projects list.
    config_has_projects = False
    if isinstance(data, dict) and isinstance(data.get("projects"), list) and len(data["projects"]) > 0:
        # Check that it's a list of objects with name and repository.
        raw = data["projects"]
        if all(isinstance(e, dict) and isinstance(e.get("name"), str) and isinstance(e.get("repository"), str)
               for e in raw):
            config_has_projects = True

    # Saved_Config path: check setup.json first when data_dir is given.
    if data_dir is not None:
        entries, _load_err = load_setup(data_dir)
        if entries:
            # Build the legacy_path for records_file assignment.
            if legacy_path is None and isinstance(data, dict):
                top_repo = data.get("repository", "")
                if isinstance(top_repo, str) and top_repo.strip():
                    legacy_path = _expand(top_repo)
            projects, error = _load_from_saved(entries, data_dir, legacy_path)
            return projects, error, 'saved', config_has_projects

    if isinstance(data, dict) and "projects" in data:
        # Multi-project form. EPIC_BOARD_REPOSITORY and top-level `repository` give legacy only.
        if legacy_path is None:
            top_repo = data.get("repository", "")
            if isinstance(top_repo, str) and top_repo.strip():
                legacy_path = _expand(top_repo)
        projects, error = _load_multi(data["projects"], config_path, legacy_path)
        source = 'config' if not error else 'unconfigured'
        return projects, error, source, config_has_projects

    # Single-project form: behave exactly as load_repository + load_folder today.
    if env_repo.strip():
        repo = _expand(env_repo)
    elif read_error is not None:
        return [], _config_error(f"{config_path} cannot be read: {read_error}.", config_path), 'unconfigured', config_has_projects
    elif data is None:
        return [], _config_error("No repository is configured.", config_path), 'unconfigured', config_has_projects
    elif not isinstance(data, dict):
        return [], _config_error(
            f"{config_path} must be an object with a text \"repository\" value.", config_path), 'unconfigured', config_has_projects
    else:
        raw_repo = data.get("repository")
        if not isinstance(raw_repo, str) or not raw_repo.strip():
            return [], _config_error(
                f"{config_path} must be an object with a text \"repository\" value.", config_path), 'unconfigured', config_has_projects
        repo = _expand(raw_repo)

    # Folder: environment wins over file (same logic as load_folder).
    folder_env = environ.get(FOLDER_ENV_NAME, "")
    if folder_env:
        folder, folder_reason = check_folder(folder_env, FOLDER_ENV_NAME)
        if folder is None and folder_reason is None:
            folder, folder_reason = None, None
    elif data is None:
        folder, folder_reason = None, None
    elif not isinstance(data, dict):
        folder, folder_reason = None, f"{config_path} is not an object."
    elif "folder_id" in data:
        folder, folder_reason = check_folder(data["folder_id"], f"folder_id in {config_path}")
    else:
        folder, folder_reason = None, None

    name = os.path.basename(repo) or "Project"
    id_ = slugify(name)
    return [Project(id=id_, name=name, repository=repo, folder=folder,
                    folder_reason=folder_reason, records_file=CHATS_FILE)], None, 'legacy', config_has_projects


def _load_from_saved(entries, data_dir, legacy_path):
    """Build the Project list from validated setup.json entries.
    Invalid entries are skipped with a logged message rather than causing failure."""
    import sys
    ids_so_far = []
    raw_projects = []
    for i, entry in enumerate(entries):
        repo = _expand(entry.get('repository', ''))
        name = entry.get('name', '').strip() or os.path.basename(repo) or 'Project'
        folder = entry.get('folder_id') or None
        # Skip invalid entries at startup — do not crash.
        if not is_git_checkout(repo):
            print(f"setup.json entry {i + 1}: {repo!r} is not a git checkout; skipping.", file=sys.stderr)
            continue
        id_ = slugify(name, taken=ids_so_far)
        ids_so_far.append(id_)
        raw_projects.append(Project(id=id_, name=name, repository=repo, folder=folder,
                                    folder_reason=None, records_file=None))
    if not raw_projects:
        return [], None
    # Assign records files.
    result = []
    for project in raw_projects:
        if legacy_path is not None and project.repository == legacy_path:
            records_file = CHATS_FILE
        else:
            records_file = f"chats-{project.id}.json"
        result.append(project._replace(records_file=records_file))
    return result, None


def _load_multi(projects_value, config_path, legacy_path):
    """Validate and build the Project list from the `projects` key."""
    if not isinstance(projects_value, list) or len(projects_value) == 0:
        return [], _multi_error(config_path, f"{config_path}: projects must be a list with at least one entry.")
    if len(projects_value) > PROJECTS_MAX:
        return [], _multi_error(
            config_path, f"{config_path}: projects has more than {PROJECTS_MAX} entries.")

    ids_so_far = []
    seen_repos = set()
    raw_projects = []

    for i, entry in enumerate(projects_value):
        label = f"{config_path}: projects[{i}]"
        if not isinstance(entry, dict):
            return [], _multi_error(config_path, f"{label} must be an object.")

        name = entry.get("name")
        if not isinstance(name, str) or not name.strip():
            return [], _multi_error(config_path, f"{label}.name must be text and not only whitespace.")
        name = name.strip()
        if len(name) > NAME_MAX_CHARS:
            return [], _multi_error(
                config_path, f"{label}.name must be at most {NAME_MAX_CHARS} characters.")

        repo_raw = entry.get("repository")
        if not isinstance(repo_raw, str) or not repo_raw.strip():
            return [], _multi_error(
                config_path, f"{label}.repository must be text and not only whitespace.")
        repo = _expand(repo_raw)

        if repo in seen_repos:
            return [], _multi_error(config_path, f"{label}.repository is the same as an earlier entry.")
        seen_repos.add(repo)

        # A bad folder_id affects only this project (not the others).
        if "folder_id" in entry:
            folder, folder_reason = check_folder(entry["folder_id"], f"{label}.folder_id")
        else:
            folder, folder_reason = None, None

        id_ = slugify(name, taken=ids_so_far)
        ids_so_far.append(id_)
        raw_projects.append(Project(id=id_, name=name, repository=repo, folder=folder,
                                    folder_reason=folder_reason, records_file=None))

    # Assign records files: legacy repo keeps chats.json, others get chats-<id>.json.
    result = []
    for project in raw_projects:
        if legacy_path is not None and project.repository == legacy_path:
            records_file = CHATS_FILE
        else:
            records_file = f"chats-{project.id}.json"
        result.append(project._replace(records_file=records_file))

    return result, None
