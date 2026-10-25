# Checks that refuse a raise before anything is created or spent.

preflight() { # <step>
  step "Preflight"
  require_tools aws docker terraform jq curl openssl git node
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || fail "CLOUDFLARE_API_TOKEN is not set"
  check_signed_in
  check_core_is_up
  check_cloudflare_ranges_current
  check_zone_rule_phases_free
  check_seed_snapshot_exists
  check_vcpu_quotas "$1"
  info "all clear"
}

require_tools() { # <tool...>
  local tool
  for tool in "$@"; do
    command -v "$tool" >/dev/null || fail "Missing tool: $tool"
  done
}

check_signed_in() {
  aws sts get-caller-identity >/dev/null 2>&1 ||
    fail "Not signed in to AWS. Run: aws sso login --profile $AWS_PROFILE"
}

check_core_is_up() {
  stack_exists "$CORE_STACK" || fail "Core is not up. Run: aws-prod core"
  parameter "$PARAM_ORIGIN_CERT" >/dev/null 2>&1 ||
    fail "The origin certificate is not imported. Run: aws-prod core"
}

# The origin admits Cloudflare's published ranges; a stale list would lock out part of Cloudflare.
check_cloudflare_ranges_current() {
  local live ours
  live="$(curl -fsS https://www.cloudflare.com/ips-v4 | sort)"
  ours="$(tr ' ' '\n' <<<"$CLOUDFLARE_RANGES" | sort)"
  [[ "$live" == "$ours" ]] ||
    fail "Cloudflare's ranges changed; update config/cloudflareRanges.ts to match https://www.cloudflare.com/ips-v4"
}

# A zone has one entrypoint per rule phase. Taking over one that already
# holds someone else's rules would replace them, and tearing down would delete them.
check_zone_rule_phases_free() {
  local zone phase body
  zone="$(cloudflare_zone_id)"
  [[ -n "$zone" ]] || fail "Zone $ZONE_NAME is not visible to this Cloudflare token"
  for phase in http_config_settings http_request_firewall_custom http_ratelimit; do
    body="$(cloudflare_api "/zones/$zone/rulesets/phases/$phase/entrypoint")"
    if jq -e '.success and (.result.name | startswith("aws-prod") | not)' <<<"$body" >/dev/null; then
      fail "The zone's $phase rules belong to something else; aws-prod would replace them"
    fi
  done
}

# Bot Fight Mode challenges traffic from cloud address ranges, the load
# generators included, and no edge rule can exempt them on the Free plan.
check_bot_fight_mode_off() {
  local fight_mode
  fight_mode="$(cloudflare_api "/zones/$(cloudflare_zone_id)/bot_management" | jq -r '.result.fight_mode | if type == "boolean" then tostring else "unknown" end')"
  case "$fight_mode" in
    false) ;;
    true) fail "Bot Fight Mode is on for $ZONE_NAME and would block the load generators. Turn it off under Security, Bots" ;;
    *) fail "Could not read Bot Fight Mode for $ZONE_NAME; the Cloudflare token needs Bot Management read" ;;
  esac
}

# Refuses a step whose vCPUs do not fit the account's Fargate quotas, before anything is created.
check_vcpu_quotas() { # <step>
  local on_demand spot said
  on_demand="$(fargate_vcpu_quota "$QUOTA_FARGATE_ON_DEMAND" On-Demand)"
  spot="$(fargate_vcpu_quota "$QUOTA_FARGATE_SPOT" Spot)"
  said="$(cd "$INFRA_DIR" && npx --no-install tsx bin/quotaCheck.ts "$1" "$on_demand" "$spot" 2>&1)" ||
    fail "$said"
}

# The account's value of one Fargate vCPU quota. Refuses a code that is not the quota it should be.
fargate_vcpu_quota() { # <quota code> <On-Demand|Spot>
  local said name value
  said="$(aws service-quotas get-service-quota --service-code fargate --quota-code "$1" \
    --query 'Quota.[QuotaName,Value]' --output text 2>&1)" ||
    fail "Could not read the Fargate $2 vCPU quota (code $1) from Service Quotas: $said"
  IFS=$'\t' read -r name value <<<"$said"
  [[ "$name" == *"$2"* ]] || fail "Quota $1 is \"$name\", not the Fargate $2 vCPU quota; correct FARGATE_QUOTAS in config/names.ts"
  echo "$value"
}

check_seed_snapshot_exists() {
  [[ "$STEP_DB_SOURCE" == "seedSnapshot" ]] || return 0
  latest_seed_snapshot >/dev/null
}
