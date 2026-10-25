# The daily worst-case ledger. AWS billing lags by hours, so every raise
# and load run records the most it could cost before the safety net
# deletes it, and one that would take the day past the limit is refused.
#
# A load run that does not run its whole plan, because it was interrupted
# or failed, is released: it stays in the ledger, marked, but no longer
# counts toward the limit. It may still have cost something, so the ledger
# keeps showing it. `reset-budget` clears the day by hand.

# When the last claim was made; a load run releases its claim by it.
BUDGET_CLAIM_AT=""

claim_budget() { # <step> <raise|load>
  local step="$1" kind="$2"
  step "Budget: worst case of this $kind"

  local cost ledger key spent released total at
  cost="$(cd "$INFRA_DIR" && npx --no-install tsx bin/worstCase.ts "$step" "$kind")"
  key="ledger/$(date -u +%F).json"
  ledger="$(mktemp)"
  aws s3 cp "s3://$(vault_bucket)/$key" "$ledger" --quiet 2>/dev/null || echo '[]' >"$ledger"

  spent="$(jq '[.[] | select(.released == null) | .worstCaseUsd] | add // 0' "$ledger")"
  released="$(jq '[.[] | select(.released != null) | .worstCaseUsd] | add // 0' "$ledger")"
  total="$(jq -n "($spent + $cost) * 100 | round / 100")"
  info "today so far \$$spent + this $kind \$$cost = \$$total (limit \$$DAILY_WORST_CASE_LIMIT_USD)"
  if jq -e -n "$released > 0" >/dev/null; then
    info "not counted: \$$released claimed by load runs that ended early, which may still have cost up to that"
  fi
  if jq -e -n "$total > $DAILY_WORST_CASE_LIMIT_USD" >/dev/null; then
    fail "Refused: today's recorded worst cases would pass the daily limit"
  fi

  at="$(date -u +%FT%TZ)"
  jq --arg at "$at" --arg step "$step" --arg kind "$kind" --argjson usd "$cost" \
    '. + [{at: $at, step: $step, kind: $kind, worstCaseUsd: $usd}]' "$ledger" |
    aws s3 cp - "s3://$(vault_bucket)/$key" --quiet
  BUDGET_CLAIM_AT="$at"
}

# Stops counting a load run's claim toward the limit, because the run did
# not run its whole plan. The claim stays in the ledger with why.
release_budget() { # <claimed at> <outcome>
  local key ledger
  key="ledger/${1:0:10}.json"
  ledger="$(mktemp)"
  aws s3 cp "s3://$(vault_bucket)/$key" "$ledger" --quiet || return 1
  jq --arg at "$1" --arg outcome "$2" \
    'map(if .at == $at and .kind == "load" then . + {released: $outcome} else . end)' "$ledger" |
    aws s3 cp - "s3://$(vault_bucket)/$key" --quiet || return 1
  info "The run ended $2, so its worst case no longer counts toward today's limit; it may still have cost something"
}

show_ledger() {
  aws s3 cp "s3://$(vault_bucket)/ledger/$(date -u +%F).json" - 2>/dev/null |
    jq -r '.[] | "  \(.at)  \(.step) \(.kind)  $\(.worstCaseUsd)" +
      (if .released then "  (not counted: ended \(.released), may still have cost)" else "" end)' ||
    info "nothing recorded today"
}
