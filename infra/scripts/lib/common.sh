# Names and output, shared by every command and step.

INFRA_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
# shellcheck disable=SC2034 # read by the steps sourced alongside this file
REPO_DIR="$(cd "$INFRA_DIR/.." && pwd)"

# ── Names ────────────────────────────────────────────────────────────────

# Reads the shared names (and a step's settings, when given) from config/,
# which in turn takes the operator's hostname, zone and project from the
# repository-root .env.
load_names() { # [step]
  local names
  names="$(cd "$INFRA_DIR" && npx --no-install tsx bin/shellNames.ts ${1:+"$1"})"
  eval "$names"
  export AWS_REGION="$REGION"
  export AWS_PROFILE="${AWS_PROFILE:-$PROJECT}"
}

require_step() { # <step>
  [[ " $STEP_NAMES " == *" ${1:-} "* ]] || fail "Name a step: $STEP_NAMES"
}

# ── Output ───────────────────────────────────────────────────────────────

step() { printf '\n\033[1m▶ %s\033[0m\n' "$*"; }
info() { printf '  %s\n' "$*"; }
fail() {
  printf '\033[31m✖ %s\033[0m\n' "$*" >&2
  exit 1
}
