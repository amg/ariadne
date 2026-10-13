# aws-prod at the edge. While up, all five below; on teardown the hostname
# is parked at an address nothing answers on and the rest is removed, so
# the name never stops resolving and no resolver caches it as missing.
#
#   1. The hostname, proxied by Cloudflare, pointing at the load balancer.
#   2. Cloudflare presents aws-prod's client certificate on this hostname.
#   3. Strict TLS to the origin, for this hostname only.
#   4. An allow-list: only the operator and the run's load generators.
#   5. A rate limit on sign-in, keyed on the real client address. Off by
#      default: the Free plan cannot express it (see edge_rate_limit).
#
# 3, 4 and 5 live in the zone's phase entrypoints, which a zone has one of
# each. Preflight refuses to raise when another owner already holds them.

terraform {
  required_version = ">= 1.10"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.52" }
  }
  backend "s3" {
    key          = "cloudflare/app.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}

provider "cloudflare" {}

locals {
  this_hostname = "http.host eq \"${var.hostname}\""
  is_load       = "any(http.request.headers[\"${var.load_key_header}\"][*] eq \"${var.run_key}\")"
  is_operator   = "ip.src in {${join(" ", var.operator_ips)}}"
}

# ── 1. The hostname ──────────────────────────────────────────────────────

resource "cloudflare_record" "hostname" {
  zone_id = var.zone_id
  name    = var.hostname
  type    = var.parked ? "A" : "CNAME"
  content = var.parked ? "192.0.2.1" : var.origin_dns_name
  proxied = true
  ttl     = 1
  comment = var.parked ? "aws-prod parked; errors until the next raise" : "aws-prod active origin; parked on teardown"
}

# ── 2. Client certificate on this hostname ───────────────────────────────

resource "cloudflare_authenticated_origin_pulls" "hostname" {
  count                                  = var.parked ? 0 : 1
  zone_id                                = var.zone_id
  hostname                               = var.hostname
  authenticated_origin_pulls_certificate = var.client_certificate_id
  enabled                                = true
}

# ── 3. Strict TLS to the origin ──────────────────────────────────────────

resource "cloudflare_ruleset" "origin_tls" {
  count   = var.parked ? 0 : 1
  zone_id = var.zone_id
  name    = "aws-prod origin TLS"
  kind    = "zone"
  phase   = "http_config_settings"

  rules {
    description = "aws-prod: strict TLS to the origin"
    expression  = local.this_hostname
    action      = "set_config"
    action_parameters {
      ssl = "strict"
    }
  }
}

# ── 4. Allow-list ────────────────────────────────────────────────────────

resource "cloudflare_ruleset" "allow_list" {
  count   = var.parked ? 0 : 1
  zone_id = var.zone_id
  name    = "aws-prod allow-list"
  kind    = "zone"
  phase   = "http_request_firewall_custom"

  rules {
    description = "aws-prod: only the operator and this run's load generators"
    enabled     = var.allow_list_enabled
    expression  = "${local.this_hostname} and not (${local.is_operator} or ${local.is_load})"
    action      = "block"
  }

  lifecycle {
    precondition {
      condition     = var.parked || var.allow_list_enabled || var.edge_rate_limit
      error_message = "Opening aws-prod (allow_list_enabled=false) leaves sign-in unlimited unless edge_rate_limit is on."
    }
  }
}

# ── 5. Sign-in rate limit ────────────────────────────────────────────────

resource "cloudflare_ruleset" "auth_rate_limit" {
  count   = (!var.parked && var.edge_rate_limit) ? 1 : 0
  zone_id = var.zone_id
  name    = "aws-prod auth rate limit"
  kind    = "zone"
  phase   = "http_ratelimit"

  rules {
    description = "aws-prod: sign-in and refresh, per client address"
    expression  = "${local.this_hostname} and starts_with(http.request.uri.path, \"/api/auth/\") and not ${local.is_load}"
    action      = "block"
    ratelimit {
      characteristics     = ["ip.src", "cf.colo.id"]
      period              = 60
      requests_per_period = var.auth_requests_per_minute
      mitigation_timeout  = 60
    }
  }
}
