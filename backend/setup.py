"""Validation and file I/O for setup.json (the Saved_Config). Standard library only."""
import json
import os
import tempfile

SETUP_FILE = 'setup.json'
FOLDER_ID_MAX = 200
NAME_MAX = 100


def is_git_checkout(path):
    """Return True when path is an existing directory with a .git entry (file or directory)."""
    if not os.path.isdir(path):
        return False
    return os.path.exists(os.path.join(path, '.git'))


def validate_setup_entry(entry, i):
    """Return None on success or a human-readable error string."""
    if not isinstance(entry, dict):
        return f"Entry {i + 1} must be an object."
    folder_id = entry.get('folder_id')
    if not isinstance(folder_id, str) or not folder_id.strip():
        return f"Entry {i + 1}: folder_id must be a non-empty string."
    if len(folder_id) > FOLDER_ID_MAX:
        return f"Entry {i + 1}: folder_id must be at most {FOLDER_ID_MAX} characters."
    name = entry.get('name')
    if not isinstance(name, str) or not name.strip():
        return f"Entry {i + 1}: name must be a non-empty string and not only whitespace."
    if len(name) > NAME_MAX:
        return f"Entry {i + 1}: name must be at most {NAME_MAX} characters."
    repository = entry.get('repository')
    if not isinstance(repository, str):
        return f"Entry {i + 1}: repository must be a string."
    expanded = os.path.abspath(os.path.expanduser(repository.strip()))
    if not is_git_checkout(expanded):
        return f"Entry {i + 1}: repository is not an existing git checkout."
    if 'worktree' in entry and not isinstance(entry['worktree'], bool):
        return f"Entry {i + 1}: worktree must be a boolean."
    return None


def load_setup(data_dir):
    """Return (entries, error_text).
    entries is [] with error_text=None when the file is missing;
    entries is a list of {folder_id, name, repository} dicts with error_text=None on success;
    entries is [] with error_text set on any parse or I/O failure. Never raises."""
    path = os.path.join(data_dir, SETUP_FILE)
    if not os.path.exists(path):
        return [], None
    try:
        with open(path, encoding='utf-8') as f:
            data = json.load(f)
    except (OSError, ValueError) as error:
        return [], f"Could not read {SETUP_FILE}: {error}"
    if not isinstance(data, dict):
        return [], f"{SETUP_FILE} must be a JSON object."
    projects = data.get('projects')
    if not isinstance(projects, list):
        return [], f"{SETUP_FILE}: projects must be a list."
    entries = []
    for item in projects:
        if not isinstance(item, dict):
            return [], f"{SETUP_FILE}: each project must be an object."
        folder_id = item.get('folder_id')
        name = item.get('name')
        repository = item.get('repository')
        if not isinstance(folder_id, str) or not isinstance(name, str) or not isinstance(repository, str):
            return [], f"{SETUP_FILE}: each project must have folder_id, name and repository as strings."
        worktree = item.get('worktree', True)
        entries.append({'folder_id': folder_id, 'name': name, 'repository': repository, 'worktree': worktree})
    return entries, None


def save_setup(data_dir, entries):
    """Write setup.json atomically to data_dir. Raises OSError on failure."""
    os.makedirs(data_dir, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=data_dir, suffix='.tmp')
    try:
        with os.fdopen(fd, 'w', encoding='utf-8') as f:
            json.dump({'projects': entries}, f)
        os.replace(tmp, os.path.join(data_dir, SETUP_FILE))
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
