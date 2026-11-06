# The dashboard on a hostname in another account's zone (staging: app.ptbk.io), as a Cloudflare for SaaS custom
# hostname of dashboard_zone: a Workers custom domain needs its zone in the Worker's account. The owner of that zone
# only adds DNS-only records (the dashboard_owner_records output), so nothing here needs a token for it. README,
# Dashboard on another account's zone.
locals {
  dashboard_saas = var.dashboard_custom_hostname != null

  # Originless: the Worker route answers every request, so nothing ever connects to 100::.
  dashboard_saas_records = local.dashboard_saas ? {
    "dashboard-fallback-origin" = {
      zone    = "dashboard", name = var.dashboard_custom_hostname.fallback_origin, type = "AAAA", content = "100::",
      proxied = true, ttl = 1
    }
  } : {}
}

resource "cloudflare_custom_hostname_fallback_origin" "dashboard" {
  count = local.dashboard_saas ? 1 : 0

  zone_id = data.cloudflare_zone.dashboard.zone_id
  origin  = var.dashboard_custom_hostname.fallback_origin

  depends_on = [cloudflare_dns_record.this]
}

# Delegated DCV ("txt" with the owner's _acme-challenge CNAME to Cloudflare) renews the certificate without the owner.
resource "cloudflare_custom_hostname" "dashboard" {
  count = local.dashboard_saas ? 1 : 0

  zone_id  = data.cloudflare_zone.dashboard.zone_id
  hostname = var.dashboard_custom_hostname.hostname
  ssl = {
    method   = "txt"
    type     = "dv"
    settings = { min_tls_version = "1.2" }
  }

  depends_on = [cloudflare_custom_hostname_fallback_origin.dashboard]
}

data "cloudflare_dcv_delegation" "dashboard" {
  count = local.dashboard_saas ? 1 : 0

  zone_id = data.cloudflare_zone.dashboard.zone_id
}
