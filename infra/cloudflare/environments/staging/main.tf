terraform {
  required_version = "~> 1.10"

  required_providers {
    cloudflare = {
      source  = "cloudflare/cloudflare"
      version = "5.27.0"
    }
  }

  # R2 bucket in the staging account, created by hand once (README, Bootstrap). Credentials come from
  # AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY: an R2 token for this bucket only.
  backend "s3" {
    bucket                      = "ptbk-tofu-state-staging"
    key                         = "cloudflare/terraform.tfstate"
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

# The module validates these and refuses the <...> placeholders in terraform.tfvars, so a plan fails before it
# touches anything while any is left.
variable "account_id" {}
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

# Token from CLOUDFLARE_API_TOKEN: the staging IaC token (README, API tokens).
provider "cloudflare" {}

# Staging runs on one domain (decided 2026-11-06): the engines are a subdomain of the staging zone rather than a
# registrable domain of their own, so there is no engine zone, DNSSEC or PSL entry (README, Staging: one domain).
module "environment" {
  source = "../../modules/environment"

  environment          = "staging"
  account_id           = var.account_id
  engine_domain        = "engines.${var.dashboard_zone}"
  engine_zone_mode     = "subdomain"
  dashboard_zone       = var.dashboard_zone
  relay_domain         = var.relay_domain
  email_sending_domain = var.email_sending_domain
  dmarc_policy         = var.dmarc_policy
  security_contact     = var.security_contact
  relays               = var.relays
  ops_email            = var.ops_email
  relay_dns_mode       = var.relay_dns_mode

  # Created by hand (docs/staging-runbook.md step 3); engines get the ui_release_url output as PTBK_UI_RELEASE_URL.
  ui_releases = { bucket = "ptbk-ui-releases-staging", hostname = "ui.${var.dashboard_zone}" }
}

output "staging_zone_id" {
  value = module.environment.dashboard_zone_id
}

output "d1_database_id" {
  value = module.environment.d1_database_id
}

output "ui_release_url" {
  value = module.environment.ui_release_url
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
