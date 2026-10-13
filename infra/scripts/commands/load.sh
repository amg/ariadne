#!/usr/bin/env bash
# load [--direct]: run the raised step's load once, then print its summary.
#
# By default the generators reach aws-prod through Cloudflare, as users do.
#
# --direct  skips Cloudflare, to measure aws-prod alone. Generators present
#           their own client certificate to the load balancer, which lets
#           their addresses through for the length of the run only: the
#           addresses close when the run ends, fails or is interrupted.
# --close   closes the direct path without running anything, for a run
#           that could not close it itself (sweep reports one).
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 1 "$@"
  local option="${1:-}" path=edge
  case "$option" in
    "") ;;
    --direct) path=direct ;;
    --close)
      step "Load: closing the direct path"
      close_direct_path
      return 0
      ;;
    *) command_help >&2 && fail "Unknown option: $option" ;;
  esac
  stack_exists "$APP_STACK" || fail "Nothing is raised. Run: aws-prod up <step>"
  local step tag
  step="$(stack_tag "$APP_STACK" "$STEP_TAG")"
  tag="$(stack_tag "$APP_STACK" "$IMAGE_TAG_TAG")"
  load_names "$step"
  claim_budget "$step" load
  run_generators "$step" "$tag" load "$path"
}

main "$@"; exit
