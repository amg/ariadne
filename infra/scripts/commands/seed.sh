#!/usr/bin/env bash
# seed: create the synthetic population once and snapshot it for every later raise.
#
# Raises the seed step, signs the population up through the real sign-up
# path, snapshots the database, and tears everything down again.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  "$COMMANDS_DIR/up.sh" seed

  load_names seed
  claim_budget seed load
  run_generators seed "$(stack_tag "$APP_STACK" "$IMAGE_TAG_TAG")" seed
  snapshot_database

  "$COMMANDS_DIR/down.sh"
}

main "$@"; exit
