terraform {
  required_version = "~> 1.10"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.27.0"
    }
  }

  # R2 bucket in the production account, created by hand once (README, Bootstrap). Credentials come from
  # AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY: an R2 token for this bucket only.
  backend "s3" {
    bucket                      = "ptbk-tofu-state-production"
    key                         = "cloudflare/terraform.tfstate"
    region                      = "auto"
    endpoints                   = { s3 = "https://<production-account-id>.r2.cloudflarestorage.com" }
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

# The module validates these and refuses the <...> placeholders in terraform.tfvars, so a plan fails before it
# touches anything while any is left.
variable "account_id" {}
variable "engine_domain" {}
variable "dashboard_zone" {}
variable "relay_domain" {}
variable "email_sending_domain" {}
variable "dmarc_policy" {}
variable "security_contact" {}
variable "relays" {}
variable "ops_email" {
  default = null
}
variable "relay_dns_mode" {}
variable "psl_pull_request" {
  default = null
}

# Token from CLOUDFLARE_API_TOKEN: the production IaC token (README, API tokens).
provider "cloudflare" {}

module "environment" {
  source = "../../modules/environment"

  environment          = "production"
  account_id           = var.account_id
  engine_domain        = var.engine_domain
  dashboard_zone       = var.dashboard_zone
  relay_domain         = var.relay_domain
  email_sending_domain = var.email_sending_domain
  dmarc_policy         = var.dmarc_policy
  security_contact     = var.security_contact
  relays               = var.relays
  ops_email            = var.ops_email
  relay_dns_mode       = var.relay_dns_mode
  psl_pull_request     = var.psl_pull_request
}

output "engine_name_servers" {
  value = module.environment.engine_name_servers
}

output "dnssec_ds" {
  value = module.environment.dnssec_ds
}

output "d1_database_id" {
  value = module.environment.d1_database_id
}

output "relay_hostnames" {
  value = module.environment.relay_hostnames
}

output "email_dkim_selector" {
  value = module.environment.email_dkim_selector
}

output "email_return_path_domain" {
  value = module.environment.email_return_path_domain
}
