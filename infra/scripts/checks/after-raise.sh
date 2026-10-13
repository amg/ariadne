# Checks run after every raise: aws-prod answers through Cloudflare, and
# only through Cloudflare.

verify_raise() {
  step "Verify: reachable through Cloudflare"
  wait_for_health "https://$HOSTNAME_FQDN/api/health"

  step "Verify: unreachable around Cloudflare"
  local origin
  origin="$(stack_output "$APP_STACK" "$OUT_ORIGIN_DNS_NAME")"
  if curl -sS --max-time 10 -o /dev/null "https://$origin/api/health" 2>/dev/null; then
    fail "The origin answered a direct request; it must refuse anyone but Cloudflare"
  fi
  info "the origin refused a direct connection"
}

# Resolved through Cloudflare's own DNS rather than the local resolver: on
# a hostname's first raise, a resolver that looked it up before it existed
# keeps answering "no such name" for up to half an hour.
wait_for_health() { # <url>
  local attempt
  for attempt in $(seq 1 30); do
    if [[ "$(curl -sS --max-time 10 --doh-url https://cloudflare-dns.com/dns-query \
      -o /dev/null -w '%{http_code}' "$1" 2>/dev/null)" == "200" ]]; then
      info "$1 answered 200"
      return 0
    fi
    sleep 10
  done
  fail "$1 never answered 200 (tried $attempt times)"
}
