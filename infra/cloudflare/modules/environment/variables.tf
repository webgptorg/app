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
  description = "The Cloudflare account of this environment. Production has its own, so no other environment's tokens reach it; staging shares an existing account (README, Staging: one domain)."

  validation {
    condition     = can(regex("^[0-9a-f]{32}$", var.account_id))
    error_message = "account_id must be a 32-character Cloudflare account ID; replace the <...> placeholder."
  }
}

variable "engine_domain" {
  type        = string
  description = "Domain used for engine hostnames and nothing else: a registrable domain whose zone this stack creates and owns, or on staging a subdomain of dashboard_zone (engine_zone_mode)."

  validation {
    condition     = can(regex(local.domain_pattern, var.engine_domain))
    error_message = "engine_domain must be a lower-case domain name; replace the <...> placeholder once the domain is chosen."
  }
}

variable "engine_zone_mode" {
  type        = string
  description = "\"own_zone\": the engine domain is a zone of its own, with DNSSEC, Universal SSL off and the PSL record. \"subdomain\" (staging only): its records go into dashboard_zone, without any of those. README, Staging: one domain."
  default     = "own_zone"

  validation {
    condition     = contains(["own_zone", "subdomain"], var.engine_zone_mode)
    error_message = "engine_zone_mode must be own_zone or subdomain."
  }

  # Engines would share their registrable domain, DNSSEC and zone settings with the dashboard (spec, Abuse on our
  # domains, item 1). A relaxation for staging, decided 2026-11-06; production keeps its own zone.
  validation {
    condition     = var.engine_zone_mode == "own_zone" || var.environment != "production"
    error_message = "engine_zone_mode = \"subdomain\" is for staging only; production's engine domain is a zone of its own."
  }

  validation {
    condition     = var.engine_zone_mode == "own_zone" || endswith(var.engine_domain, ".${var.dashboard_zone}")
    error_message = "engine_zone_mode = \"subdomain\" needs engine_domain to be a subdomain of dashboard_zone, such as engines.<dashboard_zone>."
  }

  # The PSL lists registrable boundaries; a subdomain of a zone that also holds the dashboard cannot be one.
  validation {
    condition     = var.engine_zone_mode == "own_zone" || var.psl_pull_request == null
    error_message = "engine_zone_mode = \"subdomain\" takes no psl_pull_request."
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
  description = "Relays by host label (relay-fsn becomes relay-fsn.<relay_domain>). in_rotation = false takes a relay out of the engine wildcard (its records or the load balancer's pools) but keeps its own hostname."

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

variable "ops_email" {
  type        = string
  description = "Ops mailbox (I-04's alerts) that Cloudflare notifies when a relay leaves or rejoins the engine wildcard. Required with relay_dns_mode = \"load_balancer\"."
  default     = null

  validation {
    condition     = var.ops_email == null || can(regex(local.email_pattern, coalesce(var.ops_email, "-")))
    error_message = "ops_email must be an email address; replace the <...> placeholder."
  }
}

variable "relay_dns_mode" {
  type        = string
  description = "How the engine wildcard lists relays: \"load_balancer\" (health-checked, Load Balancing add-on) or \"records\" (plain A and AAAA records). README, Relay DNS."
  default     = "load_balancer"

  validation {
    condition     = contains(["records", "load_balancer"], var.relay_dns_mode)
    error_message = "relay_dns_mode must be records or load_balancer."
  }

  # With one relay the fallback pool always lists it: a load balancer would cost money and drop nothing.
  validation {
    condition     = var.relay_dns_mode != "load_balancer" || length(var.relays) >= 2
    error_message = "relay_dns_mode = \"load_balancer\" needs at least two relays; use \"records\" for a single relay."
  }

  validation {
    condition     = var.relay_dns_mode != "load_balancer" || var.ops_email != null
    error_message = "relay_dns_mode = \"load_balancer\" needs ops_email for the relay health notifications."
  }
}

variable "relay_health_check" {
  type = object({
    interval_s = optional(number, 15)
    regions    = optional(list(string), ["WEU", "EEU", "ENAM"])
  })
  description = "How often and from where Cloudflare checks each relay. Failover takes about interval_s x 2 + 30 s (README, Relay DNS); a shorter interval needs a higher Load Balancing tier."
  default     = {}

  validation {
    condition     = var.relay_health_check.interval_s >= 10 && var.relay_health_check.interval_s <= 60
    error_message = "relay_health_check.interval_s must be between 10 and 60 seconds; slower checks leave a hung relay in DNS for minutes."
  }

  # Cloudflare marks an endpoint unhealthy when most check regions see it fail, so one region's view of the network
  # cannot pull a relay; that takes at least three distinct regions.
  validation {
    condition = (
      length(distinct(var.relay_health_check.regions)) >= 3
      && length(distinct(var.relay_health_check.regions)) == length(var.relay_health_check.regions)
      && alltrue([for region in var.relay_health_check.regions : contains(["WNAM", "ENAM", "WEU", "EEU", "NSAM", "SSAM", "OC", "ME", "NAF", "SAF", "SAS", "SEAS", "NEAS"], region)])
    )
    error_message = "relay_health_check.regions must name at least three distinct Cloudflare check regions (WEU, EEU, ENAM, ...)."
  }
}

variable "dnssec" {
  type        = bool
  description = "Sign the engine zone. Takes effect only once the DS record from the dnssec_ds output is set at the registrar. Ignored with engine_zone_mode = \"subdomain\", where there is no engine zone to sign."
  default     = true
}

variable "psl_pull_request" {
  type        = string
  description = "URL of the publicsuffix/list pull request that adds engine_domain (I-05), published as the _psl TXT record. null until that request is opened."
  default     = null

  validation {
    condition     = var.psl_pull_request == null || can(regex("^https://github\\.com/publicsuffix/list/pull/[1-9][0-9]*$", coalesce(var.psl_pull_request, "-")))
    error_message = "psl_pull_request must be https://github.com/publicsuffix/list/pull/<number>; replace the <...> placeholder."
  }
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
