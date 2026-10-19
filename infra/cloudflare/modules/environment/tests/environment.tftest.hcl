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
  relays = {
    relay-fsn = { ipv4 = "198.51.100.10", ipv6 = "2001:db8::10", in_rotation = true }
    relay-hel = { ipv4 = "198.51.100.20", ipv6 = "2001:db8::20", in_rotation = true }
  }
}

run "wildcard_points_at_every_relay_dns_only" {
  command = plan

  assert {
    condition = toset([
      for record in cloudflare_dns_record.this : "${record.type} ${record.content}" if record.name == "*.engines.example"
    ]) == toset(["A 198.51.100.10", "A 198.51.100.20", "AAAA 2001:db8::10", "AAAA 2001:db8::20"])
    error_message = "The wildcard must have one A and one AAAA record per relay in rotation."
  }

  assert {
    condition     = alltrue([for record in cloudflare_dns_record.this : record.ttl == 60 if record.name == "*.engines.example"])
    error_message = "The wildcard TTL must be 60 seconds so a dead relay drops out within a minute."
  }

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

run "relay_out_of_rotation_leaves_the_wildcard_only" {
  command = plan

  variables {
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

  assert {
    condition     = contains(keys(cloudflare_dns_record.this), "relay-a-relay-hel")
    error_message = "A relay out of rotation keeps its own hostname."
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
    relays = {
      relay-fsn = { ipv4 = "<relay-fsn-ipv4>", ipv6 = "<relay-fsn-ipv6>", in_rotation = true }
    }
  }

  expect_failures = [var.account_id, var.engine_domain, var.security_contact, var.relays]
}

run "rejects_an_empty_wildcard" {
  command = plan

  variables {
    relays = {
      relay-fsn = { ipv4 = "198.51.100.10", ipv6 = "2001:db8::10", in_rotation = false }
    }
  }

  expect_failures = [var.relays]
}
