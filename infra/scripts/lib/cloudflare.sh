# Small Cloudflare API and Terraform helpers.

cloudflare_api() { # <path> [curl args...]
  local path="$1"
  shift
  curl -sS -H "Authorization: Bearer $CLOUDFLARE_API_TOKEN" \
    "https://api.cloudflare.com/client/v4$path" "$@"
}

cloudflare_zone_id() {
  cloudflare_api "/zones?name=$ZONE_NAME" | jq -r '.result[0].id // empty'
}

# The addresses this machine reaches Cloudflare from, as a JSON list.
operator_ips_json() {
  {
    curl -4 -sS --max-time 5 https://cloudflare.com/cdn-cgi/trace || true
    # Machines without IPv6 fail here; that is expected, so it stays quiet.
    curl -6 -sS --max-time 5 https://cloudflare.com/cdn-cgi/trace 2>/dev/null || true
  } | sed -n 's/^ip=//p' | jq -R . | jq -cs .
}

run_terraform() { # <core|app> <terraform args...>
  local root="$INFRA_DIR/cloudflare/$1"
  shift
  terraform -chdir="$root" "$@"
}

# State lives in the vault bucket, whose name carries the account id.
terraform_init() { # <core|app>
  run_terraform "$1" init -input=false -reconfigure \
    -backend-config="bucket=$(vault_bucket)" -backend-config="region=$REGION" >/dev/null
}
