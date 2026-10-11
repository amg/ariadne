#!/usr/bin/env bash
# core: CDK bootstrap, the core stack, and aws-prod's identity at Cloudflare.
#
# Run once per account, and again whenever core's definition changes; every
# step is repeatable. Needs CLOUDFLARE_API_TOKEN.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  require_tools aws terraform jq curl node
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || fail "CLOUDFLARE_API_TOKEN is not set"
  check_signed_in

  bootstrap_cdk
  deploy_core_stack
  deploy_cloudflare_core
  import_origin_certificate
  publish_client_authority
}

main "$@"; exit
