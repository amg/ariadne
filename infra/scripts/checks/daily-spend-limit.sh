# The daily worst-case ledger. AWS billing lags by hours, so every raise
# and load run records the most it could cost before the safety net
# deletes it, and one that would take the day past the limit is refused.

claim_budget() { # <step> <raise|load>
  local step="$1" kind="$2"
  step "Budget: worst case of this $kind"

  local cost ledger key spent total
  cost="$(cd "$INFRA_DIR" && npx --no-install tsx bin/worstCase.ts "$step" "$kind")"
  key="ledger/$(date -u +%F).json"
  ledger="$(mktemp)"
  aws s3 cp "s3://$(vault_bucket)/$key" "$ledger" --quiet 2>/dev/null || echo '[]' >"$ledger"

  spent="$(jq '[.[].worstCaseUsd] | add // 0' "$ledger")"
  total="$(jq -n "($spent + $cost) * 100 | round / 100")"
  info "today so far \$$spent + this $kind \$$cost = \$$total (limit \$$DAILY_WORST_CASE_LIMIT_USD)"
  if jq -e -n "$total > $DAILY_WORST_CASE_LIMIT_USD" >/dev/null; then
    fail "Refused: today's recorded worst cases would pass the daily limit"
  fi

  jq --arg at "$(date -u +%FT%TZ)" --arg step "$step" --arg kind "$kind" --argjson usd "$cost" \
    '. + [{at: $at, step: $step, kind: $kind, worstCaseUsd: $usd}]' "$ledger" |
    aws s3 cp - "s3://$(vault_bucket)/$key" --quiet
}

show_ledger() {
  aws s3 cp "s3://$(vault_bucket)/ledger/$(date -u +%F).json" - 2>/dev/null |
    jq -r '.[] | "  \(.at)  \(.step) \(.kind)  $\(.worstCaseUsd)"' || info "nothing recorded today"
}
