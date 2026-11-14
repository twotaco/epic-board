import json
import os
import re
import shutil
import tempfile
import unittest
from unittest import mock

import chats
from chats import ChatError, ChatStore, build_brief, find_card, slugify, spec_folders

NO_SPEC = {"name": "Filter by epic", "status": "planned", "spec": None, "tasks": None, "epic": "Epic Board",
           "description": "A dropdown at the top.", "id": "epic-board.md#Filter by epic"}
WITH_SPEC = {"name": "Start a story", "status": "in progress", "spec": "start-a-story",
             "tasks": {"done": 1, "total": 9}, "epic": "Epic Board", "description": "Click a card to start.",
             "id": "epic-board.md#Start a story"}


def lines_of(text):
    return text.split("\n")


class BriefTests(unittest.TestCase):
    def assert_rules(self, text, branch="main"):
        self.assertIn(f"- Never merge a pull request, never push to {branch}, never turn on auto-merge.", text)
        self.assertIn("- Open exactly one pull request. When it is open, write its address in this chat and stop.", text)
        self.assertIn("- If you are blocked or unsure, ask in this chat. Do not guess.", text)

    def test_no_spec_brief(self):
        text = build_brief(NO_SPEC, "epic-board.md", "main")
        self.assertIn('Story: "Filter by epic"', text)
        self.assertIn("Epic page: docs/epics/epic-board.md", text)
        self.assertIn("Main branch: main", text)
        self.assertIn("Your job: write this story's spec. It has none yet.", text)
        self.assertIn("branch named story/filter-by-epic from origin/main", text)
        self.assertIn("requirements.md, design.md and tasks.md in .kiro/specs/filter-by-epic/", text)
        self.assertIn("Change the story's line in the epic page to link to .kiro/specs/filter-by-epic/", text)
        self.assertIn("open one pull request into main", text)
        self.assertIn("If the project names branches another way, follow the project.", text)
        self.assert_rules(text)
        self.assertNotIn("task group", text)

    def test_no_spec_brief_without_an_epic_leaves_out_the_epic_step(self):
        text = build_brief(NO_SPEC, None, "main")
        self.assertIn("Epic page: none, this story has no epic", text)
        self.assertNotIn("docs/epics", text)
        self.assertNotIn("epic page, change", text)
        self.assertNotIn("Change the story's line", text)
        self.assertNotIn("entry in the epic page", text)
        numbers = [l.split(".")[0] for l in lines_of(text) if re.match(r"^\d+\. ", l)]
        self.assertEqual(numbers, [str(i) for i in range(1, len(numbers) + 1)])

    def test_with_spec_brief(self):
        text = build_brief(WITH_SPEC, "epic-board.md", "main")
        self.assertIn('Story: "Start a story"', text)
        self.assertIn("Spec: .kiro/specs/start-a-story/", text)
        self.assertIn("Your job: build the next task group of this story's spec.", text)
        self.assertIn("first top-level task group that has a task not ticked yet. Build only that group.", text)
        self.assertIn("If every task is ticked, change nothing and say so in this chat.", text)
        self.assertIn("If the spec has no tasks, write tasks.md as the only change of your pull request and build nothing.", text)
        self.assertIn("story/start-a-story-g<N> from origin/main, where <N> is the number of that group", text)
        self.assertIn("Tick each task you finish in tasks.md, in the same branch.", text)
        self.assertIn("Run the checks the project names", text)
        self.assertIn("open one pull request into main", text)
        self.assert_rules(text)
        self.assertNotIn("write this story's spec", text)

    def test_with_spec_brief_with_no_epic(self):
        text = build_brief(WITH_SPEC, None, "trunk")
        self.assertIn("Epic page: none, this story has no epic", text)
        self.assertIn("from origin/trunk", text)
        self.assert_rules(text, "trunk")

    def test_the_two_variants_are_chosen_by_the_spec_alone(self):
        for spec, marker in ((None, "write this story's spec"), ("x", "build the next task group")):
            card = dict(NO_SPEC, spec=spec, status="in progress", tasks={"done": 0, "total": 3})
            self.assertIn(marker, build_brief(card, "e.md", "main"))

    def test_description_and_task_text_never_appear(self):
        card = dict(WITH_SPEC, description="SECRET-DESCRIPTION-TEXT", tasks={"done": 1, "total": 2})
        text = build_brief(card, "e.md", "main")
        self.assertNotIn("SECRET-DESCRIPTION-TEXT", text)
        self.assertNotIn("9", text.replace("g<N>", ""))  # no task counts either

    def test_same_inputs_same_text_and_different_inputs_differ(self):
        self.assertEqual(build_brief(NO_SPEC, "e.md", "main"), build_brief(dict(NO_SPEC), "e.md", "main"))
        self.assertNotEqual(build_brief(NO_SPEC, "e.md", "main"), build_brief(NO_SPEC, "e.md", "trunk"))
        self.assertNotEqual(build_brief(NO_SPEC, "e.md", "main"), build_brief(NO_SPEC, "f.md", "main"))

    def test_story_name_with_quotes_line_breaks_and_non_ascii(self):
        for name in ['He said "stop"', "two\nlines\r\nand a tab\t", "Début ✓ 日本語", "ends with \\", "line\u2028sep\u2029"]:
            text = build_brief(dict(NO_SPEC, name=name), "e.md", "main")
            story = [l for l in lines_of(text) if l.startswith("Story: ")]
            self.assertEqual(len(story), 1, repr(name))
            self.assertEqual(json.loads(story[0][len("Story: "):].replace("\\u2028", "\u2028").replace("\\u2029", "\u2029")), name)
            self.assertNotIn("\u2028", text)

    def test_a_long_story_name_is_cut_to_200_characters(self):
        text = build_brief(dict(NO_SPEC, name="x" * 500), "e.md", "main")
        story = [l for l in lines_of(text) if l.startswith("Story: ")][0]
        self.assertEqual(json.loads(story[len("Story: "):]), "x" * 200)

    def test_names_from_files_cannot_break_a_line(self):
        text = build_brief(dict(WITH_SPEC, spec="a\nb"), "e\nf.md", "ma\nin")
        self.assertNotIn("a\nb", text)
        self.assertNotIn("e\nf.md", text)
        self.assertNotIn("ma\nin", text)
        self.assertIn("ma?in", text)

    def test_length_stays_under_6000_with_every_inserted_name_at_its_largest(self):
        worst_name = "\x01" * 200  # every character is escaped to six
        for card in (dict(NO_SPEC, name=worst_name), dict(WITH_SPEC, name=worst_name, spec="s" * 400)):
            text = build_brief(card, "e" * 400, "b" * 400)
            self.assertLess(len(text), 6000)
        # and the plain templates are about 1,500 characters before the names go in
        for card in (NO_SPEC, WITH_SPEC):
            self.assertLess(len(build_brief(card, "e.md", "main")), 2000)

    def test_taken_spec_folders_change_the_new_folder_name(self):
        text = build_brief(NO_SPEC, "e.md", "main", taken={"filter-by-epic"})
        self.assertIn("story/filter-by-epic-2", text)
        self.assertIn(".kiro/specs/filter-by-epic-2/", text)


