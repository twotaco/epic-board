import unittest

from parse import parse_epic, parse_stories, parse_tasks, spec_folder


class TaskTests(unittest.TestCase):
    def test_counts_nested_optional_and_under_way(self):
        text = """- [x] 1. a
  - [X] 1.1 b
  - [-] 1.2 c
  - [ ] 1.3 d
- [ ]* 2. optional
  - [x]* 2.1 optional done
* [ ] 3. star bullet
not a task [x]
"""
        counts = parse_tasks(text)
        self.assertEqual((counts.done, counts.under_way, counts.total), (2, 1, 5))

    def test_empty(self):
        self.assertEqual(tuple(parse_tasks("")), (0, 0, 0))


class StoryTests(unittest.TestCase):
    def test_section_stories(self):
        text = """# My Epic

## Stories

- [One](../../.kiro/specs/one/) — in progress
- Two — Done.
- Three — soon
- Four
- Five —
- [Six](x) — planned

## Other
- Seven — done
"""
        epic = parse_epic(text, "my.md")
        self.assertEqual(epic.name, "My Epic")
        got = [(s.name, s.link, s.status) for s in epic.stories]
        self.assertEqual(got, [
            ("One", "../../.kiro/specs/one/", "in progress"),
            ("Two", None, "done"),
            ("Three", None, None),
            ("Five", None, None),
            ("Six", "x", "planned"),
        ])

    def test_description_after_first_full_stop(self):
        text = """## Stories
- [A](.kiro/specs/a/) — done. Frozen: records what was built. Not edited.
- B — planned. A connected agent can start it.
- C — in progress.
- D — soon. done later.
"""
        got = [(s.name, s.status, s.description) for s in parse_stories(text, False)]
        self.assertEqual(got, [
            ("A", "done", "Frozen: records what was built. Not edited."),
            ("B", "planned", "A connected agent can start it."),
            ("C", "in progress", ""),
            ("D", None, "done later."),
        ])

    def test_name_falls_back_to_file(self):
        self.assertEqual(parse_epic("no heading", "f.md").name, "f.md")

    def test_whole_file_first_column_only(self):
        text = "Notes\n- A — done\n  - nested — done\n- B — planned\n"
        self.assertEqual([s.name for s in parse_stories(text, True)], ["A", "B"])
        self.assertEqual(parse_stories(text, False), [])

    def test_stories_section_wins_in_whole_file_mode(self):
        text = "- Outside — done\n## Stories\n- Inside — done\n"
        self.assertEqual([s.name for s in parse_stories(text, True)], ["Inside"])

    def test_spec_folder(self):
        self.assertEqual(spec_folder("../../.kiro/specs/read-it/"), "read-it")
        self.assertEqual(spec_folder("../../.kiro/specs/read-it/tasks.md"), "read-it")
        self.assertIsNone(spec_folder("https://example.com"))
        self.assertIsNone(spec_folder(None))


if __name__ == "__main__":
    unittest.main()
