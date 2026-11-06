# Every <...> value is a placeholder until Seb sends the account details (docs/staging-runbook.md, step 1). The
# module's validations refuse them, so a plan fails before it touches anything.

# The existing Cloudflare account staging shares with other projects (decided 2026-11-06): its Workers and D1 tokens
# reach everything in it, so they stay on a maintainer's machine (README, Staging: one domain).
account_id = "<staging-account-id>"

# ptbk.link holds all of staging (decided 2026-11-06): the dashboard (app.ptbk.link in apps/dashboard/wrangler.jsonc),
# the relay hostnames, the sending domain, the relay's ACME challenge records, and the engines one level down. Not
# ptbk.io: staging must never hold a credential for production's zones.
dashboard_zone       = "ptbk.link"
relay_domain         = "ptbk.link"
email_sending_domain = "mail.ptbk.link"
dmarc_policy         = "none"

security_contact = "<security-contact>"

# Plain wildcard records while staging has one relay: a load balancer could never drop it (README, Relay DNS). With a
# second relay, switch to "load_balancer" and set ops_email (I-04's ops mailbox) for its health notifications.
relay_dns_mode = "records"

# One staging host (I-01); addresses come from its outputs.
relays = {
  relay-fsn = { ipv4 = "<staging-relay-fsn-ipv4>", ipv6 = "<staging-relay-fsn-ipv6>", in_rotation = true }
}
