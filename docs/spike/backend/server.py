"""Spike backend: read docs/epics/ and .kiro/specs/ from a repository checkout.

Answers one question: can an app's sandboxed backend read the repo? Every
response says what it could and could not read.
"""
import json
import os
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

DEFAULT_REPO = "/home/ec2-user/dead-reckoning"
STORY = re.compile(r"^- (?:\[([^\]]+)\]\(([^)]*)\)|([^—\n]+?)) — ([a-z ]+)\.?(.*)$")


REF = "origin/main"


def git(repo, *args):
    return subprocess.run(["git", "-C", repo, *args], capture_output=True, text=True, timeout=30)


def read_file(repo, path):
    shown = git(repo, "show", f"{REF}:{path}")
    if shown.returncode != 0:
        raise OSError(shown.stderr.strip() or f"cannot read {path} at {REF}")
    return shown.stdout


def list_dir(repo, path):
    listed = git(repo, "ls-tree", "--name-only", f"{REF}:{path}")
    if listed.returncode != 0:
        raise OSError(listed.stderr.strip() or f"cannot list {path} at {REF}")
    return listed.stdout.split()


def task_progress(repo, link):
    match = re.search(r"\.kiro/specs/([^/]+)/?", link or "")
    if not match:
        return None
    try:
        text = read_file(repo, f".kiro/specs/{match.group(1)}/tasks.md")
    except OSError as error:
        return {"error": str(error)}
    done = len(re.findall(r"^\s*- \[x\]", text, re.M))
    total = len(re.findall(r"^\s*- \[[ x\-]\]", text, re.M))
    return {"spec": match.group(1), "done": done, "total": total}


def read_board(repo):
    result = {"repo": repo, "ref": REF, "epics": [], "errors": []}
    fetched = git(repo, "fetch", "--quiet", "origin", "main")
    result["fetch"] = "ok" if fetched.returncode == 0 else (fetched.stderr.strip()[:200] or "failed")
    try:
        names = sorted(list_dir(repo, "docs/epics"))
    except OSError as error:
        result["errors"].append(str(error))
        return result
    for name in names:
        if not name.endswith(".md") or name in ("README.md", "standalone.md"):
            continue
        try:
            text = read_file(repo, f"docs/epics/{name}")
        except OSError as error:
            result["errors"].append(f"cannot read {name}: {error}")
            continue
        title = re.search(r"^# (.+)$", text, re.M)
        status = re.search(r"^Status:\s*(.+)$", text, re.M)
        stories = []
        section = text.split("## Stories", 1)[1] if "## Stories" in text else ""
        for line in section.splitlines():
            match = STORY.match(line.strip())
            if not match:
                continue
            story_name = (match.group(1) or match.group(3) or "").strip()
            link = match.group(2) or ""
            stories.append({
                "name": story_name,
                "status": match.group(4).strip(),
                "summary": match.group(5).strip(),
                "link": link,
                "progress": task_progress(repo, link),
            })
        result["epics"].append({
            "file": name,
            "title": title.group(1) if title else name,
            "status": status.group(1).strip() if status else "",
            "stories": stories,
        })
    return result


class Handler(BaseHTTPRequestHandler):
    def _send(self, code, body):
        data = json.dumps(body).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        url = urlparse(self.path)
        if url.path.endswith("/health"):
            return self._send(200, {"ok": True})
        if url.path.endswith("/board"):
            repo = parse_qs(url.query).get("repo", [DEFAULT_REPO])[0]
            board = read_board(repo)
            board["whoami"] = {"uid": os.getuid(), "cwd": os.getcwd(), "path_seen": self.path}
            return self._send(200, board)
        return self._send(404, {"error": "not found", "path_seen": self.path})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("127.0.0.1", int(os.environ["PORT"])), Handler).serve_forever()
