#!/usr/bin/env bash
# down: tear everything down (load, edge, app), then sweep; core stays.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  delete_stack "$LOAD_STACK"
  edge_down
  delete_stack "$APP_STACK"
  "$COMMANDS_DIR/sweep.sh"
  step "aws-prod is down; core stays"
}

main "$@"; exit
