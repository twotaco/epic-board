import unittest

from plan import build_plan


class Memory:
    """In-memory source: {path: text, or an Exception to raise}."""

    def __init__(self, files):
        self.files = files

    def list_files(self, *prefixes):
        return sorted(p for p in self.files if any(p.startswith(x + "/") for x in prefixes))

    def read_file(self, path):
        value = self.files[path]
        if isinstance(value, Exception):
            raise value
        return value


def names(group):
    return [(c["name"], c["status"]) for c in group["cards"]]


class PlanTests(unittest.TestCase):
    def test_empty_plan(self):
        self.assertEqual(build_plan(Memory({})), ([], []))

    def test_specs_without_epics(self):
        groups, problems = build_plan(Memory({
            ".kiro/specs/b-spec/tasks.md": "- [x] 1\n- [ ] 2\n",
            ".kiro/specs/A-spec/tasks.md": "- [x] 1\n",
            ".kiro/specs/c-spec/tasks.md": "- [ ] 1\n",
            ".kiro/specs/d-spec/design.md": "x",
        }))
        self.assertEqual(problems, [])
        self.assertEqual(len(groups), 1)
        self.assertIsNone(groups[0]["epic"])
        self.assertEqual(names(groups[0]), [
            ("A-spec", "done"), ("b-spec", "in progress"), ("c-spec", "planned"), ("d-spec", "planned")])
        self.assertEqual(groups[0]["cards"][3]["tasks"], {"done": 0, "total": 0})

    def test_spec_in_two_epics_and_done_override(self):
        epic = "# {}\n## Stories\n- [S](../../.kiro/specs/s/) — {}\n- Ghost — in progress\n- [Gone](../../.kiro/specs/gone/) — done\n- Plain\n"
        groups, _ = build_plan(Memory({
            ".kiro/specs/s/tasks.md": "- [-] 1\n- [ ] 2\n",
            "docs/epics/a.md": epic.format("A", "done"),
            "docs/epics/b.md": epic.format("B", "planned"),
            "docs/epics/README.md": "ignored",
        }))
        self.assertEqual([g["epic"]["name"] for g in groups], ["A", "B"])
        self.assertEqual(names(groups[0]), [("S", "done"), ("Ghost", "in progress"), ("Gone", "done")])
        self.assertEqual(groups[0]["cards"][0]["tasks"], {"done": 0, "total": 2})
        self.assertEqual(names(groups[1])[0], ("S", "in progress"))
        self.assertIsNone(groups[0]["cards"][1]["spec"])
        self.assertIsNone(groups[0]["cards"][1]["tasks"])
        self.assertEqual(groups[0]["cards"][0]["epic"], "A")

    def test_standalone_with_stories_section(self):
        groups, _ = build_plan(Memory({
            ".kiro/specs/in-epic/tasks.md": "- [x] 1\n",
            ".kiro/specs/solo/tasks.md": "- [ ] 1\n",
            ".kiro/specs/other/tasks.md": "- [ ] 1\n",
            "docs/epics/e.md": "# E\n## Stories\n- [X](.kiro/specs/in-epic/) — planned\n",
            "docs/epics/standalone.md": "## Stories\n- [Dup](.kiro/specs/in-epic/) — done\n"
                                        "- [Solo again](.kiro/specs/solo/) — planned\n"
                                        "- [Solo twice](.kiro/specs/solo/) — planned\n"
                                        "- zeta idea — planned\n",
        }))
        self.assertEqual(names(groups[0]), [("X", "done")])
        self.assertEqual(groups[1]["epic"], None)
        self.assertEqual(names(groups[1]), [("other", "planned"), ("Solo again", "planned"), ("zeta idea", "planned")])

    def test_standalone_whole_file(self):
        groups, _ = build_plan(Memory({
            "docs/epics/standalone.md": "Notes\n- Idea — done\n  - nested — done\n",
        }))
        self.assertEqual(names(groups[0]), [("Idea", "done")])

    def test_unreadable_files_become_problems(self):
        groups, problems = build_plan(Memory({
            ".kiro/specs/s/tasks.md": OSError("boom"),
            "docs/epics/bad.md": OSError("nope"),
            "docs/epics/good.md": "# Good\n## Stories\n- [S](.kiro/specs/s/) — planned\n",
        }))
        self.assertEqual([p["file"] for p in problems], [".kiro/specs/s/tasks.md", "docs/epics/bad.md"])
        self.assertEqual(problems[0]["reason"], "boom")
        self.assertEqual(groups[0]["cards"][0]["tasks"], None)
        self.assertEqual(groups[0]["cards"][0]["status"], "planned")

    def test_epic_without_stories_is_kept(self):
        groups, _ = build_plan(Memory({"docs/epics/e.md": "# Empty\n"}))
        self.assertEqual(groups, [{"epic": {"name": "Empty", "file": "e.md"}, "cards": []}])


