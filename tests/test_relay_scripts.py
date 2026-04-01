import json
import os
import re
import subprocess
import tempfile
import textwrap
import unittest
from pathlib import Path


REPO_ROOT = Path(__file__).resolve().parents[1]
COMPOSE_PROMPT = REPO_ROOT / "scripts" / "relay" / "compose-prompt.sh"
DISPATCH = REPO_ROOT / "scripts" / "relay" / "dispatch.sh"
PLACEHOLDER_RE = re.compile(r"\{[a-z_][a-z0-9_.]*\}")


class RelayScriptTests(unittest.TestCase):
    maxDiff = None

    def run_cmd(self, *args, env=None):
        return subprocess.run(
            args,
            cwd=REPO_ROOT,
            capture_output=True,
            text=True,
            env=env,
            check=False,
        )

    def test_compose_prompt_implement_template_succeeds_without_placeholder_leaks(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            header = tmp_path / "header.md"
            out = tmp_path / "prompt.md"
            relay_root = tmp_path / "relay-root"
            header.write_text("# Worker Header\n", encoding="utf-8")

            result = self.run_cmd(
                str(COMPOSE_PROMPT),
                "--header",
                str(header),
                "--template",
                "implement",
                "--root",
                str(relay_root),
                "--out",
                str(out),
            )

            self.assertEqual(result.returncode, 0, msg=result.stderr)
            contents = out.read_text(encoding="utf-8")
            self.assertIn("# Implementation Worker", contents)
            self.assertIsNone(PLACEHOLDER_RE.search(contents), msg=contents)

    def test_compose_prompt_other_builtin_templates_do_not_leak_placeholders(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            header = tmp_path / "header.md"
            header.write_text("# Worker Header\n", encoding="utf-8")

            for template in ("review", "ship-review", "converge"):
                with self.subTest(template=template):
                    out = tmp_path / f"{template}.md"
                    relay_root = tmp_path / f"{template}-relay-root"

                    result = self.run_cmd(
                        str(COMPOSE_PROMPT),
                        "--header",
                        str(header),
                        "--template",
                        template,
                        "--root",
                        str(relay_root),
                        "--out",
                        str(out),
                    )

                    self.assertEqual(result.returncode, 0, msg=result.stderr)
                    contents = out.read_text(encoding="utf-8")
                    self.assertIsNone(PLACEHOLDER_RE.search(contents), msg=contents)

    def test_compose_prompt_legacy_relay_protocol_fallback_does_not_leak_placeholders(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            header = tmp_path / "header.md"
            out = tmp_path / "prompt.md"
            relay_root = tmp_path / "relay-root"
            header.write_text("# Worker Header\n", encoding="utf-8")

            result = self.run_cmd(
                str(COMPOSE_PROMPT),
                "--header",
                str(header),
                "--root",
                str(relay_root),
                "--out",
                str(out),
            )

            self.assertEqual(result.returncode, 0, msg=result.stderr)
            contents = out.read_text(encoding="utf-8")
            self.assertIn("# Relay Protocol", contents)
            self.assertIsNone(PLACEHOLDER_RE.search(contents), msg=contents)

    def test_compose_prompt_fails_for_unresolved_placeholder_outside_code_fence(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            header = tmp_path / "header.md"
            out = tmp_path / "prompt.md"
            header.write_text("# Worker Header\nUse {mystery_token}.\n", encoding="utf-8")

            result = self.run_cmd(
                str(COMPOSE_PROMPT),
                "--header",
                str(header),
                "--out",
                str(out),
            )

            self.assertNotEqual(result.returncode, 0)
            self.assertIn("{mystery_token}", result.stderr)
            self.assertIn("header.md", result.stderr)

    def test_compose_prompt_ignores_placeholders_inside_fenced_code_blocks(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            header = tmp_path / "header.md"
            out = tmp_path / "prompt.md"
            # Include inline relay sections so relay-protocol.md (which has
            # bare placeholders outside code fences) is not appended.
            header.write_text(
                textwrap.dedent(
                    """\
                    # Worker Header

                    ```text
                    {example_token}
                    ```

                    ### Files Changed
                    None yet.

                    ### Tests Run
                    None yet.

                    ### Completion Claim
                    TBD
                    """
                ),
                encoding="utf-8",
            )

            result = self.run_cmd(
                str(COMPOSE_PROMPT),
                "--header",
                str(header),
                "--out",
                str(out),
            )

            self.assertEqual(result.returncode, 0, msg=result.stderr)

    def test_dispatch_agent_backend_emits_json_receipt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            prompt = tmp_path / "prompt.md"
            output = tmp_path / "last-message.txt"
            prompt.write_text('# Worker Task\nLine "two"\n', encoding="utf-8")

            result = self.run_cmd(
                str(DISPATCH),
                "--prompt",
                str(prompt),
                "--output",
                str(output),
                "--backend",
                "agent",
            )

            self.assertEqual(result.returncode, 0, msg=result.stderr)
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt["backend"], "agent")
            self.assertEqual(receipt["status"], "ready")
            self.assertEqual(receipt["prompt_file"], str(prompt))
            self.assertEqual(receipt["output_file"], str(output))
            self.assertEqual(receipt["agent_params"]["description"], "Worker Task")
            self.assertEqual(receipt["agent_params"]["prompt"], '# Worker Task\nLine "two"\n')
            self.assertEqual(receipt["agent_params"]["isolation"], "worktree")

    def test_dispatch_custom_backend_emits_json_receipt(self):
        with tempfile.TemporaryDirectory() as tmpdir:
            tmp_path = Path(tmpdir)
            prompt = tmp_path / "prompt.md"
            output = tmp_path / "last-message.txt"
            backend = tmp_path / "custom-backend.sh"
            prompt.write_text("first non-empty line\n", encoding="utf-8")
            backend.write_text(
                textwrap.dedent(
                    """\
                    #!/usr/bin/env bash
                    set -euo pipefail
                    cp "$1" "$2"
                    """
                ),
                encoding="utf-8",
            )
            backend.chmod(0o755)

            result = self.run_cmd(
                str(DISPATCH),
                "--prompt",
                str(prompt),
                "--output",
                str(output),
                "--backend",
                str(backend),
            )

            self.assertEqual(result.returncode, 0, msg=result.stderr)
            receipt = json.loads(result.stdout)
            self.assertEqual(receipt["backend"], "custom")
            self.assertEqual(receipt["status"], "dispatched")
            self.assertEqual(receipt["command"], str(backend))
            self.assertEqual(receipt["prompt_file"], str(prompt))
            self.assertEqual(receipt["output_file"], str(output))
            self.assertEqual(output.read_text(encoding="utf-8"), "first non-empty line\n")


if __name__ == "__main__":
    unittest.main()
