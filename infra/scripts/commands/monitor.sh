#!/usr/bin/env bash
# monitor: live user, task and load figures with the step's configuration, highlighted against the pass lines.
#
# Press Ctrl+C to stop. Redrawn in place every minute. The harness works out
# every figure from CloudWatch and decides which are highlighted.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  local step_name
  step_name="$(stack_tag "$APP_STACK" "$STEP_TAG" 2>/dev/null || echo "smoke")"

  # Load the extended shell names for this step to get counts and sizes
  eval "$(cd "$INFRA_DIR" && npx --no-install tsx bin/shellNames.ts "$step_name")"

  # A resource that cannot be found leaves its figures searched across the
  # account, and the title says which.
  local arn unscoped=() note=""
  MONITOR_CLUSTER="$(stack_output "$APP_STACK" "$OUT_CLUSTER_NAME" 2>/dev/null)" || MONITOR_CLUSTER=""
  MONITOR_DATABASE="$(stack_output "$APP_STACK" "$OUT_DATABASE_ID" 2>/dev/null)" || MONITOR_DATABASE=""
  arn="$(origin_load_balancer_field LoadBalancerArn 2>/dev/null)" || arn=""
  MONITOR_LOAD_BALANCER="${arn#*:loadbalancer/}"
  export MONITOR_CLUSTER MONITOR_DATABASE MONITOR_LOAD_BALANCER
  [[ -n "$MONITOR_CLUSTER" ]] || unscoped+=(cluster)
  [[ -n "$MONITOR_DATABASE" ]] || unscoped+=(database)
  [[ -n "$MONITOR_LOAD_BALANCER" ]] || unscoped+=("load balancer")
  ((${#unscoped[@]} == 0)) || note=" \033[33m(whole account, not this stack: ${unscoped[*]})\033[0m"

  # The terminal's second screen holds the frames, with the cursor hidden and
  # lines cut at its edge instead of wrapped. Leaving gives the first screen back.
  trap 'printf "\033[?7h\033[?25h\033[?1049l"' EXIT
  trap 'exit 0' INT
  printf '\033[?1049h\033[?25l\033[?7l\033[H\033[Jaws-prod monitor: reading CloudWatch...'

  local frame rows
  while true; do
    frame="$(monitor_frame "$step_name" "$note")"
    read -r rows _ < <(stty size 2>/dev/null </dev/tty) || rows=""
    [[ -n "$rows" ]] && frame="$(head -n "$rows" <<<"$frame")"
    # Every line is cleared to its end and everything below the frame is
    # cleared, so nothing of the previous frame shows through.
    printf '\033[H%s\033[J' "${frame//$'\n'/$'\033[K\n'}"
    sleep 60
  done
}

# One whole screen: the title, the harness's table and the step's configuration.
monitor_frame() { # <step name> <note after the title>
  local step_name="$1" note="$2"
  echo -e "\033[1maws-prod monitor\033[0m (step: \033[36m$step_name\033[0m) - last 15 min (UTC), refreshed $(date +%H:%M:%S)$note"
  echo
  (cd "$REPO_DIR" && MONITOR_COLOUR=1 npm run --silent monitor --workspace=load 2>&1) ||
    echo "(the harness could not read CloudWatch)"
  echo
  echo -e "\033[1mConfiguration for $step_name:\033[0m"
  printf "  %-10s %s tasks  (CPU: %4s, Mem: %4s MiB)\n" "API:" "$STEP_API_COUNT" "$STEP_API_CPU" "$STEP_API_MEM"
  printf "  %-10s %s tasks  (CPU: %4s, Mem: %4s MiB)\n" "Auth:" "$STEP_AUTH_COUNT" "$STEP_AUTH_CPU" "$STEP_AUTH_MEM"
  printf "  %-10s %s tasks  (CPU: %4s, Mem: %4s MiB)\n" "Worker:" "$STEP_WORKER_COUNT" "$STEP_WORKER_CPU" "$STEP_WORKER_MEM"
  printf "  %-10s %s tasks  (CPU: %4s, Mem: %4s MiB)\n" "Mock:" "$STEP_MOCK_COUNT" "$STEP_MOCK_CPU" "$STEP_MOCK_MEM"
  printf "  %-10s %s tasks  (CPU: %4s, Mem: %4s MiB)\n" "Web:" "$STEP_WEB_COUNT" "$STEP_WEB_CPU" "$STEP_WEB_MEM"
  echo "  Database:  $STEP_DB_CLASS"
}

main "$@"; exit
