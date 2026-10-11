#!/usr/bin/env bash
# load: run the raised step's load once, then print its summary.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  stack_exists "$APP_STACK" || fail "Nothing is raised. Run: aws-prod up <step>"
  local step tag
  step="$(stack_tag "$APP_STACK" "$STEP_TAG")"
  tag="$(stack_tag "$APP_STACK" "$IMAGE_TAG_TAG")"
  load_names "$step"
  claim_budget "$step" load
  run_generators "$step" "$tag" load
}

main "$@"; exit
