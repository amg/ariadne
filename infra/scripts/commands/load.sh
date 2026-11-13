#!/usr/bin/env bash
# load: run the raised step's load once, then archive the run.
#
# The command does not return before the run is sealed in its folder,
# load/.runs/<run id>/. A run it could not seal is finished with: aws-prod archive <run id>.
# `down` refuses while a run of the raise is unsealed.
#
# The generators reach aws-prod as users do, through CloudFront. The edge
# lets them in by the raise's load key, and does not count their sign-ins
# against its per-address limit.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  stack_exists "$APP_STACK" || fail "Nothing is raised. Run: aws-prod up <step>"
  local step tag
  step="$(stack_tag "$APP_STACK" "$STEP_TAG")"
  tag="$(stack_tag "$APP_STACK" "$IMAGE_TAG_TAG")"
  load_names "$step"
  ((STEP_GENERATORS > 0)) || fail "$step runs no generators, so there is nothing for load to run"
  claim_budget "$step" load
  run_generators "$step" "$tag" load
}

main "$@"; exit
