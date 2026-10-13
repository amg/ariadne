# The Cloudflare side of a raise: hostname, client certificate binding,
# strict TLS, allow-list and sign-in limit. When taken down, the hostname
# is parked at 192.0.2.1 so local resolvers never receive or cache NXDOMAIN.

edge_up() {
  step "Edge: hostname, client certificate, strict TLS, allow-list, sign-in limit"
  apply_edge apply "$(stack_output "$APP_STACK" "$OUT_ORIGIN_DNS_NAME")" "false"
}

edge_down() {
  step "Edge: parking hostname at 192.0.2.1 and releasing phase rules"
  apply_edge apply "origin.invalid" "true"
}

# Completely destroys all Cloudflare resources including the parked DNS record.
edge_purge() {
  step "Edge: removing aws-prod completely from Cloudflare"
  apply_edge destroy "origin.invalid" "false"
}

apply_edge() { # <apply|destroy> <origin dns name> [parked: true|false]
  local action="$1" origin="$2" parked="${3:-false}"
  local zone client_certificate
  zone="$(cloudflare_zone_id)"
  terraform_init core
  client_certificate="$(run_terraform core output -raw client_certificate_id)"
  terraform_init app

  TF_VAR_run_key="$(parameter "$PARAM_RUN_KEY" 2>/dev/null || echo unset)" \
    run_terraform app "$action" -input=false -auto-approve \
    -var "zone_id=$zone" \
    -var "hostname=$HOSTNAME_FQDN" \
    -var "origin_dns_name=$origin" \
    -var "client_certificate_id=$client_certificate" \
    -var "operator_ips=$(operator_ips_json)" \
    -var "load_key_header=$LOAD_KEY_HEADER" \
    -var "parked=$parked"
}
