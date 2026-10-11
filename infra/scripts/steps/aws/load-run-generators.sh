# Load generators: raised in their own stack, one task per generator, each
# given its own slice of the population. Their REPORT lines are collected
# from the logs and merged into one summary.

run_generators() { # <step> <image tag> <load|seed>
  local step="$1" tag="$2" mode="$3" run_id started_ms
  step "Load: generators' network and task definition"
  run_cdk deploy "$LOAD_STACK" --exclusively -c "step=$step" -c "imageTag=$tag"

  run_id="$(date -u +%Y%m%dT%H%M%SZ)-$step-$mode"
  started_ms="$(($(date +%s) * 1000))"
  step "Load: $STEP_GENERATORS generators, $STEP_USERS users, run $run_id"
  local tasks
  tasks="$(start_generators "$run_id" "$mode")"
  wait_for_generators "$tasks"
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

collect_reports() { # <run id> <started at, ms>
  local dir="$INFRA_DIR/.runs/$1"
  mkdir -p "$dir"
  aws logs filter-log-events \
    --log-group-name "$(stack_output "$LOAD_STACK" "$OUT_LOAD_LOG_GROUP")" \
    --start-time "$2" --filter-pattern '"REPORT"' \
    --query 'events[].message' --output json |
    jq -r '.[] | sub("^REPORT "; "")' >"$dir/reports.jsonl"

  step "Load: summary (also in $dir)"
  (cd "$INFRA_DIR" && npx --no-install tsx load/summarize.ts "$dir/reports.jsonl") | tee "$dir/summary.txt"
}
