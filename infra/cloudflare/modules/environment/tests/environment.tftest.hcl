# Runs entirely offline: the provider is mocked, so no account, token or network call is involved.

mock_provider "cloudflare" {
  mock_data "cloudflare_zone" {
    defaults = {
      zone_id = "22222222222222222222222222222222"
    }
  }

  mock_resource "cloudflare_zone" {
    defaults = {
      id           = "11111111111111111111111111111111"
      name_servers = ["ada.ns.cloudflare.com", "bob.ns.cloudflare.com"]
    }
  }
}

variables {
  environment          = "staging"
  account_id           = "0123456789abcdef0123456789abcdef"
  engine_domain        = "engines.example"
  dashboard_zone       = "dashboard.example"
  relay_domain         = "dashboard.example"
  security_contact     = "security@dashboard.example"
  email_sending_domain = "mail.dashboard.example"
  ops_email            = "ops@dashboard.example"
  relays = {
    relay-fsn = { ipv4 = "198.51.100.10", ipv6 = "2001:db8::10", in_rotation = true }
    relay-hel = { ipv4 = "198.51.100.20", ipv6 = "2001:db8::20", in_rotation = true }
  }
}

run "records_dns_only_in_their_zones" {
  command = plan

  assert {
    condition     = alltrue([for record in cloudflare_dns_record.this : record.proxied == false])
    error_message = "No record in this stack is proxied."
  }

  assert {
    condition = alltrue([
      for record in cloudflare_dns_record.this : record.zone_id == "11111111111111111111111111111111"
      if record.name == "engines.example" || endswith(record.name, ".engines.example")
    ])
    error_message = "Engine records belong to the engine zone."
  }

  assert {
    condition = length([
      for record in cloudflare_dns_record.this : record
      if record.name == "engines.example" && contains(["A", "AAAA", "CNAME", "HTTPS", "SVCB"], record.type)
    ]) == 0
    error_message = "Nothing serves on the bare engine domain."
  }

  assert {
    condition = toset([
      for record in cloudflare_dns_record.this : "${record.data.flags} ${record.data.tag} \"${record.data.value}\"" if record.type == "CAA"
    ]) == toset(["0 issue \"letsencrypt.org\"", "0 issuewild \";\"", "0 iodef \"mailto:security@dashboard.example\""])
    error_message = "CAA must allow Let's Encrypt, forbid wildcard certificates and report to the security contact."
  }

  assert {
    condition     = cloudflare_universal_ssl_setting.engine.enabled == false
    error_message = "Universal SSL stays off on the engine zone."
  }

  assert {
    condition     = cloudflare_zone_dnssec.engine[0].status == "active"
    error_message = "DNSSEC is on by default."
  }

  assert {
    condition = toset([
      for record in cloudflare_dns_record.this : "${record.name} ${record.type}" if startswith(record.name, "relay-")
    ]) == toset(["relay-fsn.dashboard.example A", "relay-fsn.dashboard.example AAAA", "relay-hel.dashboard.example A", "relay-hel.dashboard.example AAAA"])
    error_message = "Every relay gets A and AAAA records for its own hostname."
  }

  assert {
    condition     = cloudflare_d1_database.dashboard.name == "ptbk-dashboard-staging"
    error_message = "The D1 database is named per environment."
  }

  assert {
    condition = one([
      for record in cloudflare_dns_record.this : record.content if record.name == "_dmarc.mail.dashboard.example"
    ]) == "\"v=DMARC1; p=none; sp=none; adkim=s; aspf=s\""
    error_message = "The sending domain has a DMARC record."
  }
}

run "relays_under_the_engine_domain_use_the_engine_zone" {
  command = plan

  variables {
    relay_domain = "engines.example"
  }

  assert {
    condition     = cloudflare_dns_record.this["relay-a-relay-fsn"].zone_id == "11111111111111111111111111111111"
    error_message = "Relay records follow relay_domain into the engine zone."
  }
}

run "rejects_a_proxied_engine_record" {
  command = plan

  variables {
    extra_records = [{ zone = "engine", name = "abc.engines.example", type = "A", content = "198.51.100.30", proxied = true }]
  }

  expect_failures = [cloudflare_dns_record.this]
}

