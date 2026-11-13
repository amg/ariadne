variable "zone_id" {
  description = "The Cloudflare zone aws-prod's hostname lives in"
  type        = string
}

variable "hostname" {
  description = "aws-prod's public hostname"
  type        = string
}

variable "edge_region" {
  description = "The only region CloudFront takes a certificate from"
  type        = string
}

variable "tags" {
  description = "Tags for every AWS resource, marking it as core's"
  type        = map(string)
}
