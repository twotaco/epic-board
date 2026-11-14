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


if __name__ == "__main__":
    unittest.main()