run "rejects_a_proxied_engine_record_declared_in_another_zone" {
  command = plan

  variables {
    engine_domain = "engines.dashboard.example"
    relay_domain  = "dashboard.example"
    extra_records = [{ zone = "dashboard", name = "abc.engines.dashboard.example", type = "A", content = "198.51.100.30", proxied = true }]
  }

  expect_failures = [cloudflare_dns_record.this]
}

run "allows_a_proxied_dashboard_record" {
  command = plan

  variables {
    extra_records = [{ zone = "dashboard", name = "www.dashboard.example", type = "A", content = "198.51.100.40", proxied = true }]
  }
}

run "rejects_a_record_on_the_bare_engine_domain" {
  command = plan

  variables {
    extra_records = [{ zone = "engine", name = "engines.example", type = "A", content = "198.51.100.30" }]
  }

  expect_failures = [cloudflare_dns_record.this]
}

run "rejects_a_record_outside_its_zone" {
  command = plan

  variables {
    extra_records = [{ zone = "engine", name = "www.dashboard.example", type = "TXT", content = "\"x\"" }]
  }

  expect_failures = [cloudflare_dns_record.this]
}

run "rejects_a_relay_domain_outside_both_zones" {
  command = plan

  variables {
    relay_domain = "relays.example"
  }

  expect_failures = [cloudflare_dns_record.this]
}

run "rejects_an_email_domain_under_the_engine_domain" {
  command = plan

  variables {
    engine_domain        = "engines.dashboard.example"
    email_sending_domain = "mail.engines.dashboard.example"
  }

  expect_failures = [cloudflare_email_sending_subdomain.dashboard]
}

run "rejects_placeholders" {
  command = plan

  variables {
    account_id       = "<staging-account-id>"
    engine_domain    = "<staging-engine-domain>"
    security_contact = "<security-contact>"
    ops_email        = "<ops-email>"
    relay_dns_mode   = "records"
    relays = {
      relay-fsn = { ipv4 = "<relay-fsn-ipv4>", ipv6 = "<relay-fsn-ipv6>", in_rotation = true }
    }
  }

  expect_failures = [var.account_id, var.engine_domain, var.security_contact, var.ops_email, var.relays]
}

run "rejects_an_empty_wildcard" {
  command = plan

  variables {
    relay_dns_mode = "records"
    relays = {
      relay-fsn = { ipv4 = "198.51.100.10", ipv6 = "2001:db8::10", in_rotation = false }
    }
  }

  expect_failures = [var.relays]
}

