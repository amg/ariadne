#!/usr/bin/env bash
# ecs-stop: scale all ECS services to 0 tasks (stop compute, keep DB running).
#
# Use when you need to pause billing during a long wait (e.g., snapshot in
# progress). The database and any in-progress snapshot are untouched.
# Resume with: ecs-start <step>.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  local cluster
  cluster="$(find_app_cluster)" || fail "No app cluster found. Is aws-prod up?"
  step "Stopping all ECS services in $cluster"
  local svc svc_name
  for svc in $(aws ecs list-services --cluster "$cluster" --query 'serviceArns[*]' --output text); do
    svc_name="${svc##*/}"
    info "$svc_name → 0"
    aws ecs update-service --cluster "$cluster" --service "$svc_name" --desired-count 0 --no-cli-pager
  done
  info "Done. Verify: aws ecs list-tasks --cluster $cluster --query 'length(taskArns)'"
}

find_app_cluster() {
  local arn
  arn="$(aws ecs list-clusters --query "clusterArns[?contains(@, 'App')][] | [0]" --output text)"
  [[ -n "$arn" && "$arn" != "None" ]] || return 1
  echo "${arn##*/}"
}

main "$@"; exit
