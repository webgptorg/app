locals {
  wildcard = "*.${var.engine_domain}"

  relays_in_rotation = { for name, relay in var.relays : name => relay if relay.in_rotation }

  relay_zone = (
    var.relay_domain == var.engine_domain || endswith(var.relay_domain, ".${var.engine_domain}") ? "engine" :
    var.relay_domain == var.dashboard_zone || endswith(var.relay_domain, ".${var.dashboard_zone}") ? "dashboard" :
    null
  )

  zone_ids = {
    engine    = local.engine_zone_id
    dashboard = data.cloudflare_zone.dashboard.zone_id
  }

  zone_names = {
    engine    = var.engine_domain
    dashboard = var.dashboard_zone
  }

  relay_records = merge(
    { for name, relay in var.relays : "relay-a-${name}" => {
      zone = local.relay_zone, name = "${name}.${var.relay_domain}", type = "A", content = relay.ipv4, ttl = 60
    } },
    { for name, relay in var.relays : "relay-aaaa-${name}" => {
      zone = local.relay_zone, name = "${name}.${var.relay_domain}", type = "AAAA", content = relay.ipv6, ttl = 60
    } },
  )

  # CAA records are not wildcard-expanded for the A/AAAA wildcard, so CAs climb to these records on the engine domain
  # for every engine.
  # Without wildcard certificates, any mis-issuance is per hostname and shows up in that engine's CT watch.
  # Per-engine accounturi pinning (RFC 8657) needs per-engine records and waits until those exist.
  engine_caa_records = {
    for tag, value in {
      issue     = "letsencrypt.org"
      issuewild = ";"
      iodef     = "mailto:${var.security_contact}"
    } :
    "engine-caa-${tag}" => { zone = "engine", name = var.engine_domain, type = "CAA", caa = { flags = 0, tag = tag, value = value } }
  }

  # The engine domain never sends mail, so anything claiming to come from it is spoofed and is refused outright.
  engine_no_mail_records = {
    "engine-null-mx" = { zone = "engine", name = var.engine_domain, type = "MX", content = ".", priority = 0 }
    "engine-spf"     = { zone = "engine", name = var.engine_domain, type = "TXT", content = "\"v=spf1 -all\"" }
    "engine-dmarc" = {
      zone    = "engine", name = "_dmarc.${var.engine_domain}", type = "TXT",
      content = "\"v=DMARC1; p=reject; sp=reject; adkim=s; aspf=s\""
    }
  }

  # The Public Suffix List maintainers check that _psl.<domain> names the pull request that adds it, on that request
  # and on every later change to the entry, so the record stays for as long as the entry does.
  engine_psl_records = var.psl_pull_request == null ? {} : {
    "engine-psl" = { zone = "engine", name = "_psl.${var.engine_domain}", type = "TXT", content = "\"${var.psl_pull_request}\"" }
  }

  dmarc = join("; ", compact([
    "v=DMARC1",
    "p=${var.dmarc_policy}",
    "sp=${var.dmarc_policy}",
    "adkim=s",
    "aspf=s",
    var.dmarc_report_address == null ? "" : "rua=mailto:${var.dmarc_report_address}",
  ]))

  email_records = {
    "email-dmarc" = { zone = "dashboard", name = "_dmarc.${var.email_sending_domain}", type = "TXT", content = "\"${local.dmarc}\"" }
  }

  extra_records = { for record in var.extra_records : "extra-${record.zone}-${record.type}-${record.name}-${record.content}" => record }

  records = {
    for key, record in merge(
      local.wildcard_records,
      local.relay_records,
      local.engine_caa_records,
      local.engine_no_mail_records,
      local.engine_psl_records,
      local.email_records,
      local.extra_records,
    ) :
    key => {
      zone     = record.zone
      name     = record.name
      type     = record.type
      content  = try(record.content, null)
      data     = try(record.caa, null)
      priority = try(record.priority, null)
      proxied  = try(record.proxied, false)
      ttl      = try(record.ttl, 3600)
    }
  }
}

data "cloudflare_zone" "dashboard" {
  filter = {
    name    = var.dashboard_zone
    account = { id = var.account_id }
  }
}

resource "cloudflare_dns_record" "this" {
  for_each = local.records

  zone_id  = try(local.zone_ids[each.value.zone], null)
  name     = each.value.name
  type     = each.value.type
  content  = each.value.content
  data     = each.value.data
  priority = each.value.priority
  proxied  = each.value.proxied
  ttl      = each.value.ttl
  comment  = "Managed by OpenTofu (infra/cloudflare)"

  lifecycle {
    precondition {
      condition     = each.value.zone != null
      error_message = "relay_domain ${var.relay_domain} is in neither engine_domain nor dashboard_zone."
    }

    precondition {
      condition = try(
        each.value.name == local.zone_names[each.value.zone] || endswith(each.value.name, ".${local.zone_names[each.value.zone]}"),
        false,
      )
      error_message = "${each.value.name} is not inside its zone."
    }

    # Proxying would make Cloudflare terminate TLS for engine hostnames and break end-to-end encryption (AGENTS.md rule 1).
    # Matched by name, not zone, so a record for an engine hostname is caught wherever it is declared.
    precondition {
      condition     = !each.value.proxied || !(each.value.name == var.engine_domain || endswith(each.value.name, ".${var.engine_domain}"))
      error_message = "${each.value.name} is under the engine domain and must be DNS-only (proxied = false)."
    }

    # The engine wildcard is relay-dns.tf's alone. A record next to the load balancer would be served unchecked whenever
    # it is disabled, and one next to the plain records could list a relay that is out of rotation.
    precondition {
      condition     = each.value.name != local.wildcard || (!local.load_balanced && startswith(each.key, "engine-wildcard-"))
      error_message = "${local.wildcard} is declared only by relay-dns.tf (its records or its load balancer); declare no other record for it."
    }

    # Nothing may serve on the bare engine domain (spec, Abuse on our domains: before the PSL entry lands).
    precondition {
      condition     = !(each.value.name == var.engine_domain && contains(["A", "AAAA", "CNAME", "HTTPS", "SVCB"], each.value.type))
      error_message = "The bare engine domain must not have ${each.value.type} records."
    }
  }
}