# I-07: the engine wildcard is a DNS-only load balancer. The overrides give the pools and the monitor IDs at plan time.
run "engine_wildcard_is_a_dns_only_load_balancer_over_every_relay" {
  command = plan

  override_resource {
    target = cloudflare_load_balancer_pool.relays
    values = { id = "pool-relays" }
  }

  override_resource {
    target = cloudflare_load_balancer_pool.relays_fallback
    values = { id = "pool-relays-fallback" }
  }

  override_resource {
    target = cloudflare_load_balancer_monitor.relay
    values = { id = "monitor-relay" }
  }

  assert {
    condition = (
      cloudflare_load_balancer.engine_wildcard[0].name == "*.engines.example"
      && cloudflare_load_balancer.engine_wildcard[0].zone_id == "11111111111111111111111111111111"
      && cloudflare_load_balancer.engine_wildcard[0].proxied == false
    )
    error_message = "The engine wildcard is a DNS-only load balancer in the engine zone: proxying would terminate engine TLS."
  }

  assert {
    condition     = cloudflare_load_balancer.engine_wildcard[0].ttl == 30
    error_message = "The engine wildcard's TTL is 30 seconds, so a relay that left reaches browsers within half a minute."
  }

  assert {
    condition = (
      cloudflare_load_balancer.engine_wildcard[0].default_pools == tolist(["pool-relays"])
      && cloudflare_load_balancer.engine_wildcard[0].fallback_pool == "pool-relays-fallback"
      && cloudflare_load_balancer.engine_wildcard[0].steering_policy == "off"
    )
    error_message = "The load balancer answers from the health-checked pool, and from the unchecked fallback pool when nothing in it is healthy."
  }

  assert {
    condition = toset([
      for origin in cloudflare_load_balancer_pool.relays[0].origins : "${origin.name} ${origin.address} ${one(origin.header.host)} ${origin.weight}"
      ]) == toset([
      "relay-fsn-ipv4 198.51.100.10 relay-fsn.dashboard.example 1",
      "relay-fsn-ipv6 2001:db8::10 relay-fsn.dashboard.example 1",
      "relay-hel-ipv4 198.51.100.20 relay-hel.dashboard.example 1",
      "relay-hel-ipv6 2001:db8::20 relay-hel.dashboard.example 1",
    ])
    error_message = "One pool holds every relay address at equal weight, so DNS-only answers list every healthy relay; each is checked on its own hostname."
  }

  assert {
    condition = (
      cloudflare_load_balancer_pool.relays[0].monitor == "monitor-relay"
      && cloudflare_load_balancer_pool.relays[0].minimum_origins == 1
      && cloudflare_load_balancer_pool.relays[0].check_regions == tolist(["WEU", "EEU", "ENAM"])
    )
    error_message = "The pool is checked from three regions and stays in use while any relay is healthy."
  }

  assert {
    condition = (
      cloudflare_load_balancer_pool.relays_fallback[0].monitor == null
      && toset([for origin in cloudflare_load_balancer_pool.relays_fallback[0].origins : origin.address])
      == toset([for origin in cloudflare_load_balancer_pool.relays[0].origins : origin.address])
    )
    error_message = "The fallback pool holds the same relays, unchecked, so DNS never ends up empty."
  }

  assert {
    condition = (
      cloudflare_load_balancer_monitor.relay[0].type == "https"
      && cloudflare_load_balancer_monitor.relay[0].path == "/healthz"
      && cloudflare_load_balancer_monitor.relay[0].expected_codes == "200"
      && cloudflare_load_balancer_monitor.relay[0].allow_insecure == false
      && cloudflare_load_balancer_monitor.relay[0].interval == 15
      && cloudflare_load_balancer_monitor.relay[0].timeout == 3
      && cloudflare_load_balancer_monitor.relay[0].consecutive_down == 2
      && cloudflare_load_balancer_monitor.relay[0].consecutive_up == 3
    )
    error_message = "Relays are checked over verified HTTPS every 15 s with a 3 s timeout, out after 2 failures, back after 3 passes."
  }

  assert {
    condition = (
      cloudflare_notification_policy.relay_health[0].alert_type == "load_balancing_health_alert"
      && cloudflare_notification_policy.relay_health[0].enabled
      && [for email in cloudflare_notification_policy.relay_health[0].mechanisms.email : email.id] == ["ops@dashboard.example"]
      && cloudflare_notification_policy.relay_health[0].filters.pool_id == tolist(["pool-relays"])
      && toset(cloudflare_notification_policy.relay_health[0].filters.new_health) == toset(["Healthy", "Unhealthy"])
      && toset(cloudflare_notification_policy.relay_health[0].filters.event_source) == toset(["pool", "origin"])
    )
    error_message = "Every relay health change in the pool, and the pool's own, is emailed to the ops mailbox."
  }

  assert {
    condition     = length([for record in cloudflare_dns_record.this : record if record.name == "*.engines.example"]) == 0
    error_message = "No DNS record competes with the load balancer for the engine wildcard."
  }
}

run "relay_out_of_rotation_leaves_both_pools_only" {
  command = plan

  variables {
    relays = {
      relay-fsn = { ipv4 = "198.51.100.10", ipv6 = "2001:db8::10", in_rotation = true }
      relay-hel = { ipv4 = "198.51.100.20", ipv6 = "2001:db8::20", in_rotation = false }
    }
  }

  assert {
    condition = (
      toset([for origin in cloudflare_load_balancer_pool.relays[0].origins : origin.address]) == toset(["198.51.100.10", "2001:db8::10"])
      && toset([for origin in cloudflare_load_balancer_pool.relays_fallback[0].origins : origin.address]) == toset(["198.51.100.10", "2001:db8::10"])
    )
    error_message = "A relay out of rotation is in neither pool, so not even the fallback lists it."
  }

  assert {
    condition     = contains(keys(cloudflare_dns_record.this), "relay-a-relay-hel")
    error_message = "A relay out of rotation keeps its own hostname."
  }
}

