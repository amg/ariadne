#!/usr/bin/env bash
# sweep: list anything tagged app or load that outlived its teardown; deletes nothing.
source "$(dirname "${BASH_SOURCE[0]}")/../lib/command.sh"

# What to do with a leftover is the operator's call. The tagging index lags
# deletions by up to an hour and lists deregistered task definitions forever,
# so each match is checked with its own service.
main() {
  begin 0 0 "$@"
  step "Sweep: anything tagged app or load that is still there"
  local arn found=0
  for arn in $(aws resourcegroupstaggingapi get-resources \
    --tag-filters "Key=$LIFETIME_TAG,Values=app,load" \
    --query 'ResourceTagMappingList[].ResourceARN' --output text); do
    still_there "$arn" || continue
    info "leftover: $arn"
    found=1
  done
  [[ "$found" == 1 ]] || info "nothing left behind in AWS"

  local zone records
  zone="$(cloudflare_zone_id)"
  records="$(cloudflare_api "/zones/$zone/dns_records?name=$HOSTNAME_FQDN" | jq '.result | length')"
  if [[ "$records" == "0" ]]; then
    info "nothing left behind at Cloudflare"
  else
    info "leftover: a DNS record for $HOSTNAME_FQDN (run: aws-prod down)"
  fi
}

# Whether a resource the tagging index lists really exists. Types not named
# here are taken at the index's word.
still_there() { # <arn>
  local arn="$1" id="${1##*/}" state path
  case "$arn" in
    *:ecs:*:task-definition/*) return 1 ;; # deregistered, never deleted, free
    *:ecs:*:cluster/*)
      state="$(aws ecs describe-clusters --clusters "$arn" --query 'clusters[0].status' --output text 2>/dev/null)"
      [[ "$state" == ACTIVE || "$state" == PROVISIONING ]] ;;
    *:ecs:*:service/*)
      path="${arn#*:service/}"
      state="$(aws ecs describe-services --cluster "${path%%/*}" --services "$arn" \
        --query 'services[0].status' --output text 2>/dev/null)"
      [[ "$state" == ACTIVE || "$state" == DRAINING ]] ;;
    *:ec2:*:instance/*)
      state="$(aws ec2 describe-instances --instance-ids "$id" \
        --query 'Reservations[0].Instances[0].State.Name' --output text 2>/dev/null)"
      [[ -n "$state" && "$state" != None && "$state" != terminated ]] ;;
    *:ec2:*:vpc-endpoint/*)
      state="$(aws ec2 describe-vpc-endpoints --vpc-endpoint-ids "$id" \
        --query 'VpcEndpoints[0].State' --output text 2>/dev/null)"
      [[ -n "$state" && "$state" != None && "${state,,}" != deleted ]] ;;
    *:ec2:*:vpc-flow-log/*)
      [[ "$(aws ec2 describe-flow-logs --flow-log-ids "$id" --query 'length(FlowLogs)' --output text 2>/dev/null)" == 1 ]] ;;
    *:ec2:*:subnet/*) aws ec2 describe-subnets --subnet-ids "$id" >/dev/null 2>&1 ;;
    *:ec2:*:vpc/*) aws ec2 describe-vpcs --vpc-ids "$id" >/dev/null 2>&1 ;;
    *:ec2:*:security-group/*) aws ec2 describe-security-groups --group-ids "$id" >/dev/null 2>&1 ;;
    *) return 0 ;;
  esac
}

main "$@"; exit