class SlugTests(unittest.TestCase):
    def test_cases(self):
        for name, expected in (("Start a story", "start-a-story"), ("  Spaces  &  punctuation!! ", "spaces-punctuation"),
                               ("Ünïcode Straße", "n-code-stra-e"), ("日本語", "story"), ("", "story"),
                               ("---", "story"), ("A--B__C", "a-b-c"), ("v2.0 release", "v2-0-release")):
            self.assertEqual(slugify(name), expected, name)

    def test_cut_to_60_and_no_trailing_hyphen(self):
        slug = slugify("word " * 30)
        self.assertLessEqual(len(slug), 60)
        self.assertFalse(slug.endswith("-"))
        self.assertEqual(slugify("a" * 80), "a" * 60)
        self.assertEqual(slugify("a" * 59 + " b"), "a" * 59)  # the cut leaves a hyphen, which is removed

    def test_taken_names_get_a_number(self):
        self.assertEqual(slugify("Start a story", {"start-a-story"}), "start-a-story-2")
        self.assertEqual(slugify("Start a story", {"start-a-story", "start-a-story-2"}), "start-a-story-3")
        self.assertEqual(slugify("日本語", {"story"}), "story-2")
        self.assertEqual(slugify("Start a story", {"other"}), "start-a-story")


class FindCardTests(unittest.TestCase):
    PLAN = {"groups": [
        {"epic": {"name": "Epic Board", "file": "epic-board.md"}, "cards": [WITH_SPEC, NO_SPEC]},
        {"epic": None, "cards": [{"name": "solo", "spec": "solo", "id": "#solo", "status": "planned"}]},
    ]}

    def test_epic_card(self):
        self.assertEqual(find_card(self.PLAN, "epic-board.md#Start a story"), ("epic-board.md", WITH_SPEC))

    def test_no_epic_card(self):
        epic_file, card = find_card(self.PLAN, "#solo")
        self.assertIsNone(epic_file)
        self.assertEqual(card["spec"], "solo")

    def test_missing_id(self):
        self.assertIsNone(find_card(self.PLAN, "epic-board.md#Nope"))
        self.assertIsNone(find_card({"groups": []}, "#x"))
        self.assertIsNone(find_card({}, "#x"))

    def test_spec_folders(self):
        self.assertEqual(spec_folders(self.PLAN), {"start-a-story", "solo"})


