# CDK bootstrap, with every role it creates fenced by a permissions boundary.
# Both regions are bootstrapped: aws-prod's own, and the edge's, where the
# edge rules live.

bootstrap_cdk() {
  step "Core: CDK bootstrap, fencing every role it creates with a permissions boundary"
  local region
  for region in "$REGION" "$EDGE_REGION"; do
    ensure_permissions_boundary "$region"
    # Bootstrapping synthesizes the app; the step and tag satisfy that gate.
    run_cdk bootstrap "aws://$(account_id)/$region" \
      --custom-permissions-boundary "$(boundary_name "$region")" \
      -c step=seed -c imageTag=core
  done
}

# The boundary that fences CloudFormation's deploy role and every role the
# stacks create, one for each region. The name must match
# @aws-cdk/core:permissionsBoundary in cdk.json (default qualifier). Core
# creates it rather than leaving it to
# --example-permissions-boundary, which names it differently and, in CDK
# 2.1145, fails on a fresh account instead of creating it. Its deny on
# editing the policy binds only fenced roles, so the operator can keep it
# in step with bootstrap/permissions-boundary.json on every run.
boundary_name() { echo "cdk-hnb659fds-permissions-boundary-$(account_id)-$1"; } # <region>

ensure_permissions_boundary() { # <region>
  local name arn wanted current old
  name="$(boundary_name "$1")"
  arn="arn:aws:iam::$(account_id):policy/$name"
  wanted="$(sed "s|@BOUNDARY_ARN@|$arn|g" "$INFRA_DIR/bootstrap/permissions-boundary.json")"

  if ! aws iam get-policy --policy-arn "$arn" >/dev/null 2>&1; then
    aws iam create-policy --policy-name "$name" --policy-document "$wanted" \
      --tags "Key=$LIFETIME_TAG,Value=core" >/dev/null
    info "$name created"
    return 0
  fi

  current="$(aws iam get-policy-version --policy-arn "$arn" \
    --version-id "$(aws iam get-policy --policy-arn "$arn" --query Policy.DefaultVersionId --output text)" \
    --query PolicyVersion.Document --output json)"
  if [[ "$(jq -S -c . <<<"$current")" == "$(jq -S -c . <<<"$wanted")" ]]; then
    info "$name is current"
    return 0
  fi

  # A policy keeps at most five versions, and only the default one applies.
  for old in $(aws iam list-policy-versions --policy-arn "$arn" \
    --query 'Versions[?!IsDefaultVersion].VersionId' --output text); do
    [[ "$old" == None ]] && continue
    aws iam delete-policy-version --policy-arn "$arn" --version-id "$old"
  done
  aws iam create-policy-version --policy-arn "$arn" --policy-document "$wanted" --set-as-default >/dev/null
  info "$name updated"
}
