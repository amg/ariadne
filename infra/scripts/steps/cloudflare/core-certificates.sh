# aws-prod's origin identity at Cloudflare: the origin certificate and the
# client certificate Cloudflare presents. Kept while aws-prod is down.

deploy_cloudflare_core() {
  step "Core: origin certificate and client certificate at Cloudflare"
  local zone
  zone="$(cloudflare_zone_id)"
  [[ -n "$zone" ]] || fail "Zone $ZONE_NAME is not visible to this Cloudflare token"
  terraform_init core
  run_terraform core apply -input=false -auto-approve \
    -var "zone_id=$zone" -var "hostname=$HOSTNAME_FQDN"
}
