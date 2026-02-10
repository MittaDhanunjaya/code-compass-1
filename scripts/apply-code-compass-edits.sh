#!/usr/bin/env bash
# Apply Code Compass propose-fixes edits to a new branch and optionally push.
# Usage:
#   ./scripts/apply-code-compass-edits.sh < edits.json
#   curl -s .../api/ci/propose-fixes?workspaceId=... -d '{"logText":"..."}' | ./scripts/apply-code-compass-edits.sh [--push] [--branch name]
#
# Expects JSON from /api/ci/propose-fixes: { "edits": [ { "path", "newContent", "oldContent"?, "description"? } ] }

set -e
PUSH=""
BRANCH="code-compass-fix-$(date +%Y%m%d-%H%M%S)"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --push) PUSH=1; shift ;;
    --branch) BRANCH="$2"; shift 2 ;;
    *) break ;;
  esac
done

if [ ! -t 0 ]; then
  INPUT="$(cat)"
else
  echo "Paste JSON response from Code Compass propose-fixes (then Ctrl+D):"
  INPUT="$(cat)"
fi

if [ -z "$INPUT" ]; then
  echo "No input. Pipe JSON or paste and press Ctrl+D." >&2
  exit 1
fi

# Extract edits array (jq)
EDITS=$(echo "$INPUT" | jq -c '.edits // empty')
if [ -z "$EDITS" ] || [ "$EDITS" = "null" ]; then
  echo "No edits in response." >&2
  exit 0
fi

git checkout -b "$BRANCH" 2>/dev/null || git checkout "$BRANCH"
EDIT_COUNT=$(echo "$EDITS" | jq 'length')
echo "$EDITS" | jq -c '.[]' | while read -r edit; do
  path=$(echo "$edit" | jq -r '.path')
  if [ -z "$path" ] || [ "$path" = "null" ]; then continue; fi
  mkdir -p "$(dirname "$path")"
  echo "$edit" | jq -r '.newContent // ""' > "$path"
  git add "$path"
done
if [ "${EDIT_COUNT:-0}" -eq 0 ]; then
  echo "No edits to apply."
  exit 0
fi

git commit -m "Apply Code Compass suggested fixes ($EDIT_COUNT file(s))" || true
echo "Branch: $BRANCH, $EDIT_COUNT file(s) updated."
if [ -n "$PUSH" ]; then
  git push -u origin "$BRANCH"
  echo "Pushed to origin/$BRANCH"
fi
