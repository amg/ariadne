#!/bin/sh
# Renames the tab at container start, e.g. TITLE_PREFIX=Staging gives
# "Staging Ari", so staging runs the exact prod image yet never passes for
# prod. Unset, as in prod, the page stays as built. A restart is harmless:
# once renamed, the original title no longer matches.
set -eu
[ -n "${TITLE_PREFIX:-}" ] || exit 0
sed -i "s|<title>Ari</title>|<title>${TITLE_PREFIX} Ari</title>|" /usr/share/nginx/html/index.html
