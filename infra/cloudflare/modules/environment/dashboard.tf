# The Worker, its routes and its custom domain are deployed by wrangler from apps/dashboard/wrangler.jsonc (I-03);
# this stack only creates what has to exist before the first deploy.
resource "cloudflare_d1_database" "dashboard" {
  account_id            = var.account_id
  name                  = "ptbk-dashboard-${var.environment}"
  primary_location_hint = "weur"

  lifecycle {
    prevent_destroy = true
  }
}

# Cloudflare publishes the SPF, DKIM and return-path records of a sending domain in a zone it hosts; DMARC is ours
# (local.email_records).
resource "cloudflare_email_sending_subdomain" "dashboard" {
  zone_id = data.cloudflare_zone.dashboard.zone_id
  name    = var.email_sending_domain

  lifecycle {
    precondition {
      condition     = var.email_sending_domain == var.dashboard_zone || endswith(var.email_sending_domain, ".${var.dashboard_zone}")
      error_message = "email_sending_domain must be inside dashboard_zone."
    }

    # Mail reputation and engine reputation must not share a domain (spec, Abuse on our domains, item 1).
    precondition {
      condition     = !(var.email_sending_domain == var.engine_domain || endswith(var.email_sending_domain, ".${var.engine_domain}"))
      error_message = "email_sending_domain must not be under the engine domain."
    }
  }
}