def described(group):
    return [(c["name"], c["description"]) for c in group["cards"]]


class DescriptionTests(unittest.TestCase):
    """Requirement 4: a card's description comes from its story line."""

    def epic(self, *lines, **files):
        source = {"docs/epics/e.md": "# E\n## Stories\n" + "\n".join(lines) + "\n"}
        source.update(files)
        return build_plan(Memory(source))[0]

    def test_description_for_existing_and_missing_spec(self):
        groups = self.epic(
            "- [Real](../../.kiro/specs/real/) — planned. Shows the board.",
            "- [Ghost](../../.kiro/specs/ghost/) — in progress. Has no spec yet.",
            "- Plain — done. Not even a link.",
            **{".kiro/specs/real/tasks.md": "- [ ] 1\n"})
        self.assertEqual(described(groups[0]), [
            ("Real", "Shows the board."), ("Ghost", "Has no spec yet."), ("Plain", "Not even a link.")])
        self.assertIsNotNone(groups[0]["cards"][0]["spec"])
        self.assertIsNone(groups[0]["cards"][1]["spec"])

    def test_description_is_trimmed_and_otherwise_unchanged(self):
        groups = self.epic(
            "- [A](../../.kiro/specs/a/) — planned.    Two  spaces,\ta tab. Then. More... and (parens)!  ",
            "- B — done.\tStarts with a tab. Ends: with a colon;",
            "- C — planned. 'Quoted' — and a dash. Even `code` and *stars*.")
        self.assertEqual(described(groups[0]), [
            ("A", "Two  spaces,\ta tab. Then. More... and (parens)!"),
            ("B", "Starts with a tab. Ends: with a colon;"),
            ("C", "'Quoted' — and a dash. Even `code` and *stars*.")])

    def test_description_in_standalone_is_trimmed(self):
        groups, _ = build_plan(Memory({
            "docs/epics/standalone.md": "- Idea — planned.   Spaced   out. Twice.   \n"}))
        self.assertEqual(described(groups[0]), [("Idea", "Spaced   out. Twice.")])

    def test_no_full_stop_after_the_dash_gives_empty(self):
        groups = self.epic(
            "- [A](../../.kiro/specs/a/) — planned",
            "- B — in progress",
            "- C —",
            "- D — just words with no full stop",
            **{".kiro/specs/a/tasks.md": "- [ ] 1\n"})
        self.assertEqual(described(groups[0]), [("A", ""), ("B", ""), ("C", ""), ("D", "")])

    def test_only_whitespace_after_first_full_stop_gives_empty(self):
        groups = self.epic(
            "- A — planned.",
            "- B — planned.   ",
            "- C — in progress. \t ")
        self.assertEqual(described(groups[0]), [("A", ""), ("B", ""), ("C", "")])

    def test_unlisted_spec_has_empty_description_and_reads_nothing_from_its_files(self):
        source = Memory({
            ".kiro/specs/lonely/tasks.md": "- [x] 1\n",
            ".kiro/specs/lonely/requirements.md": "# Lonely\nIt does one thing. Then another.\n",
            ".kiro/specs/lonely/design.md": "## Overview\nA design. With sentences.\n",
        })
        groups, problems = build_plan(source)
        self.assertEqual(problems, [])
        self.assertEqual(described(groups[0]), [("lonely", "")])
        self.assertIsNone(groups[0]["epic"])

    def test_spec_listed_only_by_an_ignored_line_has_empty_description(self):
        groups, _ = build_plan(Memory({
            ".kiro/specs/s/tasks.md": "- [ ] 1\n",
            ".kiro/specs/t/tasks.md": "- [ ] 1\n",
            ".kiro/specs/u/tasks.md": "- [ ] 1\n",
            ".kiro/specs/s/requirements.md": "It does a thing. Truly.",
            "docs/epics/e.md": "# E\n"
                               "## Stories\n"
                               "- [S](../../.kiro/specs/s/) - planned. A hyphen is not the dash.\n"
                               "- [T](../../.kiro/specs/t/)\n"
                               "\n## Notes\n"
                               "- [U](../../.kiro/specs/u/) — planned. Outside the stories section.\n",
        }))
        self.assertEqual(groups[0]["cards"], [])
        self.assertIsNone(groups[1]["epic"])
        self.assertEqual(described(groups[1]), [("s", ""), ("t", ""), ("u", "")])

    def test_spec_listed_only_by_an_indented_standalone_line_has_empty_description(self):
        groups, _ = build_plan(Memory({
            ".kiro/specs/s/tasks.md": "- [ ] 1\n",
            "docs/epics/standalone.md": "Notes\n  - [S](.kiro/specs/s/) — planned. Nested, so ignored.\n",
        }))
        self.assertEqual(described(groups[0]), [("s", "")])

    def test_spec_in_two_epics_gets_each_lines_description(self):
        groups, _ = build_plan(Memory({
            ".kiro/specs/s/tasks.md": "- [ ] 1\n",
            "docs/epics/a.md": "# A\n## Stories\n- [S](../../.kiro/specs/s/) — planned. First epic's words.\n",
            "docs/epics/b.md": "# B\n## Stories\n- [S](../../.kiro/specs/s/) — in progress. Second epic's words.\n",
            "docs/epics/c.md": "# C\n## Stories\n- [S](../../.kiro/specs/s/) — planned\n",
        }))
        self.assertEqual([g["epic"]["name"] for g in groups], ["A", "B", "C"])
        self.assertEqual(described(groups[0]), [("S", "First epic's words.")])
        self.assertEqual(described(groups[1]), [("S", "Second epic's words.")])
        self.assertEqual(described(groups[2]), [("S", "")])

    def test_standalone_spec_listed_twice_gets_first_lines_description(self):
        groups, _ = build_plan(Memory({
            ".kiro/specs/solo/tasks.md": "- [ ] 1\n",
            "docs/epics/standalone.md": "## Stories\n"
                                        "- [Solo first](.kiro/specs/solo/) — planned. The first line.\n"
                                        "- [Solo second](.kiro/specs/solo/) — planned. The second line.\n",
        }))
        self.assertEqual(len(groups), 1)
        self.assertEqual(described(groups[0]), [("Solo first", "The first line.")])

    def test_standalone_first_line_wins_even_when_its_description_is_empty(self):
        groups, _ = build_plan(Memory({
            ".kiro/specs/solo/tasks.md": "- [ ] 1\n",
            "docs/epics/standalone.md": "- [Solo first](.kiro/specs/solo/) — planned\n"
                                        "- [Solo second](.kiro/specs/solo/) — planned. Later words.\n",
        }))
        self.assertEqual(described(groups[0]), [("Solo first", "")])

    def test_standalone_line_for_a_spec_an_epic_uses_makes_no_card(self):
        groups, _ = build_plan(Memory({
            ".kiro/specs/s/tasks.md": "- [ ] 1\n",
            "docs/epics/e.md": "# E\n## Stories\n- [S](../../.kiro/specs/s/) — planned. The epic's words.\n",
            "docs/epics/standalone.md": "## Stories\n- [S again](.kiro/specs/s/) — planned. Standalone words.\n",
        }))
        self.assertEqual(len(groups), 1)
        self.assertEqual(groups[0]["epic"]["name"], "E")
        self.assertEqual(described(groups[0]), [("S", "The epic's words.")])


if __name__ == "__main__":
    unittest.main()
