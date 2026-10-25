#!/usr/bin/env bash
# rebuild <run id>: write a sealed run's verdict and report again.
#
# The run id may be the start of it, such as its timestamp, when only one run
# begins that way.
#
# `load` rebuilds its run once it is sealed; this does it again by hand, for
# a run whose rebuild failed, or after the rebuild itself has changed. It
# reads the run's folder under load/.runs/ alone, and needs no raise. A run that was interrupted is rebuilt like any other: its verdict
# says it ended early. A run that was never sealed is sealed first with
# `aws-prod archive <run id>`. The run is judged by the limits it recorded
# when it began.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

main() {
  begin 1 1 "$@"
  rebuild_run "$1" || fail "Run $1 could not be rebuilt"
}

main "$@"; exit
