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
