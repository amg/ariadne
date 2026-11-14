output "edge_certificate_arn" {
  description = "Stored as a parameter for the distribution, once ACM has issued it"
  value       = aws_acm_certificate_validation.edge.certificate_arn
}
