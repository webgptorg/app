resource "cloudflare_zone" "engine" {
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
  zone_id = cloudflare_zone.engine.id
  enabled = false
}

resource "cloudflare_zone_dnssec" "engine" {
  count = var.dnssec ? 1 : 0

  zone_id = cloudflare_zone.engine.id
  status  = "active"
}
