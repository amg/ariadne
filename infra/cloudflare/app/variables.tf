variable "zone_id" {
  type = string
}

variable "hostname" {
  type = string
}

variable "distribution_dns_name" {
  description = "The distribution's *.cloudfront.net name, from the app stack"
  type        = string
  default     = "distribution.invalid"
}

variable "parked" {
  description = "When true, parks the hostname at dummy IP 192.0.2.1"
  type        = bool
  default     = false
}
