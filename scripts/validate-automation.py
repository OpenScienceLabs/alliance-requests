#!/usr/bin/env python3
"""Validate workflow YAML, embedded JavaScript, and repository script syntax.

Requires PyYAML 6, Node.js, and bash. Validation never executes workflow scripts.
"""

from __future__ import annotations

import ast
import subprocess
import tomllib
from pathlib import Path

import yaml


class UniqueKeyLoader(yaml.SafeLoader):
    """Reject duplicate mapping keys rather than silently dropping configuration."""


def unique_mapping(loader: UniqueKeyLoader, node: yaml.MappingNode) -> dict:
    mapping = {}
    for key_node, value_node in node.value:
        key = loader.construct_object(key_node)
        if key in mapping:
            raise yaml.constructor.ConstructorError(
                "while reading a mapping", node.start_mark,
                f"duplicate key: {key}", key_node.start_mark,
            )
        mapping[key] = loader.construct_object(value_node)
    return mapping


UniqueKeyLoader.add_constructor(yaml.resolver.BaseResolver.DEFAULT_MAPPING_TAG, unique_mapping)


def main() -> None:
    for path in sorted(Path(".github").rglob("*.yml")):
        workflow = yaml.load(path.read_text(), Loader=UniqueKeyLoader)
        if path.parent.name != "workflows":
            continue
        # SafeLoader treats the YAML 1.2 key `on` as YAML 1.1's boolean True.
        if not isinstance(workflow, dict) or not isinstance(workflow.get("jobs"), dict) or not (
            "on" in workflow or True in workflow
        ):
            raise ValueError(f"{path}: workflow requires event triggers and jobs")
        for job in workflow["jobs"].values():
            for step in job.get("steps", []):
                if step.get("uses", "").startswith("actions/github-script@"):
                    subprocess.run(
                        ["node", "-e", "new (Object.getPrototypeOf(async function(){}).constructor)(require('node:fs').readFileSync(0, 'utf8'))"],
                        input=step["with"]["script"], text=True, check=True,
                    )
        print(f"Validated {path}")
    for path in sorted(Path("scripts").glob("*.py")):
        ast.parse(path.read_text(), filename=str(path))
    for pattern, command in [("*.cjs", ["node", "--check"]), ("*.sh", ["bash", "-n"])]:
        for path in sorted(Path("scripts").glob(pattern)):
            subprocess.run([*command, str(path)], check=True)
    tomllib.loads(Path(".lychee.toml").read_text())
    print("Workflow YAML, embedded JavaScript, script syntax, and link-check configuration passed.")


if __name__ == "__main__":
    main()
