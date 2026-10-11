# Small AWS and CDK helpers.

account_id() { aws sts get-caller-identity --query Account --output text; }
vault_bucket() { echo "${PROJECT}-vault-$(account_id)"; }

stack_exists() { # <stack>
  aws cloudformation describe-stacks --stack-name "$1" >/dev/null 2>&1
}

stack_output() { # <stack> <output key>
  aws cloudformation describe-stacks --stack-name "$1" \
    --query "Stacks[0].Outputs[?OutputKey=='$2'].OutputValue" --output text
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
  aws cloudformation delete-stack --stack-name "$1"
  aws cloudformation wait stack-delete-complete --stack-name "$1"
}

parameter() { # <name>
  aws ssm get-parameter --name "$1" --with-decryption --query Parameter.Value --output text
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
