#!/usr/bin/env bash
# River Watch - save new data to the repository without merge conflicts.
# Copies every data file this run changed onto the newest main, then pushes. Retries a few times
# in case another run saved in between. Usage: save.sh "commit message"
set -u
MSG="${1:-River Watch data}"
cd "$(git rev-parse --show-toplevel)"
git config user.name "river-watch-bot"
git config user.email "41898282+github-actions[bot]@users.noreply.github.com"
git rebase --abort >/dev/null 2>&1 || true
git add -A river-watch/data
CHANGED=$(git diff --cached --name-only --diff-filter=AMR -- river-watch/data)
if [ -z "$CHANGED" ]; then echo "Nothing new to save."; exit 0; fi
KEEP=$(mktemp -d)
printf '%s\n' "$CHANGED" | while IFS= read -r f; do mkdir -p "$KEEP/$(dirname "$f")"; cp -p "$f" "$KEEP/$f"; done
echo "Saving $(printf '%s\n' "$CHANGED" | wc -l) changed files."
for attempt in 1 2 3 4 5; do
  git fetch -q origin main && git reset -q --hard origin/main && git clean -qfd -- river-watch/data
  cp -a "$KEEP/." .
  git add -A river-watch/data
  if git diff --cached --quiet; then echo "Already up to date."; exit 0; fi
  git commit -q -m "$MSG"
  if git push -q origin HEAD:main; then echo "Saved on attempt $attempt."; exit 0; fi
  echo "Push failed (attempt $attempt), retrying."; sleep $((attempt * 5))
done
echo "Could not save after 5 attempts."; exit 1
