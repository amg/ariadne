# aws-prod's origin identity, carried from Cloudflare's Terraform state into AWS.

# The load balancer presents the certificate Cloudflare's Origin CA signed.
# Re-importing into the same ARN keeps every reference to it valid.
import_origin_certificate() {
  step "Core: origin certificate into ACM"
  local existing arn target
  existing="$(parameter "$PARAM_ORIGIN_CERT" 2>/dev/null || true)"
  if [[ -n "$existing" ]]; then
    target=(--certificate-arn "$existing")
  else
    target=(--tags "Key=$LIFETIME_TAG,Value=core")
  fi

  # The key is streamed straight from Terraform's state; it never touches the disk.
  arn="$(aws acm import-certificate "${target[@]}" \
    --certificate fileb://<(run_terraform core output -raw origin_certificate_pem) \
    --private-key fileb://<(run_terraform core output -raw origin_private_key_pem) \
    --query CertificateArn --output text)"
  put_parameter "$PARAM_ORIGIN_CERT" String "$arn"
  info "$arn"
}

# The load balancer trusts only client certificates this authority signed.
publish_client_authority() {
  step "Core: client-certificate authority into the vault"
  run_terraform core output -raw client_authority_pem |
    aws s3 cp - "s3://$(vault_bucket)/$ORIGIN_TRUST_KEY" --quiet
}

# The certificate load generators present on the direct path, where the
# generator task reads it. Like the origin key, it never touches the disk.
publish_load_client_certificate() {
  step "Core: load generators' client certificate into parameters"
  aws ssm put-parameter --name "$PARAM_LOAD_CLIENT_CERT" --type SecureString --overwrite \
    --value file://<(run_terraform core output -raw load_client_certificate_pem) >/dev/null
  aws ssm put-parameter --name "$PARAM_LOAD_CLIENT_KEY" --type SecureString --overwrite \
    --value file://<(run_terraform core output -raw load_client_private_key_pem) >/dev/null
}
