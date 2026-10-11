variable "zone_id" {
  type = string
}

variable "hostname" {
  type = string
}

variable "origin_dns_name" {
  description = "The load balancer's DNS name, from the app stack"
  type        = string
}

variable "client_certificate_id" {
  description = "The client certificate uploaded by the core root"
  type        = string
}

variable "operator_ips" {
  description = "Addresses the operator browses from"
  type        = list(string)
}

variable "load_key_header" {
  type = string
}

variable "run_key" {
  description = "This raise's load key; generators send it in the load key header"
  type        = string
  sensitive   = true
}

variable "allow_list_enabled" {
  description = "Switch off only to open aws-prod to anyone who finds it"
  type        = bool
  default     = true
}

# Off by default because the zone is on Cloudflare's Free plan. There a
# rate-limit rule may only test the URL path, so it can neither be held to
# aws-prod's hostname (it would limit /api/auth/ on every hostname in the
# zone) nor let the load generators through: each one signs in thousands of
# users from one address and would be blocked within seconds. Even Business
# cannot test a request header here; that takes Enterprise.
#
# Nothing is lost while the allow-list is on: only the operator and this
# run's generators reach the hostname at all. The app still leaves its own
# sign-in limit off (AUTH_RATE_LIMIT_AT_EDGE=true), since it would count
# every generator's sign-ins against one address too. Opening the hostname
# therefore requires turning this on, which needs a plan that allows it or
# a custom rule that skips the rate-limit phase for the generators.
variable "edge_rate_limit" {
  description = "Limit sign-in per client address at the edge; see the note above before enabling"
  type        = bool
  default     = false
}

variable "auth_requests_per_minute" {
  type    = number
  default = 20
}
