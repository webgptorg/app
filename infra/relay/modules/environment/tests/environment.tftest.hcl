# Runs entirely offline: the provider is mocked, so no Hetzner project, token or network call is involved.

mock_provider "hcloud" {
  mock_resource "hcloud_firewall" {
    defaults = {
      id = "1001"
    }
  }

  mock_resource "hcloud_ssh_key" {
    defaults = {
      id = "2002"
    }
  }

  mock_resource "hcloud_primary_ip" {
    defaults = {
      id = 3003
    }
  }

  mock_resource "hcloud_server" {
    defaults = {
      ipv4_address = "198.51.100.10"
      ipv6_address = "2001:db8::1"
    }
  }
}

variables {
  environment   = "production"
  relay_domain  = "relays.example"
  engine_domain = "engines.example"
  registry_url  = "https://app.example"
  acme_email    = "ops@example.com"
  admins = {
    ada = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIODl1HFc9w2tQEYLZv2a7Q6WsBdDk0Rgoxk/YQuqGbj+ ada"]
  }
  deploy_key    = "ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIEAvFcF9TjUmm57Av3oVnBfv6lwzliXetJmpL5iZ/p0m deploy"
  ssh_allowlist = ["198.51.100.0/24", "2001:db8:1::/48"]
  relays = {
    relay-fsn = { location = "fsn1", reboot_time = "02:00" }
    relay-hel = { location = "hel1", reboot_time = "04:00" }
  }
}

run "production_has_two_relays_in_two_locations" {
  command = apply

  assert {
    condition     = { for name, server in hcloud_server.relay : name => server.location } == { relay-fsn = "fsn1", relay-hel = "hel1" }
    error_message = "Production runs relay-fsn in fsn1 and relay-hel in hel1."
  }

  assert {
    condition     = alltrue([for server in hcloud_server.relay : server.server_type == "cx22" && server.image == "debian-13"])
    error_message = "Every relay is a CX22-class Debian 13 host unless the tfvars say otherwise."
  }

  assert {
    condition     = output.relays["relay-hel"].hostname == "relay-hel.relays.example"
    error_message = "Each relay's hostname is <name>.<relay_domain>."
  }

  assert {
    condition     = alltrue([for name, server in hcloud_server.relay : server.user_data == module.cloud_init[name].user_data])
    error_message = "Each host boots with its own user data."
  }
}

run "firewall_admits_only_443_ssh_from_the_allowlist_and_icmp" {
  command = apply

  assert {
    condition = toset([
      for rule in hcloud_firewall.relay.rule : "${rule.protocol}/${coalesce(rule.port, "-")} ${join(",", sort(rule.source_ips))}"
      if rule.direction == "in"
    ]) == toset(["tcp/443 0.0.0.0/0,::/0", "tcp/22 198.51.100.0/24,2001:db8:1::/48", "icmp/- 0.0.0.0/0,::/0"])
    error_message = "Inbound: 443 from anywhere, 22 from the allowlist, ICMP; nothing else."
  }

  assert {
    condition = toset([
      for rule in hcloud_firewall.relay.rule : "${rule.protocol}/${coalesce(rule.port, "-")}" if rule.direction == "out"
    ]) == toset(["tcp/443", "tcp/80", "tcp/53", "udp/53", "udp/123", "udp/67", "icmp/-"])
    error_message = "Outbound: what the relay, updates, DNS and time sync need."
  }

  assert {
    condition     = alltrue([for server in hcloud_server.relay : server.firewall_ids == toset([1001])])
    error_message = "Every relay sits behind the firewall."
  }
}

run "addresses_survive_a_rebuild" {
  command = apply

  assert {
    condition = alltrue([
      for ip in concat(values(hcloud_primary_ip.ipv4), values(hcloud_primary_ip.ipv6)) : ip.auto_delete == false && ip.delete_protection == true
    ])
    error_message = "Primary IPs outlive their server and cannot be deleted by accident, so DNS stays valid across a rebuild."
  }

  assert {
    condition     = alltrue([for name, server in hcloud_server.relay : server.shutdown_before_deletion])
    error_message = "A replaced host is shut down first, so the relay closes its tunnels and engines move on at once."
  }
}

run "staging_runs_one_relay" {
  command = apply

  variables {
    environment = "staging"
    relays = {
      relay-fsn = { location = "fsn1", reboot_time = "02:00" }
    }
  }

  assert {
    condition     = keys(hcloud_server.relay) == ["relay-fsn"]
    error_message = "Staging runs a single relay."
  }
}

run "refuses_production_in_one_location" {
  command = plan

  variables {
    relays = {
      relay-fsn = { location = "fsn1", reboot_time = "02:00" }
      relay-fs2 = { location = "fsn1", reboot_time = "04:00" }
    }
  }

  expect_failures = [hcloud_server.relay]
}

run "refuses_overlapping_maintenance_windows" {
  command = plan

  variables {
    relays = {
      relay-fsn = { location = "fsn1", reboot_time = "23:30" }
      relay-hel = { location = "hel1", reboot_time = "00:15" }
    }
  }

  expect_failures = [var.relays]
}

run "refuses_locations_outside_the_eu" {
  command = plan

  variables {
    relays = {
      relay-ash = { location = "ash", reboot_time = "02:00" }
    }
  }

  expect_failures = [var.relays]
}
