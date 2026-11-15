"""Epic Board backend: answers "what is the plan on the main branch?"

Runs as a script, started by the host with PORT set. Routes match on the end of
the path, so the host's route prefix does not matter.
"""
import json
import os
import re
import sys
import threading
import time
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse, parse_qs

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from chats import NAME_PATTERN, ChatError, ChatStore, MAX_CARD_ID_CHARS, build_brief, find_card, spec_folders  # noqa: E402
from gitsource import open_snapshot, read_snapshot  # noqa: E402
from held import Holder  # noqa: E402
from plan import build_plan  # noqa: E402
from projects import check_folder, load_projects, ENV_NAME, FOLDER_ENV_NAME, FOLDER_MAX_CHARS  # noqa: E402
from proxyauth import verify  # noqa: E402
from setup import validate_setup_entry, save_setup  # noqa: E402

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
STATUS = {"repository_not_configured": 409, "repository_not_a_checkout": 409,
          "ref_unreadable": 502, "read_failed": 502, "internal": 500,
          "project_not_found": 404, "invalid_request": 400}


def config_error(code, message, config_path):
    return {"code": code, "settings": [ENV_NAME, config_path],
            "message": f"{message} Set {ENV_NAME}, or put {{\"repository\": \"<path>\"}} in {config_path}."}


def load_repository(environ=None, app_dir=None):
    """Return (path, None) or (None, error). The first source present wins."""
    environ = os.environ if environ is None else environ
    config_path = os.path.join(app_dir or APP_DIR, "config.json")
    value = environ.get(ENV_NAME, "")
    if value:
        pass
    elif os.path.exists(config_path):
        try:
            with open(config_path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError) as error:
            return None, config_error("repository_not_configured", f"{config_path} cannot be read: {error}.", config_path)
        value = data.get("repository") if isinstance(data, dict) else None
        if not isinstance(value, str) or not value.strip():
            return None, config_error(
                "repository_not_configured", f"{config_path} must be an object with a text \"repository\" value.", config_path)
    else:
        return None, config_error("repository_not_configured", "No repository is configured.", config_path)
    return os.path.abspath(os.path.expanduser(value.strip())), None


def load_folder(environ=None, app_dir=None):
    """Return (folder_id or None, reason or None): the Crew folder chats are opened in.

    The first source present wins, as for the repository: EPIC_BOARD_FOLDER if set and not empty,
    else `folder_id` in config.json. A bad value is "not set" with a reason and does not fall through.
    Never raises, and never affects load_repository.
    """
    environ = os.environ if environ is None else environ
    config_path = os.path.join(app_dir or APP_DIR, "config.json")
    value = environ.get(FOLDER_ENV_NAME, "")
    source = FOLDER_ENV_NAME
    if not value:
        source = f"folder_id in {config_path}"
        if not os.path.exists(config_path):
            return None, None
        try:
            with open(config_path, encoding="utf-8") as f:
                data = json.load(f)
        except (OSError, ValueError):
            return None, f"{config_path} cannot be read."
        if not isinstance(data, dict):
            return None, f"{config_path} is not an object."
        if "folder_id" not in data:
            return None, None
        value = data["folder_id"]
    return check_folder(value, source)


def data_dir(environ=None):
    """<KIROCREW_HOME>/apps/<KIROCREW_APP_NAME>/data, with the host's defaults."""
    environ = os.environ if environ is None else environ
    home = environ.get("KIROCREW_HOME") or os.path.join("~", ".kiro", "crew")
    name = environ.get("KIROCREW_APP_NAME") or "epic-board"
    if name in (".", "..") or not all(c.isalnum() or c in "._-" for c in name):
        name = "epic-board"  # the name becomes a folder; never let it name a path
    return os.path.join(os.path.abspath(os.path.expanduser(home)), "apps", name, "data")


def error_body(code, message, config_path=None):
    body = {"code": code, "message": message}
    if config_path:
        body["settings"] = [ENV_NAME, config_path]
    return {"error": body}


def plan_response(holder, error, config_path):
    """Return (http status, body). Answers from the holder, never runs git, never reads the request."""
    if error:
        return STATUS[error["code"]], {"error": error}
    try:
        kind, value = holder.request()
        if kind == "pending":
            return 202, {"pending": True}
        if kind == "error":
            code, message = value["code"], value["message"]
            if code == "repository_not_a_checkout":
                message = f"{message.rstrip('.')}. Check {ENV_NAME} or the repository value in {config_path}."
                return STATUS[code], error_body(code, message, config_path)
            return STATUS[code], error_body(code, message)
        return 200, value
    except Exception:
        return 500, error_body("internal", "The plan could not be built.")


