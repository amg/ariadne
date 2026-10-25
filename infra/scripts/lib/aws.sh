# Small AWS and CDK helpers.

account_id() {
  local account
  account="$(aws sts get-caller-identity --query Account --output text)" ||
    fail "Could not tell which AWS account this is"
  echo "$account"
}

vault_bucket() {
  local account
  account="$(account_id)" || return 1
  echo "${PROJECT}-vault-$account"
}

# Whether the stack is there. Ends the command, saying why, when AWS could
# not say.
stack_exists() { # <stack>
  local said
  said="$(aws cloudformation describe-stacks --stack-name "$1" 2>&1)" && return 0
  [[ "$said" == *"does not exist"* ]] && return 1
  fail "Could not ask CloudFormation about stack $1: $said"
}

# Prints the output's value. A stack that cannot be read, or has no such output, fails with its own message.
stack_output() { # <stack> <output key>
  local value
  value="$(aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text)" ||
    fail "Could not read the outputs of stack $1"
  if [[ -z "$value" || "$value" == None ]]; then
    fail "Stack $1 has no output $2"
  fi
  echo "$value"
}

# Prints one field of the origin's load balancer, such as LoadBalancerArn, or
# nothing when no load balancer has the origin's address. Fails when AWS could
# not be asked.
origin_load_balancer_field() { # <field>
  local address value
  address="$(stack_output "$APP_STACK" "$OUT_ORIGIN_DNS_NAME")" || return 1
  value="$(aws elbv2 describe-load-balancers \
    --query "LoadBalancers[?DNSName=='$address'].$1 | [0]" --output text)" || {
    info "Could not look up the origin's load balancer" >&2
    return 1
  }
  [[ "$value" == None ]] || echo "$value"
}

stack_created() { # <stack>
  aws cloudformation describe-stacks --stack-name "$1" --query 'Stacks[0].CreationTime' --output text
}

stack_tag() { # <stack> <tag key>
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Tags[?Key=='$2'].Value" --output text
}

# Deletes a stack and waits; the same path the safety net takes.
delete_stack() { # <stack>
  if ! stack_exists "$1"; then
    info "$1 is already gone"
    return 0
  fi
  step "Deleting $1"
  aws cloudformation delete-stack --stack-name "$1" ||
    fail "Could not start deleting stack $1; it is still there and may be costing money"
  aws cloudformation wait stack-delete-complete --stack-name "$1" ||
    fail "Stack $1 did not finish deleting; look at its events in CloudFormation, then run: aws-prod sweep"
}

parameter() { # <name>
  aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text
}

# Prints the parameter's value, or the fallback when there is no such parameter. Any other failure ends the command.
parameter_or() { # <name> <fallback>
  local value errors
  errors="$(mktemp)"
  if value="$(aws ssm get-parameter --name "$1" --query Parameter.Value --output text 2>"$errors")"; then
    rm -f "$errors"
    echo "$value"
    return 0
  fi
  local said
  said="$(<"$errors")"
  rm -f "$errors"
  [[ "$said" == *ParameterNotFound* ]] || fail "Could not read parameter $1: $said"
  echo "$2"
}

put_parameter() { # <name> <String|SecureString> <value>
  aws ssm put-parameter --name "$1" --type "$2" --value "$3" --overwrite >/dev/null
}

# Waits until an ECS task stops and returns its container's exit code.
task_exit_code() { # <cluster> <task arn>
  local status=""
  until [[ "$status" == "STOPPED" ]]; do
    sleep 15
    status="$(aws ecs describe-tasks --cluster "$1" --tasks "$2" \
      --query 'tasks[0].lastStatus' --output text)"
  done
  aws ecs describe-tasks --cluster "$1" --tasks "$2" \
    --query 'tasks[0].containers[0].exitCode' --output text
}

run_cdk() { # <cdk args...>
  # Only deploy takes --require-approval; bootstrap rejects it.
  local approval=()
  [[ "$1" == deploy ]] && approval=(--require-approval never)
  (cd "$INFRA_DIR" && npx --no-install cdk "$@" ${approval[@]+"${approval[@]}"})
}
