"""Property tests for the chat store, the brief and the spec folder name (design.md, "Correctness Properties").

As in test_held_properties.py, the project adds no dependency, so each property is checked with seeded
random inputs: every iteration has its own seed, a failure names the seed, and the same seed gives the
same inputs again.
"""
import json
import os
import random
import re
import shutil
import tempfile
import unittest
from unittest import mock

import chats
from chats import ChatError, ChatStore, build_brief, slugify

ITERATIONS = 200
BASE_SEED = 20261114

ALPHABET = ("abcXYZ 019-_.#/\\\"'\n\t\r\x00\x01\u2028é日本語✓!?&<>:;,()[]{}`" + " " * 6)


def random_text(rng, low=0, high=40):
    return "".join(rng.choice(ALPHABET) for _ in range(rng.randint(low, high)))


def random_card(rng, tag):
    spec = None if rng.random() < 0.5 else rng.choice(["s", "start-a-story", random_text(rng, 1, 30), "x" * 300])
    return {"name": random_text(rng, 0, 260), "status": rng.choice(["planned", "in progress"]), "spec": spec,
            "tasks": None if spec is None else {"done": rng.randint(0, 5), "total": rng.randint(5, 9)},
            "epic": "E", "description": f"DESC-{tag}-{rng.randint(10**8, 10**9)}", "id": "e.md#" + tag}


class BriefProperty(unittest.TestCase):
    def test_property_4_the_brief_depends_only_on_its_inputs_and_always_says_never_to_merge(self):
        for i in range(ITERATIONS):
            seed = BASE_SEED + i
            rng = random.Random(seed)
            card = random_card(rng, f"c{i}")
            epic_file = rng.choice([None, "e.md", random_text(rng, 1, 300)])
            branch = rng.choice(["main", "trunk", random_text(rng, 1, 300)])
            taken = {random_text(rng, 1, 10) for _ in range(rng.randint(0, 3))}
            text = build_brief(card, epic_file, branch, taken)
            where = f"seed {seed}"
            self.assertEqual(text, build_brief(dict(card), epic_file, branch, set(taken)), where)
            no_spec = "Your job: write this story's spec. It has none yet." in text
            with_spec = "Your job: build the next task group of this story's spec." in text
            self.assertEqual((no_spec, with_spec), (card["spec"] is None, card["spec"] is not None), where)
            # the status words follow the variant and the epic: the line is set to in progress when a spec is
            # written, and to done when the last task is ticked, and neither when there is no epic page
            self.assertEqual("Set its status to in progress." in text, no_spec and bool(epic_file), where)
            self.assertEqual("set the story's line in the epic page to done" in text, with_spec and bool(epic_file), where)
            self.assertNotIn("Keep its status", text, where)
            self.assertRegex(text, r"(?m)^- Never merge a pull request, never push to [^\n]*, never turn on auto-merge\. "
                                   r"The person reviews and merges\.$", where)
            self.assertIn("- Open exactly one pull request. When it is open, write its address in this chat and stop.", text, where)
            self.assertIn("- If you are blocked or unsure, ask in this chat. Do not guess.", text, where)
            self.assertLessEqual(len(text), 6000, where)
            self.assertNotIn(card["description"], text, where)
            self.assertEqual(len([l for l in text.split("\n") if l.startswith("Story: ")]), 1, where)
            self.assertNotIn("\u2028", text, where)


class SlugProperty(unittest.TestCase):
    def test_property_5_a_spec_folder_name_is_well_formed_and_unused(self):
        for i in range(ITERATIONS):
            seed = BASE_SEED + i
            rng = random.Random(seed)
            name = random_text(rng, 0, 200)
            slug = slugify(name)
            taken = {slug, f"{slug}-2"} if rng.random() < 0.4 else {random_text(rng, 1, 8) for _ in range(rng.randint(0, 4))}
            taken |= {"story"} if rng.random() < 0.3 else set()
            result = slugify(name, taken)
            where = f"seed {seed}, name {name!r}"
            self.assertRegex(result, r"^[a-z0-9]+(-[a-z0-9]+)*$", where)
            self.assertNotIn(result, taken, where)
            self.assertLessEqual(len(result), 60 + 1 + len(str(len(taken) + 1)), where)
            if not re.search(r"[A-Za-z0-9]", name):
                self.assertTrue(result.startswith("story"), where)
            if len(taken) == 0 or slug not in taken:
                self.assertEqual(result, slug, where)


