# Checks run after every raise: aws-prod answers through Cloudflare, and
# only through Cloudflare, and the load balancer holds the capacity its
# step reserves.

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

  wait_for_reserved_capacity
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

# A load balancer's reserved capacity takes some minutes to take hold after
# the stack is up, one availability zone at a time. Load sent before then
# meets the load balancer at its small size, which is what the reservation
# is there to prevent.
wait_for_reserved_capacity() {
  [[ "${STEP_LB_RESERVED_UNITS:-0}" != 0 ]] || return 0
  step "Verify: the load balancer's $STEP_LB_RESERVED_UNITS reserved capacity units have taken hold"
  local arn states attempt
  arn="$(origin_load_balancer_field LoadBalancerArn)" ||
    fail "Could not look up the origin's load balancer"
  [[ -n "$arn" ]] || fail "No load balancer has the origin's address"
  for attempt in $(seq 1 60); do
    states="$(aws elbv2 describe-capacity-reservation --load-balancer-arn "$arn" \
      --query 'CapacityReservationState[].State.Code' --output text)" ||
      fail "Could not read the load balancer's capacity reservation"
    if [[ "$states" == *failed* ]]; then
      fail "The load balancer could not reserve its capacity ($states). Run: aws elbv2 describe-capacity-reservation --load-balancer-arn $arn"
    fi
    if [[ -n "$states" && -z "$(tr '\t ' '\n\n' <<<"$states" | grep -v -e '^provisioned$' -e '^$')" ]]; then
      info "every zone holds its reserved capacity ($states)"
      return 0
    fi
    info "waiting for the reservation to take hold: ${states:-none reported yet}"
    sleep 20
  done
  fail "The load balancer's reserved capacity did not take hold in 20 minutes (tried $attempt times; last: $states)"
}
