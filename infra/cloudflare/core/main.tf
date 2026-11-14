# aws-prod's certificate. Lives with core: it costs nothing, and keeping it
# means a raise never waits on issuance.
#
#   1. The certificate CloudFront presents for the hostname. ACM issues and
#      renews it in the edge's region, the only one CloudFront takes it from.
#   2. The DNS record that proves the hostname is ours, kept in the zone so
#      ACM can renew the certificate on its own.

terraform {
  required_version = ">= 1.10"
  required_providers {
    aws        = { source = "hashicorp/aws", version = "~> 6.0" }
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.52" }
  }
  # Bucket and region are passed by the core command: the bucket name carries the account id.
  backend "s3" {
    key          = "cloudflare/core.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}

provider "aws" {
  region = var.edge_region
  default_tags {
    tags = var.tags
  }
}

provider "cloudflare" {}

# ── 1. Certificate ───────────────────────────────────────────────────────

resource "aws_acm_certificate" "edge" {
  domain_name       = var.hostname
  validation_method = "DNS"

  lifecycle {
    create_before_destroy = true
  }
}

# ── 2. Proof of the hostname ─────────────────────────────────────────────

resource "cloudflare_record" "certificate_validation" {
  for_each = {
    for option in aws_acm_certificate.edge.domain_validation_options : option.domain_name => option
  }
  zone_id = var.zone_id
  name    = trimsuffix(each.value.resource_record_name, ".")
  type    = each.value.resource_record_type
  content = trimsuffix(each.value.resource_record_value, ".")
  proxied = false
  ttl     = 60
  comment = "aws-prod: proves the hostname to ACM; keep for renewals"
}

resource "aws_acm_certificate_validation" "edge" {
  certificate_arn         = aws_acm_certificate.edge.arn
  validation_record_fqdns = [for record in cloudflare_record.certificate_validation : record.hostname]
}
