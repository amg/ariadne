# The Cloudflare side of a raise: hostname, client certificate binding,
# strict TLS, allow-list and sign-in limit. Comes and goes with the app.

edge_up() {
  step "Edge: hostname, client certificate, strict TLS, allow-list, sign-in limit"
  apply_edge apply "$(stack_output "$APP_STACK" "$OUT_ORIGIN_DNS_NAME")"
}

edge_down() {
  step "Edge: removing aws-prod from Cloudflare"
  # Destroying needs the variables declared, not their real values.
  apply_edge destroy "origin.invalid"
}

apply_edge() { # <apply|destroy> <origin dns name>
  local zone client_certificate
  zone="$(cloudflare_zone_id)"
  terraform_init core
  client_certificate="$(run_terraform core output -raw client_certificate_id)"
  terraform_init app

  TF_VAR_run_key="$(parameter "$PARAM_RUN_KEY" 2>/dev/null || echo unset)" \
    run_terraform app "$1" -input=false -auto-approve \
    -var "zone_id=$zone" \
    -var "hostname=$HOSTNAME_FQDN" \
    -var "origin_dns_name=$2" \
    -var "client_certificate_id=$client_certificate" \
    -var "operator_ips=$(operator_ips_json)" \
    -var "load_key_header=$LOAD_KEY_HEADER"
}
