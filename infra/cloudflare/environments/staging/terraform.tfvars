# Every <...> value is a placeholder that scripts/staging/fill-placeholders.ts fills (docs/staging-runbook.md, step 5).
# The module's validations refuse them, so a plan fails before it touches anything.

# The existing Cloudflare account staging shares with other projects (decided 2026-11-06): its Workers and D1 tokens
# reach everything in it, so they stay on a maintainer's machine (README, Staging: one domain).
account_id = "42b20127fa7293cb5160f22ed42ef43b"

# ptbk.link holds all of staging (decided 2026-11-06): the dashboard's SaaS fallback origin, the relay hostnames, the
# sending domain, the relay's ACME challenge records, the UI releases, and the engines one level down. ptbk.io is in
# another account that we hold no token for; its owner only adds the records of the dashboard_owner_records output.
dashboard_zone       = "ptbk.link"
relay_domain         = "ptbk.link"
email_sending_domain = "mail.ptbk.link"
dmarc_policy         = "none"

security_contact = "<security-contact>"

# The dashboard on app.ptbk.io, which the engines' built-in default dashboard URL names, as a Cloudflare for SaaS custom
# hostname of ptbk.link; the Worker route is in apps/dashboard/wrangler.jsonc.
dashboard_custom_hostname = { hostname = "app.ptbk.io", fallback_origin = "app-origin.ptbk.link" }

# Plain wildcard records while staging has one relay: a load balancer could never drop it (README, Relay DNS). With a
# second relay, switch to "load_balancer" and set ops_email (I-04's ops mailbox) for its health notifications.
relay_dns_mode = "records"

# One staging host (I-01); addresses come from its outputs.
relays = {
  relay-fsn = { ipv4 = "<staging-relay-fsn-ipv4>", ipv6 = "<staging-relay-fsn-ipv6>", in_rotation = true }
}
