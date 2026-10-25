# The seeded database becomes every later raise's starting point. A raise
# restores the newest seed snapshot that is available.

snapshot_database() {
  step "Snapshot: the seeded database becomes every later raise's starting point"
  local snapshot_id
  snapshot_id="${PROJECT}-seed-$(date -u +%Y%m%d%H%M)"
  aws rds create-db-snapshot \
    --db-instance-identifier "$(stack_output "$APP_STACK" "$OUT_DATABASE_ID")" \
    --db-snapshot-identifier "$snapshot_id" \
    --tags "Key=$LIFETIME_TAG,Value=core" >/dev/null
  wait_for_snapshot "$snapshot_id"
  info "$snapshot_id"
  prune_seed_snapshots "$snapshot_id"
}

# A seed of a few hundred GiB takes longer than the half hour the AWS CLI's
# own waiter allows, so this waits for as long as RDS is still creating it.
wait_for_snapshot() { # <snapshot id>
  local state status progress
  while true; do
    state="$(aws rds describe-db-snapshots --db-snapshot-identifier "$1" \
      --query 'DBSnapshots[0].[Status, PercentProgress]' --output text)" ||
      fail "Could not ask RDS how snapshot $1 is doing"
    read -r status progress <<<"$state"
    case "$status" in
      available) return 0 ;;
      creating) info "$(date '+%H:%M') $1 is $progress% done" ;;
      *) fail "Snapshot $1 is $status, not available" ;;
    esac
    sleep 60
  done
}

# The newest seed snapshot that is available. Ends the command, saying why,
# when there is none. JSON output, because with text output the CLI applies
# the query to each page of snapshots and not to all of them.
latest_seed_snapshot() {
  local latest
  latest="$(aws rds describe-db-snapshots --snapshot-type manual \
    --query "reverse(sort_by(DBSnapshots[?starts_with(DBSnapshotIdentifier, '${PROJECT}-seed-') && Status=='available'], &SnapshotCreateTime))[0].DBSnapshotIdentifier" \
    --output json)" || fail "Could not list the seed snapshots"
  latest="$(jq -r '. // empty' <<<"$latest")"
  [[ -n "$latest" ]] ||
    fail "There is no seed snapshot available to restore. Run: aws-prod seed"
  echo "$latest"
}

# The seed snapshot the raised app was restored from, or nothing for a step
# that starts empty. Ends the command, saying why, when a raise that restores
# the seed does not name it.
raised_seed_snapshot() {
  local seed
  seed="$(stack_tag "$APP_STACK" "$SEED_SNAPSHOT_TAG")" ||
    fail "Could not read which seed snapshot $APP_STACK was restored from"
  [[ -n "$seed" || "$STEP_DB_SOURCE" != "seedSnapshot" ]] ||
    fail "$APP_STACK does not name its seed snapshot. Run: aws-prod down, then raise again"
  echo "$seed"
}

# Each seed comes from a fresh instance, so every snapshot is a full copy.
# The population re-seeds from config, so older seeds buy no rollback worth
# their storage. Runs only once the new one is available.
prune_seed_snapshots() { # <snapshot id to keep>
  local old
  for old in $(aws rds describe-db-snapshots --snapshot-type manual \
    --query "DBSnapshots[?starts_with(DBSnapshotIdentifier, '${PROJECT}-seed-') && Status=='available'].DBSnapshotIdentifier" \
    --output text); do
    [[ "$old" == "$1" ]] && continue
    aws rds delete-db-snapshot --db-snapshot-identifier "$old" >/dev/null
    info "deleted older seed $old"
  done
}
