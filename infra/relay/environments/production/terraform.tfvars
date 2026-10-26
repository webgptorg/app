# Every <...> value is a placeholder until the production accounts, domains and keys exist (docs/plan/apply.md). The
# modules refuse them, so a plan fails before it touches anything.

# Two hosts in different locations whose reboot windows never overlap. Staging and production differ only in the
# relays, the server type and the allowlists.
relays = {
  relay-fsn = { location = "fsn1", reboot_time = "02:00" }
  relay-hel = { location = "hel1", reboot_time = "04:00" }
}
server_type = "cx23"

# Under ptbk.io or another domain in infra/cloudflare's zones, never under the engine domain: the relay refuses a
# hostname there (apps/relay, RELAY_HOSTNAME).
relay_domain  = "<relay-domain>"
engine_domain = "<engine-domain>"
registry_url  = "https://app.ptbk.io"
acme_email    = "<ops-email>"

admins = {
  "<admin-name>" = ["<admin-ssh-public-key>"]
}
deploy_key    = "<production-deploy-ssh-public-key>"
ssh_allowlist = ["<admin-network-cidr>"]
