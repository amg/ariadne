#!/usr/bin/env bash
# db-tunnel [port]: the raised database on localhost:<port> (default 15433), through the bastion.
#
# Stays open until Ctrl-C. The password is new on every raise; db-password prints it.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 1 "$@"
  local port="${1:-15433}" bastion database
  stack_exists "$APP_STACK" || fail "Nothing is raised. Run: aws-prod up <step>"
  bastion="$(stack_output "$APP_STACK" "$OUT_BASTION_ID")"
  database="$(stack_output "$APP_STACK" "$OUT_DATABASE_ENDPOINT")"
  step "Database on localhost:$port (Ctrl-C to close)"
  info "postgresql://${PROJECT//-/_}@localhost:$port/chatbot?sslmode=require"
  info "password: aws-prod db-password"
  aws ssm start-session --target "$bastion" \
    --document-name AWS-StartPortForwardingSessionToRemoteHost \
    --parameters "host=$database,portNumber=5432,localPortNumber=$port"
}

main "$@"; exit
