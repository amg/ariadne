# Sourced first by every command: strict mode, every helper, check and step,
# and argument handling.
#
# A command's header comment is its help. Its body is a main function called
# on the file's last line (`main "$@"; exit`), so bash has read the whole file
# before it runs and editing a command mid-run cannot derail its end.
set -euo pipefail

SCRIPTS_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
# shellcheck disable=SC2034 # read by the commands that run other commands
COMMANDS_DIR="$SCRIPTS_DIR/commands"

for file in "$SCRIPTS_DIR"/lib/{common,aws,cloudflare}.sh "$SCRIPTS_DIR"/checks/*.sh "$SCRIPTS_DIR"/steps/*.sh "$SCRIPTS_DIR"/steps/*/*.sh; do
  # shellcheck source=/dev/null
  source "$file"
done

# Answers --help, refuses a wrong number of arguments (so a stray word never
# runs a command), then loads the shared names.
begin() { # <min args> <max args> <args...>
  local min="$1" max="$2"
  shift 2
  if [[ "${1:-}" == -h || "${1:-}" == --help ]]; then
    command_help
    exit 0
  fi
  if (($# < min || $# > max)); then
    command_help >&2
    fail "Wrong number of arguments"
  fi
  load_names
}

# The running command's header comment, without its comment marks.
command_help() {
  awk 'NR == 1 { next } !/^#/ { exit } { sub(/^# ?/, ""); print }' "$0"
}
