# Engines fetch signed UI releases from this hostname (release mirror layout v1). Everything in the bucket is verified
# by the engine, so serving it publicly is safe; the r2.dev address stays off so this hostname is the only one.
resource "cloudflare_r2_custom_domain" "ui_releases" {
  count = var.ui_releases == null ? 0 : 1

  account_id  = var.account_id
  bucket_name = var.ui_releases.bucket
  domain      = var.ui_releases.hostname
  zone_id     = data.cloudflare_zone.dashboard.zone_id
  enabled     = true
  min_tls     = "1.2"
}

resource "cloudflare_r2_managed_domain" "ui_releases" {
  count = var.ui_releases == null ? 0 : 1

  account_id  = var.account_id
  bucket_name = var.ui_releases.bucket
  enabled     = false
}
