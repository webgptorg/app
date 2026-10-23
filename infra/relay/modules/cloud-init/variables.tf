locals {
  domain_pattern  = "^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,63}$"
  email_pattern   = "^[a-z0-9._+-]+@([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,63}$"
  ssh_key_pattern = "^(ssh-ed25519|ecdsa-sha2-nistp256|sk-ssh-ed25519@openssh\\.com|sk-ecdsa-sha2-nistp256@openssh\\.com) [A-Za-z0-9+/]+={0,3}( [ -~]*)?$"
  user_pattern    = "^[a-z][a-z0-9-]{0,30}$"

  # Written by this module, so tfvars cannot override them through relay_settings.
  managed_settings = [
    "RELAY_HOSTNAME", "RELAY_ENGINE_DOMAIN", "RELAY_LISTEN_HOST", "RELAY_LISTEN_PORT", "RELAY_TLS_CERT_FILE",
    "RELAY_TLS_KEY_FILE", "RELAY_REGISTRY_KIND", "RELAY_REGISTRY_FILE", "RELAY_REGISTRY_URL", "RELAY_REGISTRY_TOKEN",
    "RELAY_REGISTRY_TOKEN_FILE", "RELAY_DNS_SERVERS", "RELAY_MAX_CONNECTIONS", "RELAY_MEMORY_BUDGET_BYTES",
    "RELAY_METRICS_TOKEN", "RELAY_METRICS_TOKEN_FILE",
  ]
}

variable "name" {
  type        = string
  description = "Host label, such as relay-fsn; the relay's hostname is <name>.<relay_domain>."

  validation {
    condition     = can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", var.name)) && length(var.name) <= 63
    error_message = "name must be a single lower-case DNS label."
  }
}

variable "relay_domain" {
  type        = string
  description = "Domain the relay hostnames live under (I-02). Never the engine domain or a name under it."

  validation {
    condition     = can(regex(local.domain_pattern, var.relay_domain))
    error_message = "relay_domain must be a lower-case domain name; replace the <...> placeholder."
  }
}

variable "engine_domain" {
  type        = string
  description = "The engine domain (I-02). The relay routes <engineId>.<engine_domain> without decrypting it."

  validation {
    condition     = can(regex(local.domain_pattern, var.engine_domain))
    error_message = "engine_domain must be a lower-case domain name; replace the <...> placeholder."
  }
}

variable "registry_url" {
  type        = string
  description = "The dashboard's base URL for the registry API (D-04), https only."

  validation {
    condition     = can(regex("^https://([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,63}(:[0-9]{1,5})?(/[A-Za-z0-9._~-]+)*/?$", var.registry_url))
    error_message = "registry_url must be an https URL without credentials, query or fragment; replace the <...> placeholder."
  }
}

variable "acme_email" {
  type        = string
  description = "Contact address of the relay's ACME account."

  validation {
    condition     = can(regex(local.email_pattern, var.acme_email))
    error_message = "acme_email must be an email address; replace the <...> placeholder."
  }
}

variable "acme_server" {
  type        = string
  description = "ACME directory for the relay certificate."
  default     = "https://acme-v02.api.letsencrypt.org/directory"

  validation {
    condition     = can(regex("^https://[a-z0-9.-]+(:[0-9]+)?/[A-Za-z0-9._~/-]*$", var.acme_server))
    error_message = "acme_server must be an https URL."
  }
}

variable "admins" {
  type        = map(list(string))
  description = "Admin users by name, each with their SSH public keys. Keys only: no user has a password."

  validation {
    condition     = length(var.admins) > 0 && alltrue([for name, keys in var.admins : length(keys) > 0])
    error_message = "At least one admin with at least one key is required."
  }

  validation {
    condition = alltrue([
      for name, _ in var.admins : can(regex(local.user_pattern, name)) && !contains(["root", "ptbk-deploy", "ptbk-relay"], name)
    ])
    error_message = "Admin names must be lower-case user names other than root, ptbk-deploy and ptbk-relay."
  }

  validation {
    condition     = alltrue(flatten([for keys in values(var.admins) : [for key in keys : can(regex(local.ssh_key_pattern, key))]]))
    error_message = "Admin keys must be ed25519 or ECDSA P-256 public keys (hardware-backed sk- keys welcome), without options; replace the <...> placeholders."
  }
}

variable "deploy_key" {
  type        = string
  description = "Public key of the CI deploy key (I-03). It can only run the forced deploy command."

  validation {
    condition     = can(regex(local.ssh_key_pattern, var.deploy_key))
    error_message = "deploy_key must be an ed25519 or ECDSA P-256 public key without options; replace the <...> placeholder."
  }
}

variable "ssh_allowlist" {
  type        = list(string)
  description = "Networks that may reach SSH, in canonical CIDR form."

  validation {
    condition     = length(var.ssh_allowlist) > 0
    error_message = "ssh_allowlist must not be empty."
  }

  validation {
    condition = alltrue([
      for cidr in var.ssh_allowlist : can(cidrsubnet(cidr, 0, 0)) && try(cidrsubnet(cidr, 0, 0) == cidr, false)
    ])
    error_message = "ssh_allowlist entries must be CIDRs in canonical form (network address, lower-case, compressed IPv6); replace the <...> placeholders."
  }

  validation {
    condition     = alltrue([for cidr in var.ssh_allowlist : tonumber(split("/", cidr)[1]) >= (strcontains(cidr, ":") ? 32 : 8)])
    error_message = "ssh_allowlist entries must be no wider than /8 (IPv4) or /32 (IPv6): SSH is never open to the world."
  }
}

variable "reboot_time" {
  type        = string
  description = "HH:MM (UTC) at which unattended upgrades may reboot this host. Hosts of one environment need different times; the certificate renewal runs an hour later."

  validation {
    condition     = can(regex("^([01][0-9]|2[0-3]):[0-5][0-9]$", var.reboot_time))
    error_message = "reboot_time must be HH:MM."
  }
}

variable "max_connections" {
  type        = number
  description = "RELAY_MAX_CONNECTIONS: open connections, tunnels included."
  default     = 10000
}

variable "nofile" {
  type        = number
  description = "File descriptor limit of the relay process; at least four times max_connections."
  default     = 65536
}

variable "memory_max_mib" {
  type        = number
  description = "Memory limit of the relay container."
  default     = 3072
}

variable "heap_mib" {
  type        = number
  description = "--max-old-space-size of the relay's Node process."
  default     = 1024
}

variable "memory_budget_mib" {
  type        = number
  description = "RELAY_MEMORY_BUDGET_BYTES in MiB: the buffers the relay holds for others, outside the V8 heap."
  default     = 1024
}

variable "relay_settings" {
  type        = map(string)
  description = "Further relay settings (RELAY_* limits, LOG_LEVEL), such as the values I-05 tunes."
  default     = {}

  validation {
    condition = alltrue([
      for name, value in var.relay_settings :
      can(regex("^(RELAY_[A-Z0-9_]+|LOG_LEVEL)$", name)) && !contains(local.managed_settings, name) && can(regex("^[!-~]+$", value))
    ])
    error_message = "relay_settings takes RELAY_* names (and LOG_LEVEL) that this module does not set itself, with single-word printable values."
  }
}
