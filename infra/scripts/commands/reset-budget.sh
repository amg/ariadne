#!/usr/bin/env bash
# reset-budget: clears today's budget ledger and deletes the load stack if it exists
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  
  step "Resetting today's budget ledger"
  local bucket
  bucket="$(vault_bucket)"
  if [[ -n "$bucket" ]]; then
    aws s3 rm "s3://$bucket/ledger/$(date -u +%F).json" 2>/dev/null || true
    info "Cleared ledger/$(date -u +%F).json from $bucket"
  else
    fail "Could not determine vault bucket name"
  fi

  step "Deleting load stack if it exists"
  if stack_exists "$LOAD_STACK"; then
    delete_stack "$LOAD_STACK"
  else
    info "Load stack does not exist"
  fi
  
  step "Done! You can now run the load test again."
}

main "$@"; exit
