#!/usr/bin/env bash
# up <step>: raise aws-prod at a step, ready for a load run.
#
# Builds and pushes images, deploys the edge rules and the app stack (about
# twenty minutes), warms a restored database, points the hostname at the
# distribution, and checks that it answers at the hostname only. Preflight,
# the daily worst-case limit or the account's Fargate vCPU quotas refuse the
# raise before anything is created. The distribution takes some minutes to
# create, and as long again to remove on teardown.
#
# A step that restores the seed restores the newest seed snapshot available.
#
# After a failure, run it again to resume: an app already up at the same
# step keeps its images, run key and seed, and every later step is repeated.
# To run changed code, take it down first.
#
# Steps: seed smoke step10 scale10 step50 step100
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 1 1 "$@"
  local step="$1" tag seed=""
  require_step "$step"
  load_names "$step"
  preflight "$step"

  if stack_exists "$APP_STACK"; then
    [[ "$(stack_tag "$APP_STACK" "$STEP_TAG")" == "$step" ]] ||
      fail "aws-prod is up at another step. Run: aws-prod down"
    tag="$(stack_tag "$APP_STACK" "$IMAGE_TAG_TAG")"
    seed="$(raised_seed_snapshot)"
    step "Resuming the raise at step $step, images $tag"
  else
    claim_budget "$step" raise
    if [[ "$STEP_DB_SOURCE" == "seedSnapshot" ]]; then
      seed="$(latest_seed_snapshot)"
    fi
    tag="$(new_image_tag)"
    build_and_push_images "$tag"
    mint_run_key
  fi

  edge_rules_up
  app_up "$step" "$tag" "$seed"
  [[ "$STEP_DB_SOURCE" == "seedSnapshot" ]] && warm_database
  edge_up
  verify_raise

  step "aws-prod is up at step $step"
  info "https://$HOSTNAME_FQDN"
  info "the safety net deletes it four hours after $(stack_created "$APP_STACK")"
  info "next: aws-prod load, then aws-prod down"
}

main "$@"; exit
