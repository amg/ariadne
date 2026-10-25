# A sealed run's verdict and report. The harness's rebuild works from the
# run's folder alone and writes under its derived/, which a rebuild may
# replace at any time.

# Rebuilds a sealed run from its folder, and says where it wrote the verdict
# and report. The run is named by its id, or by the start of it, such as its
# timestamp. A verdict that is not a pass is still a rebuild that worked. Fails
# when the run cannot be rebuilt, such as one that was never sealed.
rebuild_run() { # <run id>
  local run_id="$1" status=0
  step "Rebuild: verdict and report of run $run_id"
  (cd "$REPO_DIR" && npm run --silent rebuild --workspace=load -- "$run_id") || status=$?
  ((status <= 1)) || return "$status"
}
