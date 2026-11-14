# Checks that refuse a raise before anything is created or spent.

preflight() { # <step>
  step "Preflight"
  require_tools aws docker terraform jq curl openssl git node
  [[ -n "${CLOUDFLARE_API_TOKEN:-}" ]] || fail "CLOUDFLARE_API_TOKEN is not set"
  check_signed_in
  check_core_is_up
  check_zone_visible
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
  parameter "$PARAM_EDGE_CERT" >/dev/null 2>&1 ||
    fail "The hostname's certificate is not issued. Run: aws-prod core"
  (export AWS_REGION="$EDGE_REGION" && stack_exists CDKToolkit) ||
    fail "CDK is not bootstrapped in $EDGE_REGION, where the edge rules live. Run: aws-prod core"
}

check_zone_visible() {
  [[ -n "$(cloudflare_zone_id)" ]] || fail "Zone $ZONE_NAME is not visible to this Cloudflare token"
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
