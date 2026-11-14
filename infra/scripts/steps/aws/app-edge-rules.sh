# The edge's web ACL, in its own stack in the edge's region: only the
# operator and this raise's load generators get in, and sign-ins are limited
# per address. Deployed before the app, whose distribution enforces it.

edge_rules_up() {
  step "Edge rules: only the operator and the load generators, sign-ins limited per address"
  local address run_key arn
  address="$(operator_address)"
  run_key="$(parameter "$PARAM_RUN_KEY")" || fail "Could not read the run key"
  run_cdk deploy "$EDGE_RULES_STACK" --exclusively -c step=seed -c imageTag=edge-rules \
    --parameters "$EDGE_RULES_STACK:$EDGE_RULES_OPERATOR_ADDRESSES=$address/32" \
    --parameters "$EDGE_RULES_STACK:$EDGE_RULES_RUN_KEY=$run_key"
  arn="$(export AWS_REGION="$EDGE_REGION" && stack_output "$EDGE_RULES_STACK" "$OUT_WEB_ACL_ARN")"
  put_parameter "$PARAM_WEB_ACL_ARN" String "$arn"
  info "the operator gets in from $address"
}

edge_rules_down() {
  (export AWS_REGION="$EDGE_REGION" && delete_stack "$EDGE_RULES_STACK")
}

# The IPv4 address this machine reaches the internet from.
operator_address() {
  local address
  address="$(curl -4 -fsS --max-time 10 https://checkip.amazonaws.com)" ||
    fail "Could not tell which address this machine reaches the internet from"
  [[ "$address" =~ ^[0-9]+(\.[0-9]+){3}$ ]] || fail "checkip.amazonaws.com answered \"$address\", not an IPv4 address"
  echo "$address"
}
