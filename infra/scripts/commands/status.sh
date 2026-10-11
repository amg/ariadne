#!/usr/bin/env bash
# status: what is up, since when, and today's worst-case ledger.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  step "Stacks"
  local stack
  for stack in "$CORE_STACK" "$APP_STACK" "$LOAD_STACK"; do
    if stack_exists "$stack"; then
      info "$stack  up since $(stack_created "$stack")"
    else
      info "$stack  down"
    fi
  done
  if stack_exists "$APP_STACK"; then
    info "step $(stack_tag "$APP_STACK" "$STEP_TAG"), images $(stack_tag "$APP_STACK" "$IMAGE_TAG_TAG")"
  fi
  step "Today's worst-case ledger"
  show_ledger
}

main "$@"; exit
