# A load run's record, in its folder under load/.runs/<run id>/ on this
# machine. The harness's aws:run command begins it and seals it; the archive
# step here seals a run that command could not.
#
# A run is sealed when its folder holds its manifest. One that has begun and
# has no manifest is unsealed, and `down` refuses to delete the raise while
# the current raise has one.

# Runs one of the harness's archive commands, which read AWS with this shell's credentials.
archive_harness() { # <command> <args...>
  (cd "$REPO_DIR" && npm run --silent archive --workspace=load -- "$@")
}

# Whether a run has begun recording and is not sealed. False for a run that
# never began, which has no folder.
run_is_unsealed() { # <run id>
  local folder="$REPO_DIR/load/.runs/$1"
  [[ -n "$1" && -d "$folder" && ! -f "$folder/manifest.json" ]]
}

# Collects the run into its folder and seals it. Does not return before the run
# is sealed. The outcome and the end of the run are worked out from the
# generators' tasks when not given.
seal_run() { # <run id> [finished|interrupted|failed] [ended at]
  local run_id="$1" outcome="${2:-}" ended="${3:-}"
  step "Archive: collecting run $run_id"
  local options=()
  [[ -z "$outcome" ]] || options+=(--outcome "$outcome")
  [[ -z "$ended" ]] || options+=(--ended "$ended")
  archive_harness seal --run "$run_id" ${options[@]+"${options[@]}"}
}
