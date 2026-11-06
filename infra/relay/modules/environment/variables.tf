variable "environment" {
  type = string

  validation {
    condition     = contains(["staging", "production"], var.environment)
    error_message = "environment must be staging or production."
  }
}

variable "relays" {
  type = map(object({
    location    = string
    reboot_time = string
  }))
  description = "Relay hosts by name (relay-fsn becomes relay-fsn.<relay_domain>): Hetzner location and the UTC time at which unattended upgrades may reboot it."

  validation {
    condition     = length(var.relays) > 0
    error_message = "At least one relay is required."
  }

  # EU locations only: the relays see engine IP addresses and tunnel times (spec, Legal and GDPR).
  validation {
    condition     = alltrue([for relay in var.relays : contains(["fsn1", "nbg1", "hel1"], relay.location)])
    error_message = "Relay locations must be Hetzner EU locations: fsn1, nbg1 or hel1."
  }

  # A reboot and the certificate renewal an hour later both restart a relay, so the windows of two relays are at least
  # two hours apart and never overlap.
  validation {
    condition = alltrue(flatten([
      for a, relay_a in var.relays : [
        for b, relay_b in var.relays : a == b || try(
          min(
            abs(tonumber(split(":", relay_a.reboot_time)[0]) - tonumber(split(":", relay_b.reboot_time)[0])),
            24 - abs(tonumber(split(":", relay_a.reboot_time)[0]) - tonumber(split(":", relay_b.reboot_time)[0])),
          ) >= 2,
          false,
        )
      ]
    ]))
    error_message = "The reboot_time of two relays must be at least two hours apart."
  }
}

variable "server_type" {
  type        = string
  description = "Hetzner server type of every relay. R-05's load test may change it; nothing else depends on it."
  default     = "cx23"
}

variable "image" {
  type        = string
  description = "Hetzner image the hosts are built from."
  default     = "debian-13"
}

variable "relay_domain" {
  type = string
}

variable "engine_domain" {
  type = string
}

variable "registry_url" {
  type = string
}

variable "acme_email" {
  type = string
}

variable "admins" {
  type = map(list(string))
}

variable "ssh_allowlist" {
  type = list(string)
}

variable "ssh_from_anywhere" {
  type    = bool
  default = false
}

variable "relay_settings" {
  type    = map(string)
  default = {}
}
