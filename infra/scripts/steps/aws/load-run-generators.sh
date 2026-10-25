# Load generators: raised in their own stack, one task per generator, each
# given its own slice of the population. The harness's aws:run command runs
# them. For a load run it also opens the run's record, and when the
# generators have ended or been stopped it seals the run into its folder and
# rebuilds it into numbers, a verdict and a report, as `aws-prod rebuild`
# does by hand. A seeding run keeps no record.
#
# A load run's generators run on Fargate Spot, and the harness watches them:
# one that stops before the run's end, because Spot took its capacity back or
# because someone stopped it, is started again on the same slice of users. The
# seeding run's generators run On-Demand, and none is replaced.
#
# The generators run the image the raise was made with, unless `aws-prod
# load-image` has put another in its place; the run's record names the one they ran.
#
# A run goes through Cloudflare, as users do, unless it takes the direct
# path: then the generators skip Cloudflare and present their own client
# certificate to the load balancer. Every generator leaves the load stack's
# network from its one public address, and on the direct path the stack lets
# that address into the origin, so the way in goes when the stack goes.
#
# This shell keeps what only a shell can do from outside the command: the
# generators' stack, and the day's budget claim.

run_generators() { # <step> <image tag> <load|seed> [edge|direct]
  local step="$1" tag="$2" mode="$3" path="${4:-edge}"
  RUN_ID=""
  LOAD_STACK_DEPLOYED=""
  STEP_CONFIG_FILE=""
  trap finish_load_command EXIT
  # On a signal the command stops the generators, seals the run and exits
  # with 130 or 143. Then npm ends itself with the signal, and this shell
  # would reach its exit handler with status 0. A trap that exits with the
  # signal's status gives the handler that status instead. The trap runs only
  # after the command has exited, so the run is sealed first.
  trap 'exit 130' INT
  trap 'exit 143' TERM
  # The CDK app synthesizes the app stack too, which must keep the raise's own seed.
  local seed load_tag context=()
  seed="$(raised_seed_snapshot)" || return 1
  load_tag="$(load_image_tag "$tag")" || return 1
  context=(-c "seedSnapshot=$seed")
  if [[ "$path" == direct ]]; then
    local origin group
    origin="$(stack_output "$APP_STACK" "$OUT_ORIGIN_DNS_NAME")" || return 1
    group="$(origin_security_group)" || return 1
    [[ -n "$group" ]] || fail "Could not find the origin's security group, so the direct path cannot be opened"
    context+=(-c "originAddress=$origin" -c "originSecurityGroup=$group")
  fi
  step "Load: generators' network and task definition"
  LOAD_STACK_DEPLOYED=1
  run_cdk deploy "$LOAD_STACK" --exclusively -c "step=$step" -c "imageTag=$tag" -c "loadImageTag=$load_tag" "${context[@]}"

  RUN_ID="$(date -u +%Y%m%dT%H%M%SZ)-$step-$mode"
  if [[ "$path" == direct ]]; then RUN_ID="$RUN_ID-direct"; fi
  step "Load: $STEP_GENERATORS generators, $STEP_USERS users, run $RUN_ID"
  info "generators run image $load_tag"
  run_generators_in_ecs "$step" "$tag" "$load_tag" "$mode" "$path" "$seed"
  # The run ran its whole plan, so its worst case stays counted.
  BUDGET_CLAIM_AT=""
  if run_is_unsealed "$RUN_ID"; then
    fail "Run $RUN_ID is not sealed. Run: aws-prod archive $RUN_ID"
  fi
  # Deleted here, and not left to the exit handler, because a seeding run goes on to snapshot the database with the stack still up.
  delete_stack "$LOAD_STACK"
  LOAD_STACK_DEPLOYED=""
}

