#!/usr/bin/env bash
# archive <run id> [ended at]: seal a run that was never sealed, or resume its archive.
#
# `load` seals its run before it returns. This is for a run it could not
# seal: the archive keeps what it already collected and goes on from there,
# and a run already sealed is left as it is. Run it while the raise is up, so
# that its Performance Insights can still be read. When nothing records when
# the run ended, the last of its generators' stops says; or name it as an ISO instant.
# The run id may be the start of it, such as its timestamp, when only one run
# begins that way.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 1 2 "$@"
  seal_run "$1" "" "${2:-}"
}

main "$@"; exit
