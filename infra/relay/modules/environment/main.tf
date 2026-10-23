locals {
  labels = {
    environment = var.environment
    role        = "relay"
    managed-by  = "opentofu"
  }

  # Hetzner mails a root password for a server created without an SSH key. One admin key avoids that; root login is
  # disabled at first boot anyway.
  bootstrap_key = var.admins[sort(keys(var.admins))[0]][0]

  anywhere = ["0.0.0.0/0", "::/0"]

  # What the hosts may reach (the same as the nftables output chain): HTTPS, apt and the metadata service over HTTP,
  # DNS from the root down, NTP, DHCP and ICMP.
  outbound = [
    { protocol = "tcp", port = "443" },
    { protocol = "tcp", port = "80" },
    { protocol = "tcp", port = "53" },
    { protocol = "udp", port = "53" },
    { protocol = "udp", port = "123" },
    { protocol = "udp", port = "67" },
    { protocol = "icmp", port = null },
  ]
}

module "cloud_init" {
  source   = "../cloud-init"
  for_each = var.relays

  name           = each.key
  relay_domain   = var.relay_domain
  engine_domain  = var.engine_domain
  registry_url   = var.registry_url
  acme_email     = var.acme_email
  admins         = var.admins
  ssh_allowlist  = var.ssh_allowlist
  reboot_time    = each.value.reboot_time
  relay_settings = var.relay_settings
}

resource "hcloud_ssh_key" "bootstrap" {
  name       = "ptbk-relay-${var.environment}-bootstrap"
  public_key = local.bootstrap_key
  labels     = local.labels
}

resource "hcloud_firewall" "relay" {
  name   = "ptbk-relay-${var.environment}"
  labels = local.labels

  rule {
    description = "Browsers and engine tunnels"
    direction   = "in"
    protocol    = "tcp"
    port        = "443"
    source_ips  = local.anywhere
  }

  rule {
    description = "SSH from the allowlist"
    direction   = "in"
    protocol    = "tcp"
    port        = "22"
    source_ips  = var.ssh_allowlist
  }

  rule {
    description = "ICMP (path MTU discovery, ping)"
    direction   = "in"
    protocol    = "icmp"
    source_ips  = local.anywhere
  }

  dynamic "rule" {
    for_each = local.outbound

    content {
      direction       = "out"
      protocol        = rule.value.protocol
      port            = rule.value.port
      destination_ips = local.anywhere
    }
  }
}

# Addresses outlive the servers, so rebuilding a host (tofu apply -replace) keeps its DNS records (I-02) valid.
resource "hcloud_primary_ip" "ipv4" {
  for_each = var.relays

  name              = "${each.key}-ipv4"
  type              = "ipv4"
  location          = each.value.location
  auto_delete       = false
  delete_protection = true
  labels            = local.labels
}

resource "hcloud_primary_ip" "ipv6" {
  for_each = var.relays

  name              = "${each.key}-ipv6"
  type              = "ipv6"
  location          = each.value.location
  auto_delete       = false
  delete_protection = true
  labels            = local.labels
}

resource "hcloud_server" "relay" {
  for_each = var.relays

  name                     = each.key
  server_type              = var.server_type
  image                    = var.image
  location                 = each.value.location
  ssh_keys                 = [hcloud_ssh_key.bootstrap.id]
  firewall_ids             = [hcloud_firewall.relay.id]
  user_data                = module.cloud_init[each.key].user_data
  backups                  = false
  shutdown_before_deletion = true
  labels                   = local.labels

  public_net {
    ipv4_enabled = true
    ipv4         = hcloud_primary_ip.ipv4[each.key].id
    ipv6_enabled = true
    ipv6         = hcloud_primary_ip.ipv6[each.key].id
  }

  lifecycle {
    # Engines stay reachable when one relay fails only if production has relays in at least two locations (spec, No
    # single point of failure).
    precondition {
      condition     = var.environment != "production" || length(distinct([for relay in var.relays : relay.location])) >= 2
      error_message = "Production needs relays in at least two locations."
    }
  }
}
