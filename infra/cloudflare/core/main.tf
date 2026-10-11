# aws-prod's origin identity at Cloudflare. Lives with core: certificates
# cost nothing, and keeping them means a raise never waits on issuance.
#
#   1. The origin certificate the load balancer presents. Cloudflare's
#      Origin CA signs it, and Cloudflare trusts it in strict TLS mode.
#   2. A private certificate authority, and a client certificate it signs,
#      which Cloudflare presents when it connects to this hostname only.
#      The load balancer trusts nothing else, so no other Cloudflare
#      customer's zone can reach the origin.

terraform {
  required_version = ">= 1.10"
  required_providers {
    cloudflare = { source = "cloudflare/cloudflare", version = "~> 4.52" }
    tls        = { source = "hashicorp/tls", version = "~> 4.0" }
  }
  # Bucket and region are passed by the core command: the bucket name carries the account id.
  backend "s3" {
    key          = "cloudflare/core.tfstate"
    use_lockfile = true
    encrypt      = true
  }
}

provider "cloudflare" {}

# ── 1. Origin certificate ────────────────────────────────────────────────

resource "tls_private_key" "origin" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_cert_request" "origin" {
  private_key_pem = tls_private_key.origin.private_key_pem
  subject {
    common_name = var.hostname
  }
}

resource "cloudflare_origin_ca_certificate" "origin" {
  csr                = tls_cert_request.origin.cert_request_pem
  hostnames          = [var.hostname]
  request_type       = "origin-rsa"
  requested_validity = 5475
}

# ── 2. Client certificate Cloudflare presents to the origin ──────────────

resource "tls_private_key" "client_authority" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_self_signed_cert" "client_authority" {
  private_key_pem       = tls_private_key.client_authority.private_key_pem
  is_ca_certificate     = true
  validity_period_hours = 87600
  allowed_uses          = ["cert_signing", "crl_signing"]
  subject {
    common_name  = "${var.hostname} origin client authority"
    organization = "aws-prod"
  }
}

resource "tls_private_key" "client" {
  algorithm = "RSA"
  rsa_bits  = 2048
}

resource "tls_cert_request" "client" {
  private_key_pem = tls_private_key.client.private_key_pem
  subject {
    common_name = "cloudflare-to-${var.hostname}"
  }
}

resource "tls_locally_signed_cert" "client" {
  cert_request_pem      = tls_cert_request.client.cert_request_pem
  ca_private_key_pem    = tls_private_key.client_authority.private_key_pem
  ca_cert_pem           = tls_self_signed_cert.client_authority.cert_pem
  validity_period_hours = 43800
  allowed_uses          = ["client_auth", "digital_signature", "key_encipherment"]
}

resource "cloudflare_authenticated_origin_pulls_certificate" "client" {
  zone_id     = var.zone_id
  certificate = tls_locally_signed_cert.client.cert_pem
  private_key = tls_private_key.client.private_key_pem
  type        = "per-hostname"
}
