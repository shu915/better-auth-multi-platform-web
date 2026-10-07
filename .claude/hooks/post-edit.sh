#!/usr/bin/env bash
# PostToolUse(Edit|Write|MultiEdit): 編集したファイルだけ ESLint を通す
set -u
input=$(cat)
path=$(jq -r '.tool_input.file_path // ""' <<<"$input")
[[ "$path" =~ \.(ts|tsx|mts|mjs)$ && -f "$path" ]] || exit 0
cd "${CLAUDE_PROJECT_DIR:-$PWD}" || exit 0
out=$(npx --no-install eslint --no-warn-ignored "$path" 2>&1) && exit 0
{ echo "ESLint failed: $path"; tail -n 40 <<<"$out"; } >&2
exit 2
