# Load generators: raised in their own stack, one task per generator, each
# given its own slice of the population. Their REPORT lines are collected
# from the logs and merged into one summary.
#
# A run goes through Cloudflare, as users do, unless it takes the direct
# path: then the generators skip Cloudflare and present their own client
# certificate to the load balancer, and the origin lets each generator's
# address through for the length of the run only.

# Marks the origin's rules for generator addresses, so closing finds them all.
DIRECT_PATH_RULE="Load generator on the direct path"

run_generators() { # <step> <image tag> <load|seed> [edge|direct]
  local step="$1" tag="$2" mode="$3" path="${4:-edge}" run_id started_ms context=()
  if [[ "$path" == direct ]]; then
    close_direct_path # whatever an earlier run could not close
    context=(-c "originAddress=$(stack_output "$APP_STACK" "$OUT_ORIGIN_DNS_NAME")")
  fi
  step "Load: generators' network and task definition"
  run_cdk deploy "$LOAD_STACK" --exclusively -c "step=$step" -c "imageTag=$tag" ${context[@]+"${context[@]}"}

  run_id="$(date -u +%Y%m%dT%H%M%SZ)-$step-$mode"
  [[ "$path" == direct ]] && run_id="$run_id-direct"
  started_ms="$(($(date +%s) * 1000))"
  step "Load: $STEP_GENERATORS generators, $STEP_USERS users, run $run_id"
  local tasks
  tasks="$(start_generators "$run_id" "$mode")"
  if [[ "$path" == direct ]]; then
    open_direct_path "$tasks"
  fi
  wait_for_generators "$tasks"
  if [[ "$path" == direct ]]; then
    close_direct_path
    trap - EXIT
  fi
  collect_reports "$run_id" "$started_ms"
  delete_stack "$LOAD_STACK"
}

start_generators() { # <run id> <mode>; prints the task ARNs
  local per_generator=$(((STEP_USERS + STEP_GENERATORS - 1) / STEP_GENERATORS))
  local generator first count
  for ((generator = 0; generator < STEP_GENERATORS; generator++)); do
    first=$((generator * per_generator))
    count=$((first + per_generator > STEP_USERS ? STEP_USERS - first : per_generator))
    start_generator "$1" "$2" "$generator" "$first" "$count"
  done
}

start_generator() { # <run id> <mode> <generator> <first user> <user count>
  local overrides
  overrides="$(jq -cn --arg run "$1" --arg mode "$2" --arg generator "$3" \
    --arg first "$4" --arg count "$5" '{containerOverrides: [{name: "generator", environment: [
      {name: "RUN_ID", value: $run}, {name: "MODE", value: $mode},
      {name: "GENERATOR", value: $generator},
      {name: "FIRST_USER", value: $first}, {name: "USER_COUNT", value: $count}]}]}')"
  aws ecs run-task --launch-type FARGATE \
    --cluster "$(stack_output "$LOAD_STACK" "$OUT_LOAD_CLUSTER")" \
    --task-definition "$(stack_output "$LOAD_STACK" "$OUT_LOAD_TASK_DEFINITION")" \
    --network-configuration "awsvpcConfiguration={subnets=[$(stack_output "$LOAD_STACK" "$OUT_LOAD_SUBNETS")],securityGroups=[$(stack_output "$LOAD_STACK" "$OUT_LOAD_SECURITY_GROUP")],assignPublicIp=ENABLED}" \
    --overrides "$overrides" --query 'tasks[0].taskArn' --output text
}

wait_for_generators() { # <task ARNs, one per line>
  local cluster running
  cluster="$(stack_output "$LOAD_STACK" "$OUT_LOAD_CLUSTER")"
  while true; do
    # shellcheck disable=SC2086 # one ARN per word is the point
    running="$(aws ecs describe-tasks --cluster "$cluster" --tasks $1 \
      --query "length(tasks[?lastStatus!='STOPPED'])" --output text)"
    [[ "$running" == "0" ]] && break
    info "$(date '+%H:%M') $running generators still running"
    sleep 60
  done
}

# Lets each running generator's public address reach the load balancer on
# 443. The client certificate is still required; this opens the address
# lock only. However the command ends from here on, the addresses close.
open_direct_path() { # <task ARNs, one per line>
  local cluster group eni address
  trap close_direct_path EXIT
  cluster="$(stack_output "$LOAD_STACK" "$OUT_LOAD_CLUSTER")"
  group="$(origin_security_group)"
  [[ -n "$group" ]] || fail "Could not find the origin's security group"
  step "Load: direct path open to the generators"
  # shellcheck disable=SC2086 # one ARN per word is the point
  aws ecs wait tasks-running --cluster "$cluster" --tasks $1
  # shellcheck disable=SC2086
  for eni in $(aws ecs describe-tasks --cluster "$cluster" --tasks $1 \
    --query "tasks[].attachments[].details[?name=='networkInterfaceId'].value" --output text); do
    address="$(aws ec2 describe-network-interfaces --network-interface-ids "$eni" \
      --query 'NetworkInterfaces[0].Association.PublicIp' --output text)"
    aws ec2 authorize-security-group-ingress --group-id "$group" --ip-permissions "$(jq -cn \
      --arg cidr "$address/32" --arg rule "$DIRECT_PATH_RULE" \
      '[{IpProtocol: "tcp", FromPort: 443, ToPort: 443, IpRanges: [{CidrIp: $cidr, Description: $rule}]}]')" >/dev/null
    info "$address"
  done
}

# Removes every generator address from the origin. Safe to repeat, and safe
# when nothing is raised.
close_direct_path() {
  local group rules
  stack_exists "$APP_STACK" || return 0
  group="$(origin_security_group)"
  [[ -n "$group" ]] || return 0
  rules="$(direct_path_rules "$group")"
  [[ -n "$rules" ]] || return 0
  # shellcheck disable=SC2086 # one rule id per word is the point
  aws ec2 revoke-security-group-ingress --group-id "$group" --security-group-rule-ids $rules >/dev/null
  info "direct path closed: $(wc -w <<<"$rules") generator addresses removed"
}

direct_path_rules() { # <security group>; prints rule ids
  aws ec2 describe-security-group-rules --filters "Name=group-id,Values=$1" \
    --query "SecurityGroupRules[?Description=='$DIRECT_PATH_RULE'].SecurityGroupRuleId" --output text
}

origin_security_group() {
  local address
  address="$(stack_output "$APP_STACK" "$OUT_ORIGIN_DNS_NAME")"
  aws elbv2 describe-load-balancers \
    --query "LoadBalancers[?DNSName=='$address'].SecurityGroups[0] | [0]" --output text | grep -v '^None$' || true
}

collect_reports() { # <run id> <started at, ms>
  local dir="$INFRA_DIR/.runs/$1"
  mkdir -p "$dir"
  aws logs filter-log-events \
    --log-group-name "$(stack_output "$LOAD_STACK" "$OUT_LOAD_LOG_GROUP")" \
    --start-time "$2" --filter-pattern '"REPORT"' \
    --query 'events[].message' --output json |
    jq -r '.[] | sub("^REPORT "; "")' >"$dir/reports.jsonl"

  aws logs filter-log-events \
    --log-group-name "$(stack_output "$LOAD_STACK" "$OUT_LOAD_LOG_GROUP")" \
    --start-time "$2" \
    --query 'events[].message' --output text >"$dir/generator.log" 2>/dev/null || true

  step "Load: summary (also in $dir)"
  (cd "$INFRA_DIR" && npx --no-install tsx load/summarize.ts "$dir/reports.jsonl") | tee "$dir/summary.txt"
}
