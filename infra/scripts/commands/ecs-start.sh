#!/usr/bin/env bash
# ecs-start <step>: scale ECS services back to their step's desired task counts.
#
# After ecs-stop, this restores each service to the task count its step
# sets; a scaling service gets its floor. The database must already be up.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 1 1 "$@"
  local step="$1"
  require_step "$step"
  load_names "$step"

  local cluster
  cluster="$(find_app_cluster)" || fail "No app cluster found. Is aws-prod up?"

  step "Starting ECS services for $step in $cluster"
  info "Api=$STEP_API_COUNT Worker=$STEP_WORKER_COUNT Auth=$STEP_AUTH_COUNT Mock=$STEP_MOCK_COUNT Web=$STEP_WEB_COUNT"

  update_service "$cluster" "Api" "$STEP_API_COUNT"
  update_service "$cluster" "Worker" "$STEP_WORKER_COUNT"
  update_service "$cluster" "Auth" "$STEP_AUTH_COUNT"
  update_service "$cluster" "Mock" "$STEP_MOCK_COUNT"
  update_service "$cluster" "Web" "$STEP_WEB_COUNT"

  info "Done. Tasks will take a few minutes to become healthy."
}

find_app_cluster() {
  local arn
  arn="$(aws ecs list-clusters --query "clusterArns[?contains(@, 'App')][] | [0]" --output text)"
  [[ -n "$arn" && "$arn" != "None" ]] || return 1
  echo "${arn##*/}"
}

update_service() {
  local cluster="$1" type="$2" count="$3"
  local svc arn
  # CDK names each service after its type: AriAwsApp-ServicesApiServiceXXX-hash.
  arn="$(aws ecs list-services --cluster "$cluster" --query "serviceArns[?contains(@, '${type}Service')] | [0]" --output text)"
  [[ -n "$arn" && "$arn" != "None" ]] || { info "  $type: not found (skipping)"; return 0; }
  svc="${arn##*/}"
  info "  $svc → $count"
  aws ecs update-service --cluster "$cluster" --service "$svc" --desired-count "$count" --no-cli-pager
}

main "$@"; exit