run "health_check_interval_and_regions_are_configurable" {
  command = plan

  variables {
    relay_health_check = { interval_s = 60, regions = ["WEU", "EEU", "ENAM", "WNAM", "SEAS"] }
  }

  assert {
    condition     = cloudflare_load_balancer_monitor.relay[0].interval == 60 && length(cloudflare_load_balancer_pool.relays[0].check_regions) == 5
    error_message = "The interval and regions follow relay_health_check."
  }
}

run "rejects_a_slow_or_single_region_health_check" {
  command = plan

  variables {
    relay_health_check = { interval_s = 300, regions = ["WEU", "WEU"] }
  }

  expect_failures = [var.relay_health_check]
}

run "rejects_a_dns_record_on_the_engine_wildcard" {
  command = plan

  variables {
    extra_records = [{ zone = "engine", name = "*.engines.example", type = "A", content = "198.51.100.30" }]
  }

  expect_failures = [cloudflare_dns_record.this]
}

run "records_mode_lists_every_relay_in_plain_wildcard_records" {
  command = plan

  variables {
    relay_dns_mode = "records"
    ops_email      = null
  }

  assert {
    condition = toset([
      for record in cloudflare_dns_record.this : "${record.type} ${record.content} ${record.ttl} ${record.proxied}" if record.name == "*.engines.example"
      ]) == toset([
      "A 198.51.100.10 30 false", "A 198.51.100.20 30 false", "AAAA 2001:db8::10 30 false", "AAAA 2001:db8::20 30 false",
    ])
    error_message = "Without the load balancer, the wildcard has one DNS-only A and AAAA record per relay in rotation, with the short TTL."
  }

  assert {
    condition = (
      length(cloudflare_load_balancer.engine_wildcard) == 0 && length(cloudflare_load_balancer_pool.relays) == 0
      && length(cloudflare_load_balancer_pool.relays_fallback) == 0 && length(cloudflare_load_balancer_monitor.relay) == 0
      && length(cloudflare_notification_policy.relay_health) == 0
    )
    error_message = "Records mode creates nothing that needs the Load Balancing add-on."
  }
}

run "records_mode_drops_a_relay_out_of_rotation" {
  command = plan

  variables {
    relay_dns_mode = "records"
    relays = {
      relay-fsn = { ipv4 = "198.51.100.10", ipv6 = "2001:db8::10", in_rotation = true }
      relay-hel = { ipv4 = "198.51.100.20", ipv6 = "2001:db8::20", in_rotation = false }
    }
  }

  assert {
    condition = toset([
      for record in cloudflare_dns_record.this : record.content if record.name == "*.engines.example"
    ]) == toset(["198.51.100.10", "2001:db8::10"])
    error_message = "A relay out of rotation must not be in the wildcard."
  }
}

run "records_mode_serves_a_single_relay_without_an_ops_mailbox" {
  command = plan

  variables {
    relay_dns_mode = "records"
    ops_email      = null
    relays = {
      relay-fsn = { ipv4 = "198.51.100.10", ipv6 = "2001:db8::10", in_rotation = true }
    }
  }

  assert {
    condition     = length([for record in cloudflare_dns_record.this : record if record.name == "*.engines.example"]) == 2
    error_message = "One relay, one A and one AAAA record."
  }
}

run "rejects_a_load_balancer_over_a_single_relay" {
  command = plan

  variables {
    relays = {
      relay-fsn = { ipv4 = "198.51.100.10", ipv6 = "2001:db8::10", in_rotation = true }
    }
  }

  expect_failures = [var.relay_dns_mode]
}

run "rejects_a_load_balancer_without_an_ops_mailbox" {
  command = plan

  variables {
    ops_email = null
  }

  expect_failures = [var.relay_dns_mode]
}

run "rejects_an_unknown_relay_dns_mode" {
  command = plan

  variables {
    relay_dns_mode = "health_checked"
  }

  expect_failures = [var.relay_dns_mode]
}

run "records_mode_rejects_another_record_on_the_engine_wildcard" {
  command = plan

  variables {
    relay_dns_mode = "records"
    extra_records  = [{ zone = "engine", name = "*.engines.example", type = "A", content = "198.51.100.30" }]
  }

  expect_failures = [cloudflare_dns_record.this]
}
