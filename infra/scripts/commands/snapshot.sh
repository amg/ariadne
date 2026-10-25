#!/usr/bin/env bash
# snapshot: make the database that is up the seed for every later raise.
#
# Replaces the seed snapshot without signing the population up again.
# Whatever the database holds becomes every raise's starting point, so
# run it before a load run writes into it. The raise keeps running; the
# next aws-prod up restores the new seed. The seed snapshot this one
# replaces is deleted.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 0 0 "$@"
  stack_exists "$APP_STACK" || fail "aws-prod is not up; there is no database to snapshot"
  snapshot_database
}

main "$@"; exit