class StoreTests(unittest.TestCase):
    def setUp(self):
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.data = os.path.join(self.root, "apps", "epic-board", "data")
        self.names = iter(f"epic-board-{i:08x}" for i in range(1, 100))
        self.store = ChatStore(self.data, new_name=lambda: next(self.names), clock=lambda: "2026-11-14T09:30:12Z")

    def raw(self):
        with open(self.store.path, encoding="utf-8") as f:
            return f.read()

    def test_a_missing_file_means_no_records_and_a_read_makes_no_folder(self):
        self.assertEqual(self.store.started(), [])
        self.assertFalse(os.path.exists(self.data))

    def test_reserve_writes_a_record_with_the_documented_fields(self):
        record = self.store.reserve("e.md#A")
        self.assertEqual(record, {"card_id": "e.md#A", "name": "epic-board-00000001", "key": None,
                                 "state": "reserved", "created": "2026-11-14T09:30:12Z"})
        self.assertEqual(json.loads(self.raw()), {"chats": [record]})
        self.assertEqual(self.store.started(), [])  # a reserved record is not a chat

    def test_reserve_again_returns_the_same_record(self):
        first = self.store.reserve("e.md#A")
        self.assertEqual(self.store.reserve("e.md#A"), first)
        self.assertEqual(len(json.loads(self.raw())["chats"]), 1)

    def test_mark_started_and_started_list(self):
        a, b = self.store.reserve("e.md#A"), self.store.reserve("e.md#B")
        self.store.mark_started(b["name"], "key-b")
        self.store.mark_started(a["name"], "key-a")
        self.assertEqual(self.store.started(), [
            {"card_id": "e.md#A", "name": a["name"], "key": "key-a", "created": "2026-11-14T09:30:12Z"},
            {"card_id": "e.md#B", "name": b["name"], "key": "key-b", "created": "2026-11-14T09:30:12Z"}])

    def test_reserve_for_a_started_card_is_chat_exists(self):
        record = self.store.reserve("e.md#A")
        self.store.mark_started(record["name"], "k")
        with self.assertRaises(ChatError) as caught:
            self.store.reserve("e.md#A")
        self.assertEqual((caught.exception.code, caught.exception.status), ("chat_exists", 409))

    def test_mark_started_is_idempotent_for_the_same_key_only(self):
        record = self.store.reserve("e.md#A")
        self.store.mark_started(record["name"], "k")
        self.assertEqual(self.store.mark_started(record["name"], "k")["state"], "started")
        with self.assertRaises(ChatError) as caught:
            self.store.mark_started(record["name"], "other")
        self.assertEqual(caught.exception.code, "chat_exists")

    def test_mark_started_unknown_name_and_bad_key(self):
        with self.assertRaises(ChatError) as caught:
            self.store.mark_started("epic-board-nope", "k")
        self.assertEqual((caught.exception.code, caught.exception.status), ("chat_not_found", 404))
        record = self.store.reserve("e.md#A")
        for key in ("", "a b", "a/b", "é", None, 3, "x" * 194):
            with self.assertRaises(ChatError) as caught:
                self.store.mark_started(record["name"], key)
            self.assertEqual(caught.exception.code, "invalid_request", repr(key))

    def test_a_key_cannot_belong_to_two_cards(self):
        a, b = self.store.reserve("e.md#A"), self.store.reserve("e.md#B")
        self.store.mark_started(a["name"], "k")
        with self.assertRaises(ChatError) as caught:
            self.store.mark_started(b["name"], "k")
        self.assertEqual(caught.exception.code, "chat_exists")

    def test_remove(self):
        a = self.store.reserve("e.md#A")
        self.store.mark_started(a["name"], "k")
        self.store.remove(a["name"])
        self.assertEqual(json.loads(self.raw()), {"chats": []})
        self.assertEqual(self.store.reserve("e.md#A")["state"], "reserved")  # the card can start again
        with self.assertRaises(ChatError) as caught:
            self.store.remove("epic-board-nope")
        self.assertEqual((caught.exception.code, caught.exception.status), ("chat_not_found", 404))

    def test_a_new_name_never_repeats_one_in_the_file(self):
        names = iter(["dup", "dup", "other"])
        store = ChatStore(self.data, new_name=lambda: next(names), clock=lambda: "t")
        self.assertEqual(store.reserve("e.md#A")["name"], "dup")
        self.assertEqual(store.reserve("e.md#B")["name"], "other")

    def test_a_restart_reads_the_same_records(self):
        record = self.store.reserve("e.md#A")
        self.store.mark_started(record["name"], "k")
        again = ChatStore(self.data)
        self.assertEqual(again.started(), self.store.started())
        self.assertEqual(again.reserve("e.md#B")["state"], "reserved")

    def test_the_default_name_and_clock(self):
        store = ChatStore(self.data)
        record = store.reserve("e.md#A")
        self.assertRegex(record["name"], r"^epic-board-[0-9a-f]{8}$")
        self.assertRegex(record["created"], r"^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$")

    def test_an_unreadable_file_is_chats_unreadable_for_every_call_and_is_left_as_it_was(self):
        good = {"card_id": "c", "name": "n", "key": "k", "state": "started", "created": "t"}
        bad_contents = [
            "not json", "[]", "{}", '{"chats": {}}', '{"chats": [1]}', '{"chats": [], "extra": 1}',
            json.dumps({"chats": [dict(good, extra=1)]}),
            json.dumps({"chats": [{k: v for k, v in good.items() if k != "key"}]}),
            json.dumps({"chats": [dict(good, key=None)]}),                       # started with no key
            json.dumps({"chats": [dict(good, state="reserved")]}),                # reserved with a key
            json.dumps({"chats": [dict(good, state="weird")]}),
            json.dumps({"chats": [dict(good, card_id="")]}),
            json.dumps({"chats": [dict(good, name="a b")]}),
            json.dumps({"chats": [good, dict(good, name="m", key="k2")]}),        # duplicate card_id
            json.dumps({"chats": [good, dict(good, card_id="d")]}),               # duplicate name
            json.dumps({"chats": [good, dict(good, card_id="d", name="m")]}),     # duplicate key
        ]
        os.makedirs(self.data)
        for content in bad_contents:
            with open(self.store.path, "w", encoding="utf-8") as f:
                f.write(content)
            calls = (lambda: self.store.started(), lambda: self.store.reserve("e.md#A"),
                     lambda: self.store.mark_started("n", "k"), lambda: self.store.remove("n"))
            for call in calls:
                with self.assertRaises(ChatError) as caught:
                    call()
                self.assertEqual((caught.exception.code, caught.exception.status), ("chats_unreadable", 500), content)
                self.assertIn("chats.json", caught.exception.message)
            self.assertEqual(self.raw(), content)  # byte for byte
            self.assertEqual(os.listdir(self.data), ["chats.json"])

    def test_a_leftover_temporary_file_does_not_matter(self):
        os.makedirs(self.data)
        with open(os.path.join(self.data, ".chats-left.tmp"), "w") as f:
            f.write("half a wri")
        self.store.reserve("e.md#A")
        self.assertEqual(len(self.store.started()), 0)
        self.assertEqual(len(json.loads(self.raw())["chats"]), 1)

    def test_a_failed_write_keeps_the_old_file_and_leaves_no_temporary_file(self):
        record = self.store.reserve("e.md#A")
        before = self.raw()
        with mock.patch.object(chats.os, "replace", side_effect=OSError("disk full")):
            with self.assertRaises(ChatError) as caught:
                self.store.mark_started(record["name"], "k")
        self.assertEqual((caught.exception.code, caught.exception.status), ("internal", 500))
        self.assertNotIn(self.data, caught.exception.message)
        self.assertEqual(self.raw(), before)
        self.assertEqual(os.listdir(self.data), ["chats.json"])

    def test_a_data_folder_that_cannot_be_made_is_internal(self):
        blocker = os.path.join(self.root, "file")
        with open(blocker, "w") as f:
            f.write("x")
        store = ChatStore(os.path.join(blocker, "data"))
        with self.assertRaises(ChatError) as caught:
            store.reserve("e.md#A")
        self.assertEqual(caught.exception.code, "internal")

    def test_a_card_id_with_unusual_characters_round_trips(self):
        card_id = "épic file.md#Début ✓ \"quoted\" #hash"
        record = self.store.reserve(card_id)
        self.store.mark_started(record["name"], "k")
        self.assertEqual(ChatStore(self.data).started()[0]["card_id"], card_id)


