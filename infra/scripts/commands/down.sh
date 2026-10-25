#!/usr/bin/env bash
# down [--force]: tear everything down (load, edge, app), then sweep; core stays.
#
# Refused while the current raise has a run that was never sealed: archive
# it first. --force tears down anyway, and what the run's
# archive still needed from the raise (the database's Performance Insights,
# the tasks' stop reasons) is lost.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 1 "$@"
  case "${1:-}" in
    "") check_runs_sealed ;;
    --force) ;;
    *) command_help >&2 && fail "Unknown option: $1" ;;
  esac
  delete_stack "$LOAD_STACK"
  edge_down
  delete_stack "$APP_STACK"
  "$COMMANDS_DIR/sweep.sh"
  step "aws-prod is down; core stays"
}

main "$@"; exit
