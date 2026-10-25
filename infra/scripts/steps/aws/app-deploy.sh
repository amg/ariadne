# The app stack: network, database, cache, services, origin and bastion.

app_up() { # <step> <image tag> <seed snapshot, or empty for a step that starts empty>
  step "App: network, database, cache, services, origin (about twenty minutes)"
  [[ -z "$3" ]] || info "the database is restored from $3"
  run_cdk deploy "$APP_STACK" --exclusively -c "step=$1" -c "imageTag=$2" -c "seedSnapshot=$3"
}

# A restored database fetches each block from S3 on first read; reading
# everything once now keeps that out of the measurements.
warm_database() {
  step "Warm-up: read every block of the restored database once"
  local cluster task_arn exit_code
  cluster="$(stack_output "$APP_STACK" "$OUT_CLUSTER_NAME")"
  task_arn="$(aws ecs run-task --cluster "$cluster" --launch-type FARGATE \
    --task-definition "$(stack_output "$APP_STACK" "$OUT_WARM_TASK_DEFINITION")" \
    --network-configuration "awsvpcConfiguration={subnets=[$(stack_output "$APP_STACK" "$OUT_APP_SUBNETS")],securityGroups=[$(stack_output "$APP_STACK" "$OUT_WARM_SECURITY_GROUP")],assignPublicIp=DISABLED}" \
    --query 'tasks[0].taskArn' --output text)"
  exit_code="$(task_exit_code "$cluster" "$task_arn")"
  [[ "$exit_code" == "0" ]] || fail "Warm-up exited with $exit_code; its log group is under OperatorAccess"
  info "done"
}

# Mints this raise's load key; the edge admits requests carrying it, and the generators send it.
mint_run_key() {
  put_parameter "$PARAM_RUN_KEY" SecureString "$(openssl rand -hex 24)"
}
