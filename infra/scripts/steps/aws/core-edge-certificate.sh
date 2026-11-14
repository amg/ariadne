# The hostname's certificate, carried from Terraform's state to where the
# app stack reads it.

publish_edge_certificate() {
  step "Core: the certificate's ARN into parameters"
  local arn
  arn="$(run_terraform core output -raw edge_certificate_arn)"
  put_parameter "$PARAM_EDGE_CERT" String "$arn"
  info "$arn"
}
