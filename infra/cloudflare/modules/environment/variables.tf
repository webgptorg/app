locals {
  domain_pattern = "^([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,63}$"
  email_pattern  = "^[a-z0-9._+-]+@([a-z0-9]([a-z0-9-]*[a-z0-9])?\\.)+[a-z]{2,63}$"
}

variable "environment" {
  type = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "account_id" {
  type        = string
  description = "The Cloudflare account of this environment. Each environment has its own, so its tokens cannot reach the other."

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a 32-character Cloudflare account ID; replace the <...> placeholder."
  }
}

variable "engine_domain" {
  type        = string
  description = "Registrable domain used for engine hostnames and nothing else. This stack creates and owns its zone."

  validation {
    condition     = can(regex(local.domain_pattern, var.engine_domain))
    error_message = "engine_domain must be a lower-case domain name; replace the <...> placeholder once the domain is chosen."
  }
}

variable "dashboard_zone" {
  type        = string
  description = "Existing zone that holds the dashboard's custom domain and the email sending domain (ptbk.io in production). This stack adds records to it but does not own it."

  validation {
    condition     = can(regex(local.domain_pattern, var.dashboard_zone))
    error_message = "dashboard_zone must be a lower-case domain name; replace the <...> placeholder."
  }
}

variable "relay_domain" {
  type        = string
  description = "Domain the relay hostnames live under. Must be engine_domain, dashboard_zone or a subdomain of one of them."

  validation {
    condition     = can(regex(local.domain_pattern, var.relay_domain))
    error_message = "relay_domain must be a lower-case domain name; replace the <...> placeholder."
  }
}

variable "relays" {
  type = map(object({
    ipv4        = string
    ipv6        = string
    in_rotation = bool
  }))
  description = "Relays by host label (relay-fsn becomes relay-fsn.<relay_domain>). in_rotation = false takes a relay out of the engine wildcard but keeps its own hostname."

  validation {
    condition     = alltrue([for name, _ in var.relays : can(regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?$", name))])
    error_message = "Relay names must be single lower-case DNS labels."
  }

  validation {
    condition = alltrue([
      for relay in var.relays :
      can(regex("^[0-9.]+$", relay.ipv4)) && can(cidrhost("${relay.ipv4}/32", 0))
      && can(regex("^[0-9a-f:]+$", relay.ipv6)) && can(cidrhost("${relay.ipv6}/128", 0))
    ])
    error_message = "Every relay needs a valid IPv4 and lower-case IPv6 address; replace the <...> placeholders with I-01's host addresses."
  }

  validation {
    condition     = length([for relay in var.relays : relay if relay.in_rotation]) > 0
    error_message = "At least one relay must stay in rotation; an empty wildcard takes every engine offline."
  }
}

variable "security_contact" {
  type        = string
  description = "Address CAs report refused certificate requests to (CAA iodef)."

  validation {
    condition     = can(regex(local.email_pattern, var.security_contact))
    error_message = "security_contact must be an email address; replace the <...> placeholder."
  }
}

variable "dnssec" {
  type        = bool
  description = "Sign the engine zone. Takes effect only once the DS record from the dnssec_ds output is set at the registrar."
  default     = true
}

variable "email_sending_domain" {
  type        = string
  description = "Domain the dashboard sends mail from through Cloudflare Email Service. Inside dashboard_zone, never under engine_domain."

  validation {
    condition     = can(regex(local.domain_pattern, var.email_sending_domain))
    error_message = "email_sending_domain must be a lower-case domain name; replace the <...> placeholder."
  }
}

variable "dmarc_policy" {
  type        = string
  description = "DMARC policy for the sending domain. Raise to reject once a test message passes SPF, DKIM and DMARC."
  default     = "none"

  validation {
    condition     = contains(["none", "quarantine", "reject"], var.dmarc_policy)
    error_message = "dmarc_policy must be none, quarantine or reject."
  }
}

variable "dmarc_report_address" {
  type        = string
  description = "Mailbox for aggregate DMARC reports (rua), or null for none."
  default     = null

  validation {
    condition     = var.dmarc_report_address == null || can(regex(local.email_pattern, coalesce(var.dmarc_report_address, "-")))
    error_message = "dmarc_report_address must be an email address or null."
  }
}

variable "extra_records" {
  type = list(object({
    zone     = string
    name     = string
    type     = string
    content  = string
    priority = optional(number)
    proxied  = optional(bool, false)
    ttl      = optional(number, 3600)
  }))
  description = "Further records, such as site verification TXT records for abuse monitoring (I-05). zone is engine or dashboard; name is fully qualified."
  default     = []

  validation {
    condition     = alltrue([for record in var.extra_records : contains(["engine", "dashboard"], record.zone)])
    error_message = "extra_records zone must be engine or dashboard."
  }
}
