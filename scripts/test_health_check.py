"""Regression checks for reporting missing health-check configuration as failure."""

from __future__ import annotations

import contextlib
import importlib.util
import io
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

SCRIPT_DIR = Path(__file__).resolve().parent
SPEC = importlib.util.spec_from_file_location("health_check", SCRIPT_DIR / "check-affiliated-projects.py")
health_check = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = health_check
SPEC.loader.exec_module(health_check)


class RegistryGuardTests(unittest.TestCase):
    def run_check(self, contents: str | None, *, required: bool = True) -> tuple[int, str]:
        with tempfile.TemporaryDirectory(dir=SCRIPT_DIR) as directory:
            source = Path(directory) / "projects.json"
            report = Path(directory) / "report.md"
            if contents is not None:
                source.write_text(contents)
            args = ["--source", str(source), "--output", str(report)]
            if required:
                args.append("--require-projects")
            with contextlib.redirect_stdout(io.StringIO()), contextlib.redirect_stderr(io.StringIO()):
                code = health_check.main(args)
            return code, report.read_text()

    def test_missing_registry_fails_and_preserves_explanation(self) -> None:
        code, report = self.run_check(None)
        self.assertEqual(code, 1)
        self.assertIn("No projects were checked", report)
        self.assertIn("does not exist", report)

    def test_empty_and_malformed_registries_fail(self) -> None:
        for contents in [
            '{"projects": []}', '{invalid json', '{"projects": ["invalid entry"]}',
            '{"projects": null}', '{"projects": {}}', '{"projects": 5}',
        ]:
            with self.subTest(contents=contents):
                code, _ = self.run_check(contents)
                self.assertEqual(code, 1)

    def test_report_only_mode_remains_available(self) -> None:
        code, report = self.run_check(None, required=False)
        self.assertEqual(code, 0)
        self.assertIn("No projects were checked", report)

    def test_configured_registry_reaches_report_generation(self) -> None:
        with patch.object(health_check, "render_report", return_value="Configured project report") as render:
            code, report = self.run_check(json.dumps({"projects": [{"repository": "https://github.com/example/project"}]}))
        self.assertEqual(code, 0)
        self.assertEqual(report, "Configured project report")
        self.assertEqual(len(render.call_args.args[0]), 1)


if __name__ == "__main__":
    unittest.main()
