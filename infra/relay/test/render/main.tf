# Renders one host's user data with fixed, credential-free values, for the checks in scripts/check.sh and the VM test
# (test/vm-test.sh). Public keys of throwaway key pairs (private halves discarded) and documentation addresses only.
terraform {
  required_version = "~> 1.10"
}

variable "admin_key" {
  type    = string
  default = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIODl1HFc9w2tQEYLZv2a7Q6WsBdDk0Rgoxk/YQuqGbj+ ci-admin"
}

variable "deploy_key" {
  type    = string
  default = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEAvFcF9TjUmm57Av3oVnBfv6lwzliXetJmpL5iZ/p0m ci-deploy"
}

variable "ssh_allowlist" {
  type    = list(string)
  default = ["192.0.2.0/24", "2001:db8:22::/48"]
}

module "host" {
  source = "../../modules/cloud-init"

  name          = "relay-ci"
  relay_domain  = "relays.ptbk.test"
  engine_domain = "engines.ptbk.test"
  registry_url  = "https://app.ptbk.test"
  acme_email    = "ops@ptbk.test"
  admins        = { ci = [var.admin_key] }
  deploy_key    = var.deploy_key
  ssh_allowlist = var.ssh_allowlist
  reboot_time   = "02:00"
}

output "user_data" {
  value = module.host.user_data
}
