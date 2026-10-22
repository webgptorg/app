terraform {
  required_version = "~> 1.10"

  required_providers {
    hcloud = {
      source  = "hetznercloud/hcloud"
      version = "1.70.0"
    }
  }

  # The same R2 bucket as infra/cloudflare, in the staging Cloudflare account, under its own key (ADR 0011).
  # Credentials come from AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY: an R2 token for this bucket only.
  backend "s3" {
    bucket                      = "ptbk-tofu-state-staging"
    key                         = "relay/terraform.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "https://<staging-account-id>.r2.cloudflarestorage.com" }
    use_path_style              = true
    use_lockfile                = true
    skip_credentials_validation = true
    skip_region_validation      = true
    skip_requesting_account_id  = true
    skip_metadata_api_check     = true
    skip_s3_checksum            = true
  }

  encryption {
    key_provider "pbkdf2" "state" {
      passphrase = var.state_passphrase
    }

    method "aes_gcm" "state" {
      keys = key_provider.pbkdf2.state
    }

    state {
      method   = method.aes_gcm.state
      enforced = true
    }

    plan {
      method   = method.aes_gcm.state
      enforced = true
    }
  }
}

variable "state_passphrase" {
  type        = string
  sensitive   = true
  description = "Encrypts state and plan files. Set TF_VAR_state_passphrase from the team password manager."
}

# The modules validate these and refuse the <...> placeholders in terraform.tfvars, so a plan fails before it
# touches anything while any is left.
variable "relays" {}
variable "relay_domain" {}
variable "engine_domain" {}
variable "registry_url" {}
variable "acme_email" {}
variable "admins" {}
variable "deploy_key" {}
variable "ssh_allowlist" {}
variable "server_type" {}

variable "relay_settings" {
  description = "Relay limits tuned by I-05 (RELAY_* names), empty until then."
  default     = {}
}

# Token from HCLOUD_TOKEN: read and write on the staging Hetzner project only (README, Credentials).
provider "hcloud" {}

module "environment" {
  source = "../../modules/environment"

  environment   = "staging"
  relays        = var.relays
  relay_domain  = var.relay_domain
  engine_domain = var.engine_domain
  registry_url  = var.registry_url
  acme_email    = var.acme_email
  admins        = var.admins
  deploy_key    = var.deploy_key
  ssh_allowlist = var.ssh_allowlist
  server_type   = var.server_type

  relay_settings = var.relay_settings
}

output "relays" {
  description = "Hostnames and addresses; the addresses go into infra/cloudflare's relays variable."
  value       = module.environment.relays
}
