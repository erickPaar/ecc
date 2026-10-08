#!/usr/bin/env python3
"""PreToolUse(Edit|Write|MultiEdit): ask before an edit weakens a check.

Two ways an agent makes a linter, type checker or test gate pass without fixing
the code: an inline suppression comment, or a looser tool config. This hook
counts both before and after the edit and, when the edit adds any, asks the user
instead of letting it through. Moving or deleting suppressions never asks.
"""
import json
import os
import re
import sys

# Inline comments that silence a tool for a line, a block or a file.
INLINE = {
    "noqa": re.compile(r"#\s*noqa\b", re.I),
    "type: ignore": re.compile(r"#\s*type:\s*ignore\b"),
    "pyrefly: ignore": re.compile(r"#\s*pyrefly:\s*ignore\b"),
    "pylint: disable": re.compile(r"#\s*pylint:\s*disable\b"),
    "pragma: no cover": re.compile(r"#\s*pragma:\s*no\s*cover\b"),
    "nolint": re.compile(r"//\s*nolint\b"),
    "lint:ignore": re.compile(r"//\s*lint:(file-)?ignore\b"),
    "dart ignore": re.compile(r"//\s*ignore(_for_file)?\s*:"),
    "tflint-ignore": re.compile(r"#\s*tflint-ignore\b"),
    "shellcheck disable": re.compile(r"#\s*shellcheck\s+disable\b"),
    "ts-ignore": re.compile(r"@ts-(ignore|expect-error|nocheck)\b"),
    "eslint-disable": re.compile(r"eslint-disable\b"),
}

# Tool configs, and the lines in them that loosen or tighten a check.
CONFIG_FILES = re.compile(
    r"(^|/)(pyproject\.toml|\.?ruff\.toml|pyrefly\.toml|mypy\.ini|setup\.cfg|\.flake8|"
    r"\.importlinter|\.golangci\.ya?ml|analysis_options\.yaml|\.tflint\.hcl|\.shellcheckrc)$"
)
LOOSENS = re.compile(
    r"\b(ignore\w*|per[-_]file[-_]ignores|exclude\w*|disable\w*|skip\w*|allow\w*|"
    r"ignore_errors|ignore_missing_imports|errors\s*:\s*\w+\s*:\s*ignore)\b", re.I
)
TIGHTENS = re.compile(r"\b(select|extend[-_]select|enable\w*|strict\w*|forbidden\w*)\b", re.I)


def inline_counts(text):
    return {name: len(rx.findall(text)) for name, rx in INLINE.items()}


def config_lines(text, rx):
    return [line.strip() for line in text.splitlines() if rx.search(line) and line.strip()]


def before_after(tool, tool_input, path):
    """Return the (old, new) text pairs this edit changes."""
    if tool == "Edit":
        return [(tool_input.get("old_string", ""), tool_input.get("new_string", ""))]
    if tool == "MultiEdit":
        return [(e.get("old_string", ""), e.get("new_string", "")) for e in tool_input.get("edits", [])]
    if tool == "Write":
        try:
            with open(path, encoding="utf-8", errors="ignore") as f:
                old = f.read()
        except OSError:
            old = ""
        return [(old, tool_input.get("content", ""))]
    return []


def findings(path, pairs):
    found = []
    old_all = "\n".join(o for o, _ in pairs)
    new_all = "\n".join(n for _, n in pairs)

    before, after = inline_counts(old_all), inline_counts(new_all)
    for name in INLINE:
        if after[name] > before[name]:
            found.append(f"adds {after[name] - before[name]} `{name}` suppression(s)")

    if CONFIG_FILES.search(path):
        old_loose, new_loose = config_lines(old_all, LOOSENS), config_lines(new_all, LOOSENS)
        added = [line for line in new_loose if line not in old_loose]
        if added:
            found.append("loosens the tool config: " + "; ".join(added[:3]))
        old_tight, new_tight = config_lines(old_all, TIGHTENS), config_lines(new_all, TIGHTENS)
        removed = [line for line in old_tight if line not in new_tight]
        if removed:
            found.append("removes stricter settings: " + "; ".join(removed[:3]))
    return found


def main():
    try:
        data = json.load(sys.stdin)
    except ValueError:
        return
    tool = data.get("tool_name", "")
    tool_input = data.get("tool_input") or {}
    path = tool_input.get("file_path", "")
    if not path:
        return

    found = findings(path, before_after(tool, tool_input, path))
    if not found:
        return

    reason = (
        f"suppression-guard: this edit to {os.path.basename(path)} " + ", ".join(found) + ". "
        "Fix the underlying issue instead, unless silencing it is the right call."
    )
    json.dump({"hookSpecificOutput": {
        "hookEventName": "PreToolUse",
        "permissionDecision": "ask",
        "permissionDecisionReason": reason,
    }}, sys.stdout)


if __name__ == "__main__":
    main()