SECRET = "test-secret"
NOW = 1_800_000_000


def sign(method, target, body=b"", secret=SECRET, stamp=NOW):
    import hashlib
    import hmac
    digest = hashlib.sha256(body).hexdigest()
    mac = hmac.new(secret.encode(), f"{stamp}:{method}:{target}:{digest}".encode(), hashlib.sha256).hexdigest()
    return f"{stamp}:{mac}"


def plan_body(**extra):
    done = dict(WITH_SPEC, name="Old story", status="done", id="epic-board.md#Old story", spec="old-story")
    body = {"branch": "main", "groups": [
        {"epic": {"name": "Epic Board", "file": "epic-board.md"}, "cards": [NO_SPEC, WITH_SPEC, done]},
        {"epic": None, "cards": [{"name": "solo", "status": "planned", "spec": "solo", "tasks": None,
                                  "epic": None, "description": "", "id": "#solo"}]}]}
    body.update(extra)
    return body


class FakeHolder:
    def __init__(self, answer=("plan", None)):
        self.answer, self.calls = answer, 0

    def request(self):
        self.calls += 1
        kind, value = self.answer
        return (kind, plan_body() if kind == "plan" and value is None else value)


class ServiceTests(unittest.TestCase):
    def setUp(self):
        import server
        self.server = server
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.data = os.path.join(self.root, "data")
        names = iter(f"epic-board-{i:08x}" for i in range(1, 99))
        self.store = ChatStore(self.data, new_name=lambda: next(names), clock=lambda: "2026-11-14T09:30:12Z")
        self.holder = FakeHolder()

    def service(self, folder="f_8c1", reason=None, secret=SECRET, holder="default"):
        return self.server.ChatService(self.store, folder, reason, secret,
                                       self.holder if holder == "default" else holder, clock=lambda: NOW)

    def call(self, method, target, body=None, service=None, **sign_options):
        raw = b"" if body is None else (body if isinstance(body, bytes) else json.dumps(body).encode())
        header = sign(method, target, raw, **sign_options)
        return (service or self.service()).handle(method, target, header, raw)

    def file_exists(self):
        return os.path.exists(os.path.join(self.data, "chats.json"))

    def records(self):
        with open(self.store.path, encoding="utf-8") as f:
            return json.load(f)["chats"]

    # -- authentication and the order of the checks

    def test_no_secret_is_503_before_anything_else(self):
        status, body = self.service(secret="").handle("GET", "/api/chats", sign("GET", "/api/chats"), b"")
        self.assertEqual((status, body["error"]["code"]), (503, "proxy_secret_missing"))

    def test_bad_signatures_are_401_and_read_and_change_nothing(self):
        service, target = self.service(), "/api/chats"
        raw = b'{"card_id": "epic-board.md#Filter by epic"}'
        good = sign("POST", target, raw)
        cases = {
            "no header": "", "wrong secret": sign("POST", target, raw, secret="other"),
            "stale": sign("POST", target, raw, stamp=NOW - 61), "future": sign("POST", target, raw, stamp=NOW + 61),
            "other body": sign("POST", target, b"{}"), "other method": sign("GET", target, raw),
            "other target": sign("POST", "/api/chats?x=1", raw), "garbage": "not-a-signature",
        }
        for label, header in cases.items():
            status, body = service.handle("POST", target, header, raw)
            self.assertEqual((status, body["error"]["code"]), (401, "unauthorized"), label)
        self.assertFalse(self.file_exists())
        self.assertEqual(self.holder.calls, 0)
        self.assertEqual(service.handle("POST", target, good, raw)[0], 200)

    def test_signature_is_checked_before_the_body_is_read(self):
        status, body = self.service().handle("POST", "/api/chats", "bad", b"not json at all")
        self.assertEqual((status, body["error"]["code"]), (401, "unauthorized"))
        status, body = self.call("POST", "/api/chats", b"not json at all")
        self.assertEqual((status, body["error"]["code"]), (400, "invalid_request"))

    def test_the_signature_covers_the_query_and_the_path_as_received(self):
        for target in ("/api/chats", "/chats", "/api/apps/epic-board/chats", "/api/chats?a=1&b=two%20words"):
            self.assertEqual(self.call("GET", target)[0], 200, target)

    # -- GET /chats

    def test_get_lists_started_chats_with_the_folder(self):
        status, body = self.call("GET", "/api/chats")
        self.assertEqual((status, body), (200, {"folder_id": "f_8c1", "folder_reason": None, "chats": []}))
        record = self.store.reserve("epic-board.md#Filter by epic")
        self.assertEqual(self.call("GET", "/api/chats")[1]["chats"], [])  # reserved is not a chat
        self.store.mark_started(record["name"], "key-1")
        chats_ = self.call("GET", "/api/chats")[1]["chats"]
        self.assertEqual(chats_, [{"card_id": "epic-board.md#Filter by epic", "name": record["name"], "key": "key-1",
                                   "created": "2026-11-14T09:30:12Z"}])

    def test_get_reports_a_folder_that_is_not_set_with_its_reason(self):
        status, body = self.call("GET", "/api/chats", service=self.service(folder=None, reason="folder_id must be text."))
        self.assertEqual((status, body["folder_id"], body["folder_reason"]), (200, None, "folder_id must be text."))

    # -- POST /chats (reserve)

    def reserve(self, card_id, **kwargs):
        return self.call("POST", "/api/chats", {"card_id": card_id}, **kwargs)

    def test_reserve_a_planned_card_with_no_spec(self):
        status, body = self.reserve("epic-board.md#Filter by epic")
        self.assertEqual(status, 200)
        self.assertEqual((body["card_id"], body["folder_id"]), ("epic-board.md#Filter by epic", "f_8c1"))
        self.assertRegex(body["name"], r"^epic-board-[0-9a-f]{8}$")
        self.assertIn("write this story's spec", body["brief"])
        self.assertIn("story/filter-by-epic ", body["brief"])
        self.assertIn("Epic page: docs/epics/epic-board.md", body["brief"])
        self.assertEqual([r["state"] for r in self.records()], ["reserved"])

    def test_reserve_an_in_progress_card_with_a_spec(self):
        status, body = self.reserve("epic-board.md#Start a story")
        self.assertEqual(status, 200)
        self.assertIn("build the next task group", body["brief"])
        self.assertIn(".kiro/specs/start-a-story/", body["brief"])

    def test_reserve_a_no_epic_card(self):
        status, body = self.reserve("#solo")
        self.assertEqual(status, 200)
        self.assertIn("Epic page: none", body["brief"])

    def test_the_folder_name_of_a_new_spec_avoids_the_plan_spec_folders(self):
        plan = plan_body()
        plan["groups"][0]["cards"][0] = dict(NO_SPEC, name="Start a story", id="epic-board.md#Start a story", spec=None)
        self.holder.answer = ("plan", plan)
        status, body = self.reserve("epic-board.md#Start a story")
        self.assertIn("story/start-a-story-2 ", body["brief"])

    def test_refusals_of_a_reservation(self):
        cases = [
            ("epic-board.md#Nope", 409, "card_not_found"),
            ("epic-board.md#Old story", 409, "card_done"),
            ("", 400, "invalid_request"),
            ("x" * 401, 400, "invalid_request"),
        ]
        for card_id, expected_status, code in cases:
            status, body = self.reserve(card_id)
            self.assertEqual((status, body["error"]["code"]), (expected_status, code), card_id)
        self.assertFalse(self.file_exists())  # a refusal changes no record

    def test_reserve_a_card_that_already_has_a_chat(self):
        status, body = self.reserve("epic-board.md#Start a story")
        self.call("POST", f"/api/chats/{body['name']}/started", {"key": "k1"})
        status, again = self.reserve("epic-board.md#Start a story")
        self.assertEqual((status, again["error"]["code"]), (409, "chat_exists"))
        self.assertEqual(len(self.records()), 1)

    def test_reserve_again_returns_the_same_name_with_a_freshly_built_brief(self):
        _, first = self.reserve("epic-board.md#Filter by epic")
        plan = plan_body(branch="trunk")
        self.holder.answer = ("plan", plan)
        status, second = self.reserve("epic-board.md#Filter by epic")
        self.assertEqual((status, second["name"]), (200, first["name"]))
        self.assertIn("origin/trunk", second["brief"])
        self.assertEqual(len(self.records()), 1)

    def test_plan_not_ready(self):
        for holder in (FakeHolder(("pending", None)), FakeHolder(("error", {"code": "ref_unreadable", "message": "x"})), None):
            status, body = self.reserve("epic-board.md#Filter by epic", service=self.service(holder=holder))
            self.assertEqual((status, body["error"]["code"]), (409, "plan_not_ready"))
        self.assertFalse(self.file_exists())

    def test_folder_not_set(self):
        status, body = self.reserve("epic-board.md#Filter by epic", service=self.service(folder=None, reason="EPIC_BOARD_FOLDER must be text and not empty."))
        self.assertEqual((status, body["error"]["code"]), (409, "folder_not_set"))
        self.assertIn("EPIC_BOARD_FOLDER must be text", body["error"]["message"])
        self.assertEqual(self.holder.calls, 0)

    def test_the_order_of_the_reservation_checks(self):
        os.makedirs(self.data)
        with open(self.store.path, "w") as f:
            f.write("not json")
        unset = self.service(folder=None)
        self.assertEqual(self.reserve("x", service=unset)[1]["error"]["code"], "folder_not_set")           # folder first
        pending = self.service(holder=FakeHolder(("pending", None)))
        self.assertEqual(self.reserve("x", service=pending)[1]["error"]["code"], "chats_unreadable")        # then the store
        os.unlink(self.store.path)
        self.assertEqual(self.reserve("x", service=pending)[1]["error"]["code"], "plan_not_ready")         # then the plan
        self.assertEqual(self.reserve("epic-board.md#Nope")[1]["error"]["code"], "card_not_found")         # then the card
        self.assertEqual(self.reserve("epic-board.md#Old story")[1]["error"]["code"], "card_done")         # then its status
        self.reserve("epic-board.md#Filter by epic")
        self.call("POST", "/api/chats/epic-board-00000001/started", {"key": "k"})
        self.assertEqual(self.reserve("epic-board.md#Filter by epic")[1]["error"]["code"], "chat_exists")  # then the record

    # -- the request form

    def test_bad_bodies_are_400_and_change_nothing(self):
        bodies = [b"", b"not json", b"[]", b'"x"', b"{}", b'{"card_id": 1}', b'{"card_id": "a", "extra": 1}',
                  b'{"card":"a"}', b"\xff\xfe", json.dumps({"card_id": "a" * 5000}).encode()]
        for raw in bodies:
            status, body = self.call("POST", "/api/chats", raw)
            self.assertEqual((status, body["error"]["code"]), (400, "invalid_request"), raw[:30])
        self.assertFalse(self.file_exists())

    def test_body_limit_is_4096_bytes(self):
        valid = b'{"card_id": "epic-board.md#Filter by epic"}'
        at_limit = valid + b" " * (4096 - len(valid))
        over = valid + b" " * (4097 - len(valid))
        self.assertEqual((len(at_limit), len(over)), (4096, 4097))
        self.assertEqual(self.call("POST", "/api/chats", at_limit)[0], 200)   # 4,096 bytes is allowed
        for method in ("POST", "GET", "DELETE"):
            status, body = self.call(method, "/api/chats", over)
            self.assertEqual((status, body["error"]["code"]), (400, "invalid_request"), method)

    def test_started_form_and_keys(self):
        _, reserved = self.reserve("epic-board.md#Filter by epic")
        path = f"/api/chats/{reserved['name']}/started"
        for raw in (b"{}", b'{"key": 3}', b'{"key": ""}', b'{"key": "a b"}', b'{"key": "k", "x": 1}', b'{"key": "' + b"x" * 194 + b'"}'):
            self.assertEqual(self.call("POST", path, raw)[1]["error"]["code"], "invalid_request", raw)
        status, body = self.call("POST", path, {"key": "chat-key"})
        self.assertEqual((status, body), (200, {"card_id": "epic-board.md#Filter by epic", "name": reserved["name"], "key": "chat-key"}))
        self.assertEqual(self.call("POST", path, {"key": "chat-key"})[0], 200)                         # the same key again
        self.assertEqual(self.call("POST", path, {"key": "another"})[1]["error"]["code"], "chat_exists")

    def test_started_and_delete_for_unknown_names_are_404(self):
        for method, path, body in (("POST", "/api/chats/epic-board-nope/started", {"key": "k"}),
                                   ("DELETE", "/api/chats/epic-board-nope", None)):
            status, answer = self.call(method, path, body)
            self.assertEqual((status, answer["error"]["code"]), (404, "chat_not_found"))

    def test_a_bad_name_in_the_path_is_400(self):
        for path in ("/api/chats/a%20b", "/api/chats/é/started", "/api/chats/" + "x" * 194):
            method = "DELETE" if "started" not in path else "POST"
            self.assertEqual(self.call(method, path, None if method == "DELETE" else {"key": "k"})[1]["error"]["code"],
                             "invalid_request", path)

    def test_delete_removes_reserved_and_started_records(self):
        _, a = self.reserve("epic-board.md#Filter by epic")
        _, b = self.reserve("epic-board.md#Start a story")
        self.call("POST", f"/api/chats/{b['name']}/started", {"key": "k"})
        self.assertEqual(self.call("DELETE", f"/api/chats/{a['name']}"), (200, {"removed": True}))
        self.assertEqual(self.call("DELETE", f"/api/chats/{b['name']}"), (200, {"removed": True}))
        self.assertEqual(self.records(), [])
        self.assertEqual(self.reserve("epic-board.md#Start a story")[0], 200)  # the card can start again

    def test_unknown_routes_and_methods_are_404_after_authentication(self):
        for method, path in (("GET", "/api/chats/epic-board-1"), ("POST", "/api/chats/epic-board-1"),
                             ("GET", "/api/chats/epic-board-1/started"), ("DELETE", "/api/chats"),
                             ("PUT", "/api/chats"), ("DELETE", "/api/chats/a/started"), ("GET", "/api/other")):
            status, body = self.call(method, path)
            self.assertEqual((status, body["error"]["code"]), (404, "not_found"), (method, path))
        self.assertEqual(self.service().handle("GET", "/api/other", "bad", b"")[0], 401)

    # -- the file of chats

    def test_an_unreadable_file_is_500_on_every_route_and_is_left_alone(self):
        os.makedirs(self.data)
        with open(self.store.path, "w") as f:
            f.write("{broken")
        for method, path, body in (("GET", "/api/chats", None), ("POST", "/api/chats", {"card_id": "epic-board.md#Filter by epic"}),
                                   ("POST", "/api/chats/epic-board-1/started", {"key": "k"}), ("DELETE", "/api/chats/epic-board-1", None)):
            status, answer = self.call(method, path, body)
            self.assertEqual((status, answer["error"]["code"]), (500, "chats_unreadable"), path)
            self.assertIn("chats.json", answer["error"]["message"])
        with open(self.store.path) as f:
            self.assertEqual(f.read(), "{broken")

    def test_an_unexpected_exception_is_500_internal_without_a_path(self):
        service = self.service()
        with mock.patch.object(self.store, "started", side_effect=RuntimeError(f"boom in {self.data}")):
            with mock.patch("sys.stderr"):
                status, body = self.call("GET", "/api/chats", service=service)
        self.assertEqual((status, body["error"]["code"]), (500, "internal"))
        self.assertNotIn(self.data, json.dumps(body))

    def test_a_write_failure_is_500_internal_without_a_path(self):
        with mock.patch.object(chats.os, "replace", side_effect=OSError("disk full")):
            status, body = self.reserve("epic-board.md#Filter by epic")
        self.assertEqual((status, body["error"]["code"]), (500, "internal"))
        self.assertNotIn(self.data, json.dumps(body))


