"""Epic Board backend: answers "what is the plan on the main branch?"

Runs as a script, started by the host with PORT set. Routes match on the end of
the path, so the host's route prefix does not matter.
"""
import json
import os
import sys
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlparse

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from gitsource import SourceError, open_snapshot  # noqa: E402
from plan import build_plan  # noqa: E402

APP_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
ENV_NAME = "EPIC_BOARD_REPOSITORY"
STATUS = {"repository_not_configured": 409, "repository_not_a_checkout": 409,
          "ref_unreadable": 502, "read_failed": 502, "internal": 500}


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


def error_body(code, message, config_path=None):
    body = {"code": code, "message": message}
    if config_path:
        body["settings"] = [ENV_NAME, config_path]
    return {"error": body}


def plan_response(repository, error, config_path):
    """Return (http status, body). Never reads anything from the request."""
    if error:
        return STATUS[error["code"]], {"error": error}
    try:
        snapshot = open_snapshot(repository)
        groups, problems = build_plan(snapshot)
    except SourceError as failure:
        if failure.code == "not_a_checkout":
            message = f"{failure.message}. Check {ENV_NAME} or the repository value in {config_path}."
            return 409, error_body("repository_not_a_checkout", message, config_path)
        return STATUS[failure.code], error_body(failure.code, failure.message)
    except Exception:
        return 500, error_body("internal", "The plan could not be built.")
    fetch = {"ok": True} if not snapshot.fetch_error else {"ok": False, "reason": snapshot.fetch_error}
    return 200, {"repository": repository, "branch": snapshot.branch, "ref": snapshot.ref,
                 "commit": snapshot.commit, "fetch": fetch, "groups": groups, "problems": problems}


def make_handler(repository, error, config_path):
    class Handler(BaseHTTPRequestHandler):
        def _send(self, code, body):
            data = json.dumps(body).encode()
            self.send_response(code)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(data)))
            self.end_headers()
            self.wfile.write(data)

        def do_GET(self):
            path = urlparse(self.path).path
            if path.endswith("/health"):
                return self._send(200, {"ok": True})
            if path.endswith("/plan"):
                return self._send(*plan_response(repository, error, config_path))
            return self._send(404, {"error": {"code": "not_found", "message": "Not found."}})

        def log_message(self, *args):
            pass

    return Handler


def make_server(port, repository, error, config_path):
    return ThreadingHTTPServer(("127.0.0.1", port), make_handler(repository, error, config_path))


if __name__ == "__main__":
    repo, problem = load_repository()
    make_server(int(os.environ["PORT"]), repo, problem, os.path.join(APP_DIR, "config.json")).serve_forever()