class StoreProperty(unittest.TestCase):
    """Random reserve, mark_started, remove, restart and failed-write steps against a model."""

    CARDS = [f"e.md#Card {n}" for n in range(5)]
    KEYS = [f"key-{n}" for n in range(4)]

    def run_one(self, seed):
        rng = random.Random(seed)
        root = tempfile.mkdtemp()
        self.addCleanup(shutil.rmtree, root, True)
        data = os.path.join(root, "data")
        counter = iter(range(1, 10**6))
        make = lambda: ChatStore(data, new_name=lambda: f"epic-board-{next(counter):08x}", clock=lambda: "2026-11-14T00:00:00Z")
        store, model = make(), {}  # model: card_id -> {"name", "key", "state"}, in creation order
        where = lambda step: f"seed {seed}, step {step}"

        def file_text():
            try:
                with open(os.path.join(data, "chats.json"), encoding="utf-8") as f:
                    return f.read()
            except FileNotFoundError:
                return None

        for step in range(rng.randint(1, 40)):
            action = rng.choices(["reserve", "start", "remove", "restart", "fail_write"], weights=(5, 5, 2, 2, 1))[0]
            names = [m["name"] for m in model.values()]
            if action == "reserve":
                card = rng.choice(self.CARDS)
                if card in model and model[card]["state"] == "started":
                    with self.assertRaises(ChatError, msg=where(step)) as caught:
                        store.reserve(card)
                    self.assertEqual(caught.exception.code, "chat_exists", where(step))
                else:
                    record = store.reserve(card)
                    if card in model:
                        self.assertEqual(record["name"], model[card]["name"], where(step))
                    else:
                        model[card] = {"name": record["name"], "key": None, "state": "reserved"}
                    self.assertEqual((record["card_id"], record["state"], record["key"]), (card, "reserved", None), where(step))
            elif action == "start":
                name = rng.choice(names + ["epic-board-unknown"])
                key = rng.choice(self.KEYS)
                owner = next((c for c, m in model.items() if m["name"] == name), None)
                if owner is None:
                    expected = "chat_not_found"
                elif model[owner]["state"] == "started":
                    expected = None if model[owner]["key"] == key else "chat_exists"
                elif any(m["key"] == key for m in model.values()):
                    expected = "chat_exists"
                else:
                    expected = None
                if expected:
                    with self.assertRaises(ChatError, msg=where(step)) as caught:
                        store.mark_started(name, key)
                    self.assertEqual(caught.exception.code, expected, where(step))
                else:
                    store.mark_started(name, key)
                    model[owner]["state"], model[owner]["key"] = "started", key
            elif action == "remove":
                name = rng.choice(names + ["epic-board-unknown"])
                owner = next((c for c, m in model.items() if m["name"] == name), None)
                if owner is None:
                    with self.assertRaises(ChatError, msg=where(step)) as caught:
                        store.remove(name)
                    self.assertEqual(caught.exception.code, "chat_not_found", where(step))
                else:
                    store.remove(name)
                    del model[owner]
            elif action == "restart":
                before = file_text()
                store = make()
                self.assertEqual(file_text(), before, where(step))
            else:  # a write that fails half-way must leave the old file as it was
                before = file_text()
                free = [c for c in self.CARDS if c not in model]
                if free:
                    with mock.patch.object(chats.os, "replace", side_effect=OSError("stopped")):
                        with self.assertRaises(ChatError, msg=where(step)) as caught:
                            store.reserve(free[0])
                    self.assertEqual(caught.exception.code, "internal", where(step))
                    self.assertEqual(file_text(), before, where(step))
                    self.assertEqual([n for n in os.listdir(data) if n != "chats.json"] if os.path.isdir(data) else [], [], where(step))

            # the invariants, read from the file itself
            text = file_text()
            records = json.loads(text)["chats"] if text else []
            self.assertEqual(len({r["card_id"] for r in records}), len(records), where(step))
            self.assertEqual(len({r["name"] for r in records}), len(records), where(step))
            for record in records:
                self.assertEqual(record["state"] == "started", record["key"] is not None, where(step))
            self.assertEqual({r["card_id"]: (r["name"], r["key"], r["state"]) for r in records},
                             {c: (m["name"], m["key"], m["state"]) for c, m in model.items()}, where(step))
            self.assertEqual([r["card_id"] for r in records], list(model), where(step))
            self.assertEqual([(r["card_id"], r["key"]) for r in store.started()],
                             [(c, m["key"]) for c, m in model.items() if m["state"] == "started"], where(step))
            self.assertEqual(make().started(), store.started(), where(step))  # a restart reads the same records

    def test_property_3_the_store_never_holds_two_records_for_a_card_or_a_name_and_survives_a_reload(self):
        for i in range(ITERATIONS):
            self.run_one(BASE_SEED + i)


if __name__ == "__main__":
    unittest.main()
