"""Cross-check: count errored tool calls in a Claude Code JSONL transcript.

Reuses tracelens's CLAUDE_STAGE field semantics (which fields mark a tool call
as an error) so Turbella's reader can be validated against tracelens on the same
fixture. Pure stdlib — no duckdb needed for this count.

Usage: tracelens_count.py <claude.jsonl>
"""
import json
import sys


def count_errors(path):
    n = 0
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            line = line.strip()
            if not line:
                continue
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            # tool_result block inside an assistant message
            blocks = (msg.get("message") or {}).get("content") or []
            if isinstance(blocks, list):
                for b in blocks:
                    if b.get("type") == "tool_result" and b.get("is_error") is True:
                        n += 1
            # separate `type: "tool"` message carrying a tool_result
            if msg.get("type") == "tool" and msg.get("is_error") is True:
                n += 1
    return n


if __name__ == "__main__":
    print(count_errors(sys.argv[1]))
