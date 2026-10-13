output "origin_certificate_pem" {
  description = "Imported into ACM for the load balancer's listener"
  value       = cloudflare_origin_ca_certificate.origin.certificate
}

output "origin_private_key_pem" {
  value     = tls_private_key.origin.private_key_pem
  sensitive = true
}

output "client_authority_pem" {
  description = "Uploaded to the vault bucket as the load balancer's trust store"
  value       = tls_self_signed_cert.client_authority.cert_pem
}

output "client_certificate_id" {
  description = "Bound to the hostname by the app root on every raise"
  value       = cloudflare_authenticated_origin_pulls_certificate.client.id
}

output "load_client_certificate_pem" {
  description = "Stored as a parameter for load generators on the direct path"
  value       = tls_locally_signed_cert.load_client.cert_pem
}

output "load_client_private_key_pem" {
  value     = tls_private_key.load_client.private_key_pem
  sensitive = true
}
