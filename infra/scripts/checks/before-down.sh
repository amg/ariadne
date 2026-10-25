# Checks run before a teardown: no run of the raise is left unsealed.

# Refuses while the current raise has a run that began and was never sealed,
# because tearing down would take what is left of its evidence. A raise that
# is not up has nothing to protect.
check_runs_sealed() {
  stack_exists "$APP_STACK" || return 0
  local unsealed
  unsealed="$(archive_harness unsealed --since "$(stack_created "$APP_STACK")")" ||
    fail "Could not read load/.runs/ to see whether every run is sealed. Tear down anyway with --force"
  [[ -z "$unsealed" ]] && return 0
  info "unsealed runs of this raise:"
  while read -r run; do info "  $run"; done <<<"$unsealed"
  fail "Refused: archive them with aws-prod archive <run id>, or tear down anyway with --force"
}