MAX_BODY_BYTES = 4096
CHATS_ROUTE = re.compile(r"/chats(?:/([^/]+)(?:/(started))?)?$")
CHAT_STATUS = {"unauthorized": 401, "proxy_secret_missing": 503, "invalid_request": 400, "chat_not_found": 404,
               "not_found": 404, "card_not_found": 409, "card_done": 409, "chat_exists": 409, "folder_not_set": 409,
               "plan_not_ready": 409, "chats_unreadable": 500, "internal": 500,
               "project_not_found": 404, "repository_not_configured": 409}


def chat_refusal(code, message):
    return CHAT_STATUS[code], error_body(code, message)


def fields(body, expected):
    """The JSON object in `body` when it has exactly the fields in `expected`, else a 400 refusal."""
    try:
        data = json.loads(body.decode("utf-8"))
    except (ValueError, UnicodeDecodeError):
        data = None
    if not isinstance(data, dict) or set(data) != set(expected):
        raise ChatError("invalid_request", 400, f"The body must be a JSON object with exactly: {', '.join(expected)}.")
    return data


def pick_project(projects, query):
    """Return (project, None) or (None, (status, body)).
    `query` is the parsed query string as a dict of lists (from parse_qs with keep_blank_values=True)."""
    values = query.get("project", [])
    if len(values) > 1:
        return None, chat_refusal("invalid_request", "The request has more than one project value.")
    if len(values) == 0:
        if not projects:
            return None, None  # caller handles empty list
        return projects[0], None
    value = values[0]
    if not value:
        return None, chat_refusal("project_not_found", "No project has that id.")
    for project in projects:
        if project.id == value:
            return project, None
    return None, chat_refusal("project_not_found", "No project has that id.")


class RuntimeState:
    """Thread-safe container for the running project list and metadata."""

    def __init__(self, running_projects, error, source, config_has_projects, config_path, data_dir, secret,
                 clock=None):
        self._lock = threading.Lock()
        self._running = running_projects  # list of RunningProject, or [] on error
        self.error = error
        self.source = source  # 'saved' | 'config' | 'legacy' | 'unconfigured'
        self.config_has_projects = config_has_projects
        self.config_path = config_path
        self.data_dir = data_dir
        self.secret = secret
        self.clock = clock if clock is not None else time.time

    def snapshot(self):
        """Return a copy of the running list."""
        with self._lock:
            return list(self._running)

    def rebuild(self, new_running, new_source):
        """Swap the running list atomically; return the old list."""
        with self._lock:
            old = self._running
            self._running = new_running
            self.source = new_source
            return old


class RunningProject:
    """A project's running parts: its plan holder (or None) and its chat service."""

    def __init__(self, settings, holder, chats):
        self.settings = settings
        self.holder = holder
        self.chats = chats

    @property
    def id(self):
        return self.settings.id

    @property
    def name(self):
        return self.settings.name


class ChatService:
    """The `/chats` routes for one project. Never calls Crew, never runs git.

    `holder` is the plan holder, or None when the repository setting is wrong. `secret` is
    KIROCREW_PROXY_SECRET. Every request must carry the gateway's signature.
    """

    def __init__(self, store, folder, folder_reason, secret, holder, clock=time.time):
        self.store, self.folder, self.folder_reason = store, folder, folder_reason
        self.secret, self.holder, self.clock = secret, holder, clock

    def handle(self, method, path, header, body):
        """Return (http status, body). `path` is the request target as received, query included.
        Checks the signature, then delegates to handle_verified."""
        if not self.secret:
            return chat_refusal("proxy_secret_missing", "The app has no proxy secret, so chats cannot be saved.")
        if not verify(header, method=method, target=path, body=body, secret=self.secret, now=self.clock()):
            return chat_refusal("unauthorized", "The request is not signed by the gateway.")
        return self.handle_verified(method, path, body)

    def handle_verified(self, method, path, body):
        """The body of handle() after signature verification."""
        try:
            if len(body) > MAX_BODY_BYTES:
                raise ChatError("invalid_request", 400, "The body is too large.")
            match = CHATS_ROUTE.search(urlparse(path).path)
            if not match:
                return chat_refusal("not_found", "Not found.")
            name, suffix = match.group(1), match.group(2)
            if name is not None and not NAME_PATTERN.match(name):
                raise ChatError("invalid_request", 400, "The name is not valid.")
            if name is None and method == "GET":
                return 200, self.list_chats()
            if name is None and method == "POST":
                return 200, self.reserve(fields(body, ["card_id"])["card_id"])
            if name is not None and suffix == "started" and method == "POST":
                key = fields(body, ["key"])["key"]
                record = self.store.mark_started(name, key)
                return 200, {"card_id": record["card_id"], "name": record["name"], "key": record["key"]}
            if name is not None and suffix is None and method == "DELETE":
                self.store.remove(name)
                return 200, {"removed": True}
            return chat_refusal("not_found", "Not found.")
        except ChatError as refusal:
            return chat_refusal(refusal.code, refusal.message)
        except Exception:
            traceback.print_exc(file=sys.stderr)
            return chat_refusal("internal", "The request could not be handled.")

    def list_chats(self):
        return {"folder_id": self.folder, "folder_reason": self.folder_reason, "chats": self.store.started()}

    def reserve(self, card_id):
        if not isinstance(card_id, str) or not 0 < len(card_id) <= MAX_CARD_ID_CHARS:
            raise ChatError("invalid_request", 400, "The card_id must be text of 1 to 400 characters.")
        if not self.folder:
            why = f" {self.folder_reason}" if self.folder_reason else ""
            raise ChatError("folder_not_set", 409, f"No Crew folder is set for this project.{why}")
        self.store.started()  # raises chats_unreadable before anything else is looked at
        kind, plan = self.holder.request() if self.holder is not None else ("pending", None)
        if kind != "plan":
            raise ChatError("plan_not_ready", 409, "The plan has not been read yet.")
        found = find_card(plan, card_id)
        if found is None:
            raise ChatError("card_not_found", 409, "That story is not in the plan on the main branch.")
        epic_file, card = found
        if card.get("status") == "done":
            raise ChatError("card_done", 409, "That story is done.")
        record = self.store.reserve(card_id)
        return {"card_id": card_id, "name": record["name"], "folder_id": self.folder,
                "brief": build_brief(card, epic_file, plan["branch"], spec_folders(plan))}


