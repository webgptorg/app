# Every <...> value is a placeholder until the team picks the staging domains and creates the staging Cloudflare
# account (docs/plan/README.md, "Still needed"). The module's validations refuse them, so a plan fails before it
# touches anything.

account_id = "<staging-account-id>"

# A registrable domain of its own, like production's, so cookie, PSL and CAA behaviour match.
engine_domain = "<staging-engine-domain>"

# Holds the staging dashboard (app.staging.<placeholder> in apps/dashboard/wrangler.jsonc), the relay hostnames and
# the sending domain. Not ptbk.io: a zone lives in one account, and the staging token must not reach production.
dashboard_zone       = "<staging-zone>"
relay_domain         = "<staging-zone>"
email_sending_domain = "<staging-email-sending-domain>"
dmarc_policy         = "none"

security_contact = "<security-contact>"

# One staging host (I-01); addresses come from its outputs.
relays = {
  relay-fsn = { ipv4 = "<staging-relay-fsn-ipv4>", ipv6 = "<staging-relay-fsn-ipv6>", in_rotation = true }
}
