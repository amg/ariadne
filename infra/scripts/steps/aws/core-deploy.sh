# The core stack: vault, image repositories, secrets and the safety net.

deploy_core_stack() {
  step "Core: vault, image repositories, secrets, safety net"
  # The app synthesizes nothing without a step, so one is passed even
  # though only the core stack is deployed.
  run_cdk deploy "$CORE_STACK" --exclusively -c step=seed -c imageTag=core
}