class ChatRouter:
    """Checks the signature, resolves the project and delegates to that project's ChatService."""

    def __init__(self, running_projects, secret, clock=time.time):
        self.running_projects = running_projects  # list of RunningProject
        self.secret = secret
        self.clock = clock

    def handle(self, method, path, header, body):
        """Return (http status, body). Signature is checked before the project is resolved."""
        if not self.secret:
            return chat_refusal("proxy_secret_missing", "The app has no proxy secret, so chats cannot be saved.")
        if not verify(header, method=method, target=path, body=body, secret=self.secret, now=self.clock()):
            return chat_refusal("unauthorized", "The request is not signed by the gateway.")
        query = parse_qs(urlparse(path).query, keep_blank_values=True)
        project, refusal = pick_project([rp.settings for rp in self.running_projects], query)
        if refusal is not None:
            return refusal
        if project is None:
            # Empty list: behave like the config error case
            return chat_refusal("repository_not_configured", "No project is configured.")
        rp = next(rp for rp in self.running_projects if rp.id == project.id)
        return rp.chats.handle_verified(method, path, body)


def make_handler(state, router=None):
    """Build the HTTP handler class.

    `state` is a RuntimeState; `router` is a ChatRouter (or None when no projects are running).
    """
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def _not_found(self):
            return self._send(404, {"error": {"code": "not_found", "message": "Not found."}})

        def _read_body(self):
            """Read request body up to MAX_BODY_BYTES. Returns (body, error_response) where
            error_response is None on success or a (status, body) pair on failure."""
            raw = self.headers.get("Content-Length")
            if raw is None:
                raw = ""
            length = 0 if raw == "" else (int(raw) if raw.isascii() and raw.isdigit() and len(raw) <= 9 else -1)
            if length < 0 or length > MAX_BODY_BYTES:
                self.close_connection = True
                return None, chat_refusal("invalid_request", "The body is missing, not a number or too large.")
            return self.rfile.read(length) if length else b"", None

        def _chats(self, method):
            if router is None or not CHATS_ROUTE.search(urlparse(self.path).path):
                return self._not_found()
            raw = self.headers.get("Content-Length")
            if raw is None and method == "POST":
                raw = ""
            length = 0 if raw is None else (int(raw) if raw.isascii() and raw.isdigit() and len(raw) <= 9 else -1)
            if length < 0 or length > MAX_BODY_BYTES:
                self.close_connection = True
                return self._send(*chat_refusal("invalid_request", "The body is missing, not a number or too large."))
            body = self.rfile.read(length) if length else b""
            return self._send(*router.handle(method, self.path, self.headers.get("X-KiroCrew-Proxy", ""), body))

        def do_GET(self):
            running = state.snapshot()
            path = urlparse(self.path).path
            if path.endswith("/health"):
                return self._send(200, {"ok": True})
            if path.endswith("/setup"):
                return self._send(200, {
                    "source": state.source,
                    "config_has_projects": state.config_has_projects,
                    "projects": [{"id": rp.id, "name": rp.name,
                                  "folder_id": rp.settings.folder if rp.settings.folder else None}
                                 for rp in running],
                })
            if path.endswith("/projects"):
                return self._send(200, [{"id": rp.id, "name": rp.name} for rp in running])
            if path.endswith("/plan"):
                query = parse_qs(urlparse(self.path).query, keep_blank_values=True)
                if state.error or not running:
                    return self._send(*plan_response(None, state.error, state.config_path))
                project, refusal = pick_project([rp.settings for rp in running], query)
                if refusal is not None:
                    return self._send(*refusal)
                if project is None:
                    return self._send(*plan_response(None, state.error, state.config_path))
                rp = next(rp for rp in running if rp.id == project.id)
                return self._send(*plan_response(rp.holder, None, state.config_path))
            return self._chats("GET")

        def do_POST(self):
            path = urlparse(self.path).path
            if path.endswith("/projects"):
                return self._not_found()
            if path.endswith("/setup"):
                return self._handle_post_setup()
            return self._chats("POST")

        def _handle_post_setup(self):
            body, err = self._read_body()
            if err is not None:
                return self._send(*err)
            # Verify gateway signature.
            if not state.secret:
                return self._send(*chat_refusal("proxy_secret_missing", "The app has no proxy secret."))
            if not verify(self.headers.get("X-KiroCrew-Proxy", ""), method="POST",
                          target=self.path, body=body, secret=state.secret, now=state.clock()):
                return self._send(*chat_refusal("unauthorized", "The request is not signed by the gateway."))
            # Parse body.
            try:
                data = json.loads(body.decode("utf-8"))
            except (ValueError, UnicodeDecodeError):
                return self._send(400, error_body("invalid_request", "The body must be a JSON object."))
            if not isinstance(data, dict) or set(data) != {"projects"}:
                return self._send(400, error_body("invalid_request",
                    "The body must be a JSON object with exactly: projects."))
            projects_value = data["projects"]
            if not isinstance(projects_value, list) or len(projects_value) < 1 or len(projects_value) > 20:
                return self._send(400, error_body("invalid_request",
                    "projects must be a list of 1 to 20 entries."))
            for item in projects_value:
                if not isinstance(item, dict) or set(item) != {"folder_id", "name", "repository"}:
                    return self._send(400, error_body("invalid_request",
                        "Each entry must be an object with exactly: folder_id, name, repository."))
            # Validate entries.
            for i, entry in enumerate(projects_value):
                msg = validate_setup_entry(entry, i)
                if msg is not None:
                    return self._send(400, error_body("invalid_request", msg))
            # Save.
            try:
                save_setup(state.data_dir, projects_value)
            except OSError as e:
                return self._send(500, error_body("internal", f"Could not save setup: {e}"))
            # Rebuild project list.
            new_projects, _, new_source, new_config_has = load_projects(data_dir=state.data_dir)
            old_running = state.snapshot()
            old_by_id = {rp.id: rp for rp in old_running}
            new_running = []
            dd = state.data_dir
            for project in new_projects:
                if project.id in old_by_id:
                    new_running.append(old_by_id[project.id])
                else:
                    held = Holder(project.repository, None, None, None)
                    store = ChatStore(dd, filename=project.records_file)
                    service = ChatService(store, project.folder, project.folder_reason, state.secret, held)
                    rp = RunningProject(project, held, service)
                    new_running.append(rp)
            old_list = state.rebuild(new_running, new_source)
            state.config_has_projects = new_config_has
            new_ids = {rp.id for rp in new_running}
            for rp in old_list:
                if rp.id not in new_ids:
                    if rp.holder is not None and hasattr(rp.holder, 'stop'):
                        rp.holder.stop()
            # Start holders for new projects.
            new_ids_set = {rp.id for rp in old_running}
            for rp in new_running:
                if rp.id not in new_ids_set and rp.holder is not None:
                    try:
                        rp.holder.start()
                    except Exception:
                        pass
            return self._send(200, {"projects": [{"id": rp.id, "name": rp.name} for rp in new_running],
                                    "source": new_source})

        def do_DELETE(self):
            return self._chats("DELETE")

        def log_message(self, *args):
            pass

    return Handler


def make_server(port, state, router=None):
    """Bind the port. Starts no thread and runs no git."""
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(state, router))


if __name__ == "__main__":
    config_path = os.path.join(APP_DIR, "config.json")
    secret = os.environ.get("KIROCREW_PROXY_SECRET", "")
    dd = data_dir()
    projects, problem, source, config_has_projects = load_projects(data_dir=dd)
    running = []
    for project in projects:
        held = Holder(project.repository, read_snapshot, open_snapshot, build_plan)
        store = ChatStore(dd, filename=project.records_file)
        service = ChatService(store, project.folder, project.folder_reason, secret, held)
        running.append(RunningProject(project, held, service))
    state = RuntimeState(running, problem, source, config_has_projects, config_path, dd, secret)
    router = ChatRouter(running, secret) if running else None
    server = make_server(int(os.environ["PORT"]), state, router)
    for rp in running:
        rp.holder.start()
    server.serve_forever()
