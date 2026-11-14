# aws-prod's hostname in Cloudflare's DNS. While up, it points at the
# distribution; on teardown it is parked at an address nothing answers on,
# so the name never stops resolving and no resolver caches it as missing.
# Cloudflare only answers for the name: CloudFront ends TLS and its web ACL
# decides who gets in.

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

resource "cloudflare_record" "hostname" {
  zone_id = var.zone_id
  name    = var.hostname
  type    = var.parked ? "A" : "CNAME"
  content = var.parked ? "192.0.2.1" : var.distribution_dns_name
  # Answered by DNS alone: a short life lets a new raise's distribution take over quickly.
  proxied = false
  ttl     = 60
  comment = var.parked ? "aws-prod parked; errors until the next raise" : "aws-prod's distribution; parked on teardown"
}
