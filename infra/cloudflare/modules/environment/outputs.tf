output "engine_zone_id" {
  description = "The zone that holds the engine records: the engine zone, or dashboard_zone's with engine_zone_mode = \"subdomain\"."
  value       = local.engine_zone_id
}

output "engine_name_servers" {
  description = "Set these at the engine domain's registrar; null for a subdomain, which needs none."
  value       = local.engine_own_zone ? cloudflare_zone.engine[0].name_servers : null
}

output "dnssec_ds" {
  description = "DS record to set at the engine domain's registrar; DNSSEC is not in effect until it is. null without DNSSEC or for a subdomain."
  value       = length(cloudflare_zone_dnssec.engine) > 0 ? cloudflare_zone_dnssec.engine[0].ds : null
}

output "dashboard_zone_id" {
  value = data.cloudflare_zone.dashboard.zone_id
}

output "d1_database_id" {
  description = "Goes into apps/dashboard/wrangler.jsonc as this environment's database_id."
  value       = cloudflare_d1_database.dashboard.id
}

output "relay_hostnames" {
  value = { for name, _ in var.relays : name => "${name}.${var.relay_domain}" }
}

output "email_dkim_selector" {
  value = cloudflare_email_sending_subdomain.dashboard.dkim_selector
}

output "email_return_path_domain" {
  value = cloudflare_email_sending_subdomain.dashboard.return_path_domain
}

output "ui_release_url" {
  description = "PTBK_UI_RELEASE_URL for engines; null without ui_releases."
  value       = var.ui_releases == null ? null : "https://${var.ui_releases.hostname}/"
}

output "dashboard_owner_records" {
  description = "DNS-only records the owner of dashboard_custom_hostname's zone adds; when = \"cutover\" only once we say so (docs/staging-runbook.md, DNS records for the ptbk.io owner). null without it."
  value = local.dashboard_saas ? [
    {
      when    = "now"
      type    = "CNAME"
      name    = "_acme-challenge.${var.dashboard_custom_hostname.hostname}"
      content = "${var.dashboard_custom_hostname.hostname}.${data.cloudflare_dcv_delegation.dashboard[0].uuid}.dcv.cloudflare.com"
    },
    {
      when    = "now"
      type    = "TXT"
      name    = try(cloudflare_custom_hostname.dashboard[0].ownership_verification.name, null)
      content = try(cloudflare_custom_hostname.dashboard[0].ownership_verification.value, null)
    },
    {
      when    = "cutover"
      type    = "CNAME"
      name    = var.dashboard_custom_hostname.hostname
      content = var.dashboard_custom_hostname.fallback_origin
    },
  ] : null
}
