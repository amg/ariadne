#!/usr/bin/env bash
# load-image: build the load generators' image alone, for the next run to use.
#
# A fix to the generators then costs one image, not a whole raise. The image
# is pushed under a fresh tag, and every run from now on, until the raise goes
# down, starts its generators on it: `load` deploys the generators' stack
# with that tag before it starts them, and the run's record names it.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  require_tools aws docker git
  check_signed_in
  stack_exists "$APP_STACK" || fail "Nothing is raised. Run: aws-prod up <step>"
  local step tag
  step="$(stack_tag "$APP_STACK" "$STEP_TAG")"
  load_names "$step"
  ((STEP_GENERATORS > 0)) || fail "$step runs no generators, so there is no image to replace"
  tag="$(new_image_tag)"
  build_and_push_load_image "$tag"
  step "The next run's generators use load image $tag"
  info "next: aws-prod load"
}

main "$@"; exit
