output "engine_zone_id" {
  value = cloudflare_zone.engine.id
}

output "engine_name_servers" {
  description = "Set these at the engine domain's registrar."
  value       = cloudflare_zone.engine.name_servers
}

output "dnssec_ds" {
  description = "DS record to set at the engine domain's registrar; DNSSEC is not in effect until it is."
  value       = var.dnssec ? cloudflare_zone_dnssec.engine[0].ds : null
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
