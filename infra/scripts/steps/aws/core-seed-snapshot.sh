# The seeded database becomes every later raise's starting point.

snapshot_database() {
  step "Snapshot: the seeded database becomes every later raise's starting point"
  local snapshot_id
  snapshot_id="${PROJECT}-seed-$(date -u +%Y%m%d%H%M)"
  aws rds create-db-snapshot \
    --db-instance-identifier "$(stack_output "$APP_STACK" "$OUT_DATABASE_ID")" \
    --db-snapshot-identifier "$snapshot_id" \
    --tags "Key=$LIFETIME_TAG,Value=core" >/dev/null
  aws rds wait db-snapshot-available --db-snapshot-identifier "$snapshot_id"
  put_parameter "$PARAM_SEED_SNAPSHOT" String "$snapshot_id"
  info "$snapshot_id"
  prune_seed_snapshots "$snapshot_id"
}

# Each seed comes from a fresh instance, so every snapshot is a full copy.
# The population re-seeds from config, so older seeds buy no rollback worth
# their storage. Runs only after the pointer has moved to the new one.
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
