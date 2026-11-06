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
    condition     = length(cloudflare_zone.engine) == 1 && cloudflare_zone.engine[0].name == "engines.example"
    error_message = "By default the engine domain is a zone of its own, created here."
  }

  assert {
    condition     = cloudflare_universal_ssl_setting.engine[0].enabled == false
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

run "no_psl_record_before_the_psl_pull_request" {
  command = plan

  assert {
    condition     = length([for record in cloudflare_dns_record.this : record if startswith(record.name, "_psl.")]) == 0
    error_message = "_psl is published only once the PSL pull request exists."
  }
}

run "psl_record_names_the_psl_pull_request" {
  command = plan

  variables {
    psl_pull_request = "https://github.com/publicsuffix/list/pull/2345"
  }

  assert {
    condition = (
      cloudflare_dns_record.this["engine-psl"].name == "_psl.engines.example"
      && cloudflare_dns_record.this["engine-psl"].type == "TXT"
      && cloudflare_dns_record.this["engine-psl"].content == "\"https://github.com/publicsuffix/list/pull/2345\""
      && cloudflare_dns_record.this["engine-psl"].zone_id == "11111111111111111111111111111111"
      && cloudflare_dns_record.this["engine-psl"].proxied == false
    )
    error_message = "_psl.<engine domain> is a DNS-only TXT record in the engine zone holding the PSL pull request URL."
  }
}

run "rejects_a_psl_value_that_is_not_a_psl_pull_request" {
  command = plan

  variables {
    psl_pull_request = "https://github.com/someone/list/pull/2345"
  }

  expect_failures = [var.psl_pull_request]
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
    psl_pull_request = "<psl-pull-request>"
    relay_dns_mode   = "records"
    relays = {
      relay-fsn = { ipv4 = "<relay-fsn-ipv4>", ipv6 = "<relay-fsn-ipv6>", in_rotation = true }
    }
  }

  expect_failures = [var.account_id, var.engine_domain, var.security_contact, var.ops_email, var.psl_pull_request, var.relays]
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

# engine_zone_mode: "own_zone" is the default and production's; this pins every DNS record it plans, so the mode switch
# leaves own-zone environments as they were.
run "own_zone_plans_the_same_records" {
  command = plan

  variables {
    relay_dns_mode = "records"
  }

  assert {
    condition = toset([
      for key, record in cloudflare_dns_record.this : "${key} ${record.zone_id} ${record.name} ${record.type} ${record.type == "CAA" ? "${record.data.tag}=${record.data.value}" : record.content} ${record.ttl}"
      ]) == toset([
      "engine-wildcard-a-relay-fsn 11111111111111111111111111111111 *.engines.example A 198.51.100.10 30",
      "engine-wildcard-a-relay-hel 11111111111111111111111111111111 *.engines.example A 198.51.100.20 30",
      "engine-wildcard-aaaa-relay-fsn 11111111111111111111111111111111 *.engines.example AAAA 2001:db8::10 30",
      "engine-wildcard-aaaa-relay-hel 11111111111111111111111111111111 *.engines.example AAAA 2001:db8::20 30",
      "relay-a-relay-fsn 22222222222222222222222222222222 relay-fsn.dashboard.example A 198.51.100.10 60",
      "relay-a-relay-hel 22222222222222222222222222222222 relay-hel.dashboard.example A 198.51.100.20 60",
      "relay-aaaa-relay-fsn 22222222222222222222222222222222 relay-fsn.dashboard.example AAAA 2001:db8::10 60",
      "relay-aaaa-relay-hel 22222222222222222222222222222222 relay-hel.dashboard.example AAAA 2001:db8::20 60",
      "engine-caa-issue 11111111111111111111111111111111 engines.example CAA issue=letsencrypt.org 3600",
      "engine-caa-issuewild 11111111111111111111111111111111 engines.example CAA issuewild=; 3600",
      "engine-caa-iodef 11111111111111111111111111111111 engines.example CAA iodef=mailto:security@dashboard.example 3600",
      "engine-null-mx 11111111111111111111111111111111 engines.example MX . 3600",
      "engine-spf 11111111111111111111111111111111 engines.example TXT \"v=spf1 -all\" 3600",
      "engine-dmarc 11111111111111111111111111111111 _dmarc.engines.example TXT \"v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s\" 3600",
      "email-dmarc 22222222222222222222222222222222 _dmarc.mail.dashboard.example TXT \"v=DMARC1; p=none; sp=none; adkim=s; aspf=s\" 3600",
    ])
    error_message = "Own-zone mode plans exactly the records it did before engine_zone_mode existed."
  }
}

run "subdomain_mode_puts_engine_records_into_the_dashboard_zone" {
  command = plan

  variables {
    engine_zone_mode = "subdomain"
    engine_domain    = "engines.dashboard.example"
    relay_dns_mode   = "records"
  }

  assert {
    condition = (
      length(cloudflare_zone.engine) == 0 && length(cloudflare_universal_ssl_setting.engine) == 0
      && length(cloudflare_zone_dnssec.engine) == 0
    )
    error_message = "A subdomain gets no zone, and nothing changes the shared zone's Universal SSL or DNSSEC."
  }

  assert {
    condition     = alltrue([for record in cloudflare_dns_record.this : record.zone_id == "22222222222222222222222222222222"])
    error_message = "Every record, the engine ones included, goes into the dashboard zone."
  }

  assert {
    condition = toset([
      for record in cloudflare_dns_record.this : "${record.type} ${record.content} ${record.ttl} ${record.proxied}" if record.name == "*.engines.dashboard.example"
      ]) == toset([
      "A 198.51.100.10 30 false", "A 198.51.100.20 30 false", "AAAA 2001:db8::10 30 false", "AAAA 2001:db8::20 30 false",
    ])
    error_message = "The engine wildcard is DNS-only, one A and AAAA record per relay in rotation, as in own-zone mode."
  }

  assert {
    condition = toset([
      for key, record in cloudflare_dns_record.this : "${record.name} ${record.type}" if startswith(key, "engine-") && !startswith(key, "engine-wildcard-")
      ]) == toset([
      "engines.dashboard.example CAA", "engines.dashboard.example MX", "engines.dashboard.example TXT", "_dmarc.engines.dashboard.example TXT",
    ])
    error_message = "CAA and the no-mail records are set on the engine subdomain itself, where CAs and mail receivers look for them."
  }

  assert {
    condition = toset([
      for record in cloudflare_dns_record.this : "${record.data.flags} ${record.data.tag} \"${record.data.value}\"" if record.type == "CAA"
    ]) == toset(["0 issue \"letsencrypt.org\"", "0 issuewild \";\"", "0 iodef \"mailto:security@dashboard.example\""])
    error_message = "The engine subdomain keeps the CAA records of an engine zone."
  }

  assert {
    condition = (
      output.engine_zone_id == "22222222222222222222222222222222" && output.engine_name_servers == null && output.dnssec_ds == null
    )
    error_message = "The engine zone ID is the dashboard zone's, and there are no name servers or DS record to set."
  }
}

run "subdomain_mode_still_refuses_a_proxied_engine_record" {
  command = plan

  variables {
    engine_zone_mode = "subdomain"
    engine_domain    = "engines.dashboard.example"
    extra_records    = [{ zone = "dashboard", name = "abc.engines.dashboard.example", type = "A", content = "198.51.100.30", proxied = true }]
  }

  expect_failures = [cloudflare_dns_record.this]
}

run "subdomain_mode_still_refuses_a_record_on_the_bare_engine_domain" {
  command = plan

  variables {
    engine_zone_mode = "subdomain"
    engine_domain    = "engines.dashboard.example"
    extra_records    = [{ zone = "dashboard", name = "engines.dashboard.example", type = "A", content = "198.51.100.30" }]
  }

  expect_failures = [cloudflare_dns_record.this]
}

run "subdomain_mode_with_the_load_balancer_uses_the_dashboard_zone" {
  command = plan

  variables {
    engine_zone_mode = "subdomain"
    engine_domain    = "engines.dashboard.example"
  }

  assert {
    condition = (
      cloudflare_load_balancer.engine_wildcard[0].zone_id == "22222222222222222222222222222222"
      && cloudflare_load_balancer.engine_wildcard[0].name == "*.engines.dashboard.example"
      && cloudflare_load_balancer.engine_wildcard[0].proxied == false
    )
    error_message = "The engine wildcard's load balancer lives in the dashboard zone and stays DNS-only."
  }
}

run "rejects_subdomain_mode_in_production" {
  command = plan

  variables {
    environment      = "production"
    engine_zone_mode = "subdomain"
    engine_domain    = "engines.dashboard.example"
  }

  expect_failures = [var.engine_zone_mode]
}

run "rejects_subdomain_mode_outside_the_dashboard_zone" {
  command = plan

  variables {
    engine_zone_mode = "subdomain"
  }

  expect_failures = [var.engine_zone_mode]
}

run "rejects_a_psl_record_in_subdomain_mode" {
  command = plan

  variables {
    engine_zone_mode = "subdomain"
    engine_domain    = "engines.dashboard.example"
    psl_pull_request = "https://github.com/publicsuffix/list/pull/2345"
  }

  expect_failures = [var.engine_zone_mode]
}

run "rejects_an_unknown_engine_zone_mode" {
  command = plan

  variables {
    engine_zone_mode = "delegated"
  }

  expect_failures = [var.engine_zone_mode]
}

run "serves_no_ui_release_bucket_by_default" {
  command = plan

  assert {
    condition     = length(cloudflare_r2_custom_domain.ui_releases) == 0 && length(cloudflare_r2_managed_domain.ui_releases) == 0
    error_message = "Without ui_releases nothing touches R2."
  }
}

run "serves_the_ui_release_bucket_on_its_hostname_only" {
  command = plan

  variables {
    ui_releases = { bucket = "ptbk-ui-releases-staging", hostname = "ui.dashboard.example" }
  }

  assert {
    condition = (
      cloudflare_r2_custom_domain.ui_releases[0].domain == "ui.dashboard.example"
      && cloudflare_r2_custom_domain.ui_releases[0].bucket_name == "ptbk-ui-releases-staging"
      && cloudflare_r2_custom_domain.ui_releases[0].zone_id == "22222222222222222222222222222222"
      && cloudflare_r2_custom_domain.ui_releases[0].enabled
      && cloudflare_r2_custom_domain.ui_releases[0].min_tls == "1.2"
    )
    error_message = "The bucket is served on its hostname in the dashboard zone, TLS 1.2 or later."
  }

  assert {
    condition     = cloudflare_r2_managed_domain.ui_releases[0].enabled == false
    error_message = "The r2.dev address stays off."
  }

  assert {
    condition     = output.ui_release_url == "https://ui.dashboard.example/"
    error_message = "The release URL ends in / (release mirror layout v1)."
  }
}

run "rejects_a_ui_release_hostname_outside_the_dashboard_zone" {
  command = plan

  variables {
    ui_releases = { bucket = "ptbk-ui-releases-staging", hostname = "ui.elsewhere.example" }
  }

  expect_failures = [var.ui_releases]
}

run "rejects_a_ui_release_hostname_under_the_engine_domain" {
  command = plan

  variables {
    engine_zone_mode = "subdomain"
    engine_domain    = "engines.dashboard.example"
    ui_releases      = { bucket = "ptbk-ui-releases-staging", hostname = "ui.engines.dashboard.example" }
  }

  expect_failures = [var.ui_releases]
}

run "rejects_an_invalid_ui_release_bucket_name" {
  command = plan

  variables {
    ui_releases = { bucket = "UI_Releases", hostname = "ui.dashboard.example" }
  }

  expect_failures = [var.ui_releases]
}
