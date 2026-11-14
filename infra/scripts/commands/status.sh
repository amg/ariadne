#!/usr/bin/env bash
# status: what is up, since when, and today's worst-case ledger.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  step "Stacks"
  local stack
  for stack in "$CORE_STACK" "$APP_STACK" "$LOAD_STACK"; do
    stack_status "$stack"
  done
  (export AWS_REGION="$EDGE_REGION" && stack_status "$EDGE_RULES_STACK")
  if stack_exists "$APP_STACK"; then
    info "step $(stack_tag "$APP_STACK" "$STEP_TAG"), images $(stack_tag "$APP_STACK" "$IMAGE_TAG_TAG")"
  fi
  step "Today's worst-case ledger"
  show_ledger
}

stack_status() { # <stack>
  if stack_exists "$1"; then
    info "$1  up since $(stack_created "$1")"
  else
    info "$1  down"
  fi
}

main "$@"; exit
