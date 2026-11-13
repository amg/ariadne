# aws-prod's certificate for the hostname: issued by ACM in the edge's
# region, proved through a DNS record at Cloudflare. Kept while aws-prod is
# down.

deploy_cloudflare_core() {
  step "Core: the hostname's certificate in ACM, proved through Cloudflare"
  local zone
  zone="$(cloudflare_zone_id)"
  [[ -n "$zone" ]] || fail "Zone $ZONE_NAME is not visible to this Cloudflare token"
  terraform_init core
  run_terraform core apply -input=false -auto-approve \
    -var "zone_id=$zone" -var "hostname=$HOSTNAME_FQDN" -var "edge_region=$EDGE_REGION" \
    -var "tags={\"$LIFETIME_TAG\"=\"core\",\"$PROJECT_TAG\"=\"$PROJECT\"}"
}
