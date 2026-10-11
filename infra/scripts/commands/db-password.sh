#!/usr/bin/env bash
# db-password: print the raised database's password, alone on stdout for piping.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  stack_exists "$APP_STACK" || fail "Nothing is raised. Run: aws-prod up <step>"
  aws secretsmanager get-secret-value \
    --secret-id "$(stack_output "$APP_STACK" "$OUT_DATABASE_SECRET")" \
    --query SecretString --output text | jq -r .password
}

main "$@"; exit
