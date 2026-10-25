#!/usr/bin/env bash
# ecs-status: show ECS services and their current/desired task counts.
#
# Lists each service with its running and desired task count, so you can
# see whether services are stopped (0 desired) or running.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  local cluster
  cluster="$(find_app_cluster)" || { info "No app cluster found. Is aws-prod up?"; return 0; }
  step "ECS services in $cluster"
  aws ecs describe-services --cluster "$cluster" \
    --services "$(aws ecs list-services --cluster "$cluster" --query 'serviceArns[*]' --output text)" \
    --query 'services[].{name:serviceName,running:runningCount,pending:pendingCount,desired:desiredCount,status:status}' \
    --output table
}

find_app_cluster() {
  local arn
  arn="$(aws ecs list-clusters --query "clusterArns[?contains(@, 'App')][] | [0]" --output text)"
  [[ -n "$arn" && "$arn" != "None" ]] || return 1
  echo "${arn##*/}"
}

main "$@"; exit
