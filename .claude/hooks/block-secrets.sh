#!/usr/bin/env bash
# Claude Code PreToolUse hook: blocks writes to secret files.
# Write/Edit/MultiEdit: checks tool_input.file_path.
# Bash: blocks commands that name a secret file AND write something (>, tee, cp, mv, rm, sed -i, ...).
# Exit 2 blocks the tool call and shows the stderr message to Claude. Exit 0 allows it.

shopt -s nocasematch
set -f # no glob expansion when splitting a command into words

# Succeeds if the path is a secret file. Templates like .env.example are allowed.
is_secret() {
  case "${1##*/}" in
    .env.example | .env.sample | .env.template) return 1 ;;
    .env | .env.* | *.pem | *.key | *.p12 | id_rsa*) return 0 ;;
  esac
  # Leading slash so a relative path like secrets/db.txt still matches /secrets/.
  case "/$1" in
    */secrets/* | *credentials*) return 0 ;;
  esac
  return 1
}

input="$(cat)"

if command -v jq >/dev/null 2>&1; then
  tool="$(printf '%s' "$input" | jq -r '.tool_name // empty' 2>/dev/null)"
  file_path="$(printf '%s' "$input" | jq -r '.tool_input.file_path // empty' 2>/dev/null)"
  cmd="$(printf '%s' "$input" | jq -r '.tool_input.command // empty' 2>/dev/null)"
else
  json_string() {
    printf '%s' "$input" | sed -nE "s/.*\"$1\"[[:space:]]*:[[:space:]]*\"(([^\"\\\\]|\\\\.)*)\".*/\\1/p" | head -n 1
  }
  tool="$(json_string tool_name)"
  file_path="$(json_string file_path)"
  cmd="$(json_string command)"
fi

if [ -n "$file_path" ] && is_secret "$file_path"; then
  echo "Blocked: $file_path is a secret file. Edit it by hand outside Claude." >&2
  exit 2
fi

if [ "$tool" = "Bash" ] && [ -n "$cmd" ]; then
  # Ignore harmless redirects like 2>&1 and >/dev/null, then look for anything that writes.
  cleaned="$(printf '%s' "$cmd" | sed -E 's/[0-9]*>&[0-9]+//g; s/[0-9]*>+[[:space:]]*\/dev\/null//g')"
  writes='>|(^|[^[:alnum:]_.-])(tee|cp|mv|rsync|install|dd|truncate|touch|rm|ln)([^[:alnum:]_.-]|$)|(sed|perl)[^|;&]*[[:space:]]-[[:alnum:]]*i'
  if printf '%s' "$cleaned" | grep -Eq "$writes"; then
    for word in $(printf '%s' "$cleaned" | tr $';|&<>()"\'`=,{}\\\\' ' '); do
      if is_secret "$word"; then
        echo "Blocked: this command writes while touching $word, a secret file. Run it by hand outside Claude." >&2
        exit 2
      fi
    done
  fi
fi

exit 0
