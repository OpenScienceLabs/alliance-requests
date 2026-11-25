"""Exercise the actual GitHub workflow script at its publishing/preview boundary."""

from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path

import yaml


class WorkflowModeTests(unittest.TestCase):
    def run_adapter(self, preview: bool | str | None, *, default_branch: bool) -> dict:
        workflow = yaml.safe_load(Path(".github/workflows/affiliation-review.yml").read_text())
        script = next(step["with"]["script"] for step in workflow["jobs"]["review"]["steps"]
                      if step.get("uses", "").startswith("actions/github-script@"))
        inputs = {"issue_number": "1"}
        if preview is not None:
            inputs["preview"] = preview
        request = {
            "script": script,
            "context": {
                "ref": "refs/heads/main", "eventName": "workflow_dispatch",
                "repo": {"owner": "OpenScienceLabs", "repo": "alliance-requests"},
                "payload": {"inputs": inputs, "repository": {"default_branch": "main"} if default_branch else {}},
            },
        }
        driver = """
const input = JSON.parse(require('node:fs').readFileSync(0, 'utf8'));
const calls = [];
const logs = [];
const nativeRequire = require;
const fakeRequire = name => name === './scripts/review-affiliation.cjs'
  ? {run: async options => calls.push({publish: options.publish})} : nativeRequire(name);
const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
process.env.RUNNER_TEMP = '.';
new AsyncFunction('github', 'context', 'core', 'require', input.script)(
  {}, input.context, {info: message => logs.push(message)}, fakeRequire
).then(() => process.stdout.write(JSON.stringify({calls, logs})));
"""
        result = subprocess.run(["node", "-e", driver], input=json.dumps(request),
                                text=True, capture_output=True, check=True)
        return json.loads(result.stdout)

    def test_main_publishes_without_optional_default_branch_payload_metadata(self) -> None:
        for value in [None, False, "false"]:
            with self.subTest(preview=value):
                result = self.run_adapter(value, default_branch=False)
                self.assertEqual(result["calls"], [{"publish": True}])
                self.assertIn("Review mode: publish", result["logs"][0])

    def test_explicit_preview_never_publishes(self) -> None:
        for value in [True, "true"]:
            with self.subTest(preview=value):
                result = self.run_adapter(value, default_branch=True)
                self.assertEqual(result["calls"], [{"publish": False}])
                self.assertIn("Review mode: preview", result["logs"][0])


if __name__ == "__main__":
    unittest.main()