# Runs the generators through the harness. Its exit status says how the run
# ended: 0 when it ran its plan, 130 when it was interrupted, 1 when it failed.
run_generators_in_ecs() { # <step> <image tag> <load image tag> <load|seed> <edge|direct> <seed snapshot>
  local step="$1" tag="$2" load_tag="$3" mode="$4" path="$5" seed="$6"
  local cluster definition subnets group images
  # Each lookup is its own statement, because one inside the command's
  # arguments that failed would hand the command an empty value.
  cluster="$(stack_output "$LOAD_STACK" "$OUT_LOAD_CLUSTER")" || return 1
  definition="$(stack_output "$LOAD_STACK" "$OUT_LOAD_TASK_DEFINITION")" || return 1
  subnets="$(stack_output "$LOAD_STACK" "$OUT_LOAD_SUBNETS")" || return 1
  group="$(stack_output "$LOAD_STACK" "$OUT_LOAD_SECURITY_GROUP")" || return 1
  STEP_CONFIG_FILE="$(mktemp)"
  (cd "$INFRA_DIR" && npx --no-install tsx bin/stepConfig.ts "$step" "$seed") >"$STEP_CONFIG_FILE" || return 1
  local options=(
    --run "$RUN_ID" --mode "$mode" --config "$STEP_CONFIG_FILE"
    --cluster "$cluster" --task-definition "$definition"
    --subnets "$subnets" --security-group "$group"
  )
  if [[ "$mode" == load ]]; then
    images="$(jq -cn --arg tag "$tag" --arg load "$load_tag" --arg auth "$AUTH_CORE_TAG" \
      '{backend: $tag, web: $tag, tools: $tag, load: $load, auth: $auth}')" || return 1
    if [[ "$path" == edge ]]; then path=cloudflare; fi
    options+=(
      --step "$step" --path "$path" --images "$images"
      --app-stack "$APP_STACK" --load-stack "$LOAD_STACK"
    )
  fi
  # No subshell here. A signal that killed one would send this shell on while
  # the harness was still stopping the generators.
  npm run --silent --prefix "$REPO_DIR" aws:run --workspace=load -- "${options[@]}"
}

# However a load command ends, the harness has already stopped the generators,
# and sealed and rebuilt the run when it kept one. What is left is the
# day's budget and the generators' stack, unless the run's own path already
# deleted the stack. A run that did not run its whole
# plan releases its claim on the day's budget. The generators' stack goes,
# and with it the direct path's way into the origin, except when the run could
# not be sealed: the archive reads its tasks, so the stack stays for
# `aws-prod archive`. A command that ends before its run began recording has
# no run folder, and its stack goes at once. Each step runs in a subshell,
# because a helper that fails ends the shell it runs in, and the handler must
# get to the stack.
finish_load_command() {
  local status=$? outcome=failed
  trap - EXIT INT TERM
  [[ -z "${STEP_CONFIG_FILE:-}" ]] || rm -f "$STEP_CONFIG_FILE"
  case "$status" in
    0) outcome=finished ;;
    130 | 143) outcome=interrupted ;;
  esac
  if [[ -n "${BUDGET_CLAIM_AT:-}" && "$outcome" != finished ]]; then
    (release_budget "$BUDGET_CLAIM_AT" "$outcome") || info "The run's claim on today's budget was not released; aws-prod reset-budget clears the day"
    BUDGET_CLAIM_AT=""
  fi
  if [[ -n "${LOAD_STACK_DEPLOYED:-}" ]]; then
    if run_is_unsealed "${RUN_ID:-}"; then
      info "Run $RUN_ID is not sealed, so the generators' stack stays. Run: aws-prod archive $RUN_ID"
    elif ! (delete_stack "$LOAD_STACK"); then
      info "The generators' stack is still there. Run: aws-prod sweep"
      ((status != 0)) || status=1
    fi
  fi
  exit "$status"
}

# Prints the origin's security group, or nothing when no load balancer has the
# origin's address. Fails when AWS could not be asked.
origin_security_group() {
  origin_load_balancer_field 'SecurityGroups[0]'
}
