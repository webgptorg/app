# The engine domain is a zone of its own ("own_zone", production) or, on staging only, a subdomain of dashboard_zone
# ("subdomain"; README, Staging: one domain). A subdomain gets no zone, so nothing here applies to it: Universal SSL
# and DNSSEC are settings of the whole shared zone, which this stack does not own.
locals {
  engine_own_zone = var.engine_zone_mode == "own_zone"
  engine_zone_id  = local.engine_own_zone ? cloudflare_zone.engine[0].id : data.cloudflare_zone.dashboard.zone_id
}

resource "cloudflare_zone" "engine" {
  count = local.engine_own_zone ? 1 : 0

  account = { id = var.account_id }
  name    = var.engine_domain
  type    = "full"

  lifecycle {
    prevent_destroy = true
  }
}

# Universal SSL would have Cloudflare hold an edge certificate for *.<engine domain> and silently add CAA records for
# its own CAs, undoing issuewild ";". Nothing on this zone is proxied, so the certificate would serve nothing.
resource "cloudflare_universal_ssl_setting" "engine" {
  count = local.engine_own_zone ? 1 : 0

  zone_id = cloudflare_zone.engine[0].id
  enabled = false
}

resource "cloudflare_zone_dnssec" "engine" {
  count = local.engine_own_zone && var.dnssec ? 1 : 0

  zone_id = cloudflare_zone.engine[0].id
  status  = "active"
}
