# Every <...> value is a placeholder until the team picks the engine domain and creates the production Cloudflare
# account (docs/plan/README.md, "Still needed"). The module's validations refuse them, so a plan fails before it
# touches anything.

account_id = "<production-account-id>"

# Separate registrable domain used for nothing else (spec, Abuse on our domains, item 1). Undecided: team.
engine_domain = "<engine-domain>"

# ptbk.io must be in the production account; this stack adds records to it but does not own it.
dashboard_zone = "ptbk.io"

# Under the engine domain (as relay-1.<engine-domain> in apps/dashboard/wrangler.jsonc assumes) or under ptbk.io:
# an open point in I-02. Either way it must be inside one of the two zones above.
relay_domain = "<relay-domain>"

# A subdomain of ptbk.io keeps transactional mail reputation apart from the brand domain's own mail.
email_sending_domain = "<email-sending-domain>"
dmarc_policy         = "none"

security_contact = "<security-contact>"

# I-04's ops mailbox; Cloudflare emails it when a relay leaves or rejoins the engine wildcard (I-07).
ops_email = "<ops-email>"

# Two hosts in different Hetzner locations (I-01); addresses come from its outputs.
relays = {
  relay-fsn = { ipv4 = "<relay-fsn-ipv4>", ipv6 = "<relay-fsn-ipv6>", in_rotation = true }
  relay-hel = { ipv4 = "<relay-hel-ipv4>", ipv6 = "<relay-hel-ipv6>", in_rotation = true }
}
