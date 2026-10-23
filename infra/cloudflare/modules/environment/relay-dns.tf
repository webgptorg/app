# The engine domain's wildcard is a DNS-only Cloudflare load balancer (I-07): it answers *.<engine domain> with every
# relay in rotation that passes its health check, so a relay that hangs after accepting TCP (which browsers do not fail
# over from) leaves DNS without anyone holding an engine-zone token at runtime.
#
# One primary pool with every relay at equal weight: a DNS-only load balancer then returns the addresses of all healthy
# endpoints of the pool, and drops only the unhealthy ones. One pool per relay would answer with a single pool, so a
# single relay per query, and lose the browser's own retry of the next address that covers dead relays in under a
# second. The fallback pool holds the same relays without a monitor: Cloudflare answers with it when the primary pool
# has no healthy endpoint, so a checker outage or a monitor that fails everywhere keeps every relay listed and alerts.

locals {
  relay_endpoints = flatten([
    for name, relay in local.relays_in_rotation : [
      for family, address in { ipv4 = relay.ipv4, ipv6 = relay.ipv6 } : {
        name                        = "${name}-${family}"
        address                     = address
        # The monitor's Host header, and with it the TLS server name: the relay's own hostname and certificate.
        host = "${name}.${var.relay_domain}"
      }
    ]
  ])

  relay_monitor = {
    timeout_s        = 3
    retries          = 1
    consecutive_down = 2
    consecutive_up   = 3
  }

  relay_dns_ttl_s = 30
}

resource "cloudflare_load_balancer_monitor" "relay" {
  account_id       = var.account_id
  description      = "ptbk-${var.environment} relays: /healthz on each relay's own hostname"
  type             = "https"
  method           = "GET"
  path             = "/healthz"
  expected_codes   = "200"
  expected_body    = "ok"
  follow_redirects = false
  allow_insecure   = false
  interval         = var.relay_health_check.interval_s
  timeout          = local.relay_monitor.timeout_s
  retries          = local.relay_monitor.retries
  consecutive_down = local.relay_monitor.consecutive_down
  consecutive_up   = local.relay_monitor.consecutive_up
}

resource "cloudflare_load_balancer_pool" "relays" {
  account_id      = var.account_id
  name            = "ptbk-${var.environment}-relays"
  description     = "Every relay in rotation, health-checked; the engine wildcard lists the healthy ones."
  monitor         = cloudflare_load_balancer_monitor.relay.id
  check_regions   = var.relay_health_check.regions
  minimum_origins = 1
  origins = [
    for endpoint in local.relay_endpoints : {
      name    = endpoint.name
      address = endpoint.address
      enabled = true
      weight  = 1
      header  = { host = [endpoint.host] }
    }
  ]
}

resource "cloudflare_load_balancer_pool" "relays_fallback" {
  account_id      = var.account_id
  name            = "ptbk-${var.environment}-relays-fallback"
  description     = "Every relay in rotation, unchecked; answered only when no endpoint of the primary pool is healthy."
  minimum_origins = 1
  origins = [
    for endpoint in local.relay_endpoints : {
      name    = endpoint.name
      address = endpoint.address
      enabled = true
      weight  = 1
    }
  ]
}

resource "cloudflare_load_balancer" "engine_wildcard" {
  zone_id     = cloudflare_zone.engine.id
  name        = local.wildcard
  description = "Managed by OpenTofu (infra/cloudflare): every healthy relay for every engine hostname"
  # Proxying would make Cloudflare terminate TLS for engine hostnames (AGENTS.md rule 1); the tests pin it.
  proxied          = false
  ttl              = local.relay_dns_ttl_s
  steering_policy  = "off"
  session_affinity = "none"
  default_pools    = [cloudflare_load_balancer_pool.relays.id]
  fallback_pool    = cloudflare_load_balancer_pool.relays_fallback.id
}

# Pool and endpoint health changes, to the same ops mailbox as I-04's alerts. Cloudflare sends these itself, so a relay
# leaving or rejoining DNS alerts even when the dashboard is down.
resource "cloudflare_notification_policy" "relay_health" {
  account_id  = var.account_id
  name        = "ptbk-${var.environment} relay DNS health"
  description = "A relay left or rejoined the engine wildcard, or every relay is unhealthy (I-07)."
  alert_type  = "load_balancing_health_alert"
  enabled     = true
  mechanisms  = { email = [{ id = var.ops_email }] }
  filters = {
    pool_id      = [cloudflare_load_balancer_pool.relays.id]
    event_source = ["pool", "origin"]
    new_health   = ["Healthy", "Unhealthy"]
  }
}