class HttpTests(unittest.TestCase):
    """The routes through a real server on port 0."""

    def setUp(self):
        import server
        self.server = server
        self.root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, self.root, True)
        self.store = ChatStore(os.path.join(self.root, "data"))
        self.holder = FakeHolder()
        self.service = server.ChatService(self.store, "f_1", None, SECRET, self.holder)  # the real clock
        self.httpd = server.make_server(0, self.holder, None, "/app/config.json", self.service)
        import threading
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()
        self.addCleanup(self.httpd.server_close)
        self.addCleanup(self.httpd.shutdown)

    def request(self, method, path, body=None, signed=True):
        import http.client
        import time
        raw = b"" if body is None else json.dumps(body).encode()
        connection = http.client.HTTPConnection("127.0.0.1", self.httpd.server_port, timeout=10)
        connection.putrequest(method, path)
        if signed:
            connection.putheader("X-KiroCrew-Proxy", sign(method, path, raw, stamp=int(time.time())))
        connection.putheader("Content-Length", str(len(raw)))
        connection.endheaders()
        if raw:
            connection.send(raw)
        response = connection.getresponse()
        data = json.loads(response.read())
        connection.close()
        return response.status, data

    def test_get_post_and_delete_reach_the_service(self):
        self.assertEqual(self.request("GET", "/api/chats")[0], 200)
        status, reserved = self.request("POST", "/api/chats", {"card_id": "epic-board.md#Filter by epic"})
        self.assertEqual(status, 200)
        status, body = self.request("POST", f"/api/chats/{reserved['name']}/started", {"key": "k-http"})
        self.assertEqual((status, body["key"]), (200, "k-http"))
        self.assertEqual(self.request("GET", "/api/chats?x=1")[1]["chats"][0]["key"], "k-http")
        self.assertEqual(self.request("DELETE", f"/api/chats/{reserved['name']}"), (200, {"removed": True}))

    def test_unsigned_requests_are_401(self):
        for method in ("GET", "POST", "DELETE"):
            status, body = self.request(method, "/api/chats", signed=False)
            self.assertEqual((status, body["error"]["code"]), (401, "unauthorized"), method)

    def test_plan_and_health_are_unsigned_and_unchanged_and_post_to_them_is_404(self):
        self.assertEqual(self.request("GET", "/health", signed=False), (200, {"ok": True}))
        self.assertEqual(self.request("GET", "/api/apps/epic-board/health", signed=False), (200, {"ok": True}))
        self.assertEqual(self.request("POST", "/plan", {}, signed=False)[0], 404)
        self.assertEqual(self.request("DELETE", "/health", signed=False)[0], 404)
        self.assertEqual(self.request("GET", "/other", signed=False)[0], 404)

    def raw_post(self, content_length_lines, body=b""):
        """Send a POST by hand, so the Content-Length header can be missing or wrong."""
        import socket
        import time
        target = "/api/chats"
        head = f"POST {target} HTTP/1.0\r\nX-KiroCrew-Proxy: {sign('POST', target, body, stamp=int(time.time()))}\r\n"
        with socket.create_connection(("127.0.0.1", self.httpd.server_port), timeout=10) as sock:
            sock.sendall((head + content_length_lines + "\r\n").encode() + body)
            data = b""
            while chunk := sock.recv(65536):
                data += chunk
        status = int(data.split(b" ", 2)[1])
        return status, json.loads(data.split(b"\r\n\r\n", 1)[1])

    def test_a_missing_non_numeric_negative_or_oversized_content_length_is_400(self):
        for label, lines in (("missing", ""), ("not a number", "Content-Length: abc\r\n"), ("negative", "Content-Length: -5\r\n"),
                             ("over the limit", "Content-Length: 4097\r\n"), ("huge", "Content-Length: " + "9" * 5000 + "\r\n"),
                             ("non-ASCII digits", "Content-Length: \u0663\r\n")):
            try:
                status, body = self.raw_post(lines)
            except UnicodeEncodeError:
                continue  # the header cannot even be sent as bytes; nothing reaches the server
            self.assertEqual((status, body["error"]["code"]), (400, "invalid_request"), label)
        self.assertEqual(self.store.started(), [])

    def test_no_git_command_runs(self):
        import gitsource
        import subprocess
        ran = []

        def forbidden(*args, **kwargs):
            ran.append(args)
            raise AssertionError("a git command ran")
        with mock.patch.object(gitsource, "run_git", forbidden), mock.patch.object(subprocess, "Popen", forbidden):
            self.request("GET", "/api/chats")
            self.request("POST", "/api/chats", {"card_id": "epic-board.md#Filter by epic"})
        self.assertEqual(ran, [])

    def test_without_a_service_the_chats_routes_are_404(self):
        import threading
        httpd = self.server.make_server(0, self.holder, None, "/app/config.json")
        threading.Thread(target=httpd.serve_forever, daemon=True).start()
        self.addCleanup(httpd.server_close)
        self.addCleanup(httpd.shutdown)
        import urllib.error
        import urllib.request
        with self.assertRaises(urllib.error.HTTPError) as caught:
            urllib.request.urlopen(f"http://127.0.0.1:{httpd.server_port}/api/chats")
        self.assertEqual(caught.exception.code, 404)
        caught.exception.close()


if __name__ == "__main__":
    unittest.main()
