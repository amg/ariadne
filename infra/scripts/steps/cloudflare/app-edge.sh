# The hostname at Cloudflare: a DNS record pointing at the distribution.
# When taken down, the hostname is parked at 192.0.2.1 so local resolvers
# never receive or cache NXDOMAIN.

edge_up() {
  step "Edge: the hostname, pointing at the distribution"
  apply_edge apply "$(stack_output "$APP_STACK" "$OUT_DISTRIBUTION_DOMAIN_NAME")" "false"
}

edge_down() {
  step "Edge: parking the hostname at 192.0.2.1"
  apply_edge apply "distribution.invalid" "true"
}

# Completely destroys all Cloudflare resources including the parked DNS record.
edge_purge() {
  step "Edge: removing aws-prod completely from Cloudflare"
  apply_edge destroy "distribution.invalid" "false"
}

apply_edge() { # <apply|destroy> <distribution dns name> [parked: true|false]
  local action="$1" distribution="$2" parked="${3:-false}"
  local zone
  zone="$(cloudflare_zone_id)"
  terraform_init app

  run_terraform app "$action" -input=false -auto-approve \
    -var "zone_id=$zone" \
    -var "hostname=$HOSTNAME_FQDN" \
    -var "distribution_dns_name=$distribution" \
    -var "parked=$parked"
}
