#!/usr/bin/env bash
# load [--edge]: run the raised step's load once, then archive the run.
#
# The command does not return before the run is sealed in its folder,
# load/.runs/<run id>/. A run it could not seal is finished with: aws-prod archive <run id>.
# `down` refuses while a run of the raise is unsealed.
#
# By default the generators take the direct path, skipping Cloudflare to
# measure aws-prod alone. Generators present their own client certificate
# to the load balancer, which lets in their one public address for as long
# as their stack lives.
#
# --edge    routes generators through Cloudflare, as real users do. Bot
#           Fight Mode must be off, or Cloudflare challenges the generators.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 1 "$@"
  local path=direct
  case "${1:-}" in
    "") ;;
    --edge) path=edge ;;
    *) command_help >&2 && fail "Unknown option: $1" ;;
  esac

  stack_exists "$APP_STACK" || fail "Nothing is raised. Run: aws-prod up <step>"
  local step tag
  step="$(stack_tag "$APP_STACK" "$STEP_TAG")"
  tag="$(stack_tag "$APP_STACK" "$IMAGE_TAG_TAG")"
  load_names "$step"
  ((STEP_GENERATORS > 0)) || fail "$step runs no generators, so there is nothing for load to run"
  if [[ "$path" == edge ]]; then
    [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || fail "CLOUDFLARE_API_TOKEN is not set"
    check_bot_fight_mode_off
  fi
  claim_budget "$step" load
  run_generators "$step" "$tag" load "$path"
}

main "$@"; exit
