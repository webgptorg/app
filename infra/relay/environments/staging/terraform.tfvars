# Every <...> value is a placeholder until the staging account and keys exist (docs/staging-runbook.md). The modules
# refuse them, so a plan fails before it touches anything.

# One host. Staging and production differ only in the relays, the server type and the allowlists.
relays = {
  relay-fsn = { location = "fsn1", reboot_time = "02:00" }
}
server_type = "cx23"

# Staging's one zone, as in infra/cloudflare's staging root: relays at its top level, engines one level down. The
# relay hostname is never under the engine domain.
relay_domain  = "ptbk.link"
engine_domain = "engines.ptbk.link"
registry_url  = "https://app.ptbk.link"
acme_email    = "<ops-email>"

admins = {
  "<admin-name>" = ["<admin-ssh-public-key>"]
}
ssh_allowlist = ["<admin-network-cidr>"]
