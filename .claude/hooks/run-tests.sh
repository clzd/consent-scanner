#!/bin/bash
# PostToolUse hook: run the test suite after any file edit inside the project.
# On failure, exit 2 so the test output is fed back to Claude.
f=$(jq -r '.tool_input.file_path // .tool_response.filePath // empty')
root="${CLAUDE_PROJECT_DIR:-$(cd "$(dirname "$0")/../.." && pwd)}"
case "$f" in
  "$root"/node_modules/*) exit 0 ;;
  "$root"/*) ;;
  *) exit 0 ;;
esac
cd "$root" || exit 0
if ! out=$(npm test --silent 2>&1); then
  { echo "Tests failed after editing ${f#$root/}:"; echo "$out" | grep -vE '^\s*(at |node:internal)' | tail -80; } >&2
  exit 2
fi
echo "$out" | grep -E '^ℹ (pass|fail) '
