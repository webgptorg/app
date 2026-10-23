# Every <...> value is a placeholder until the staging accounts, domains and keys exist (docs/plan/apply.md). The
# modules refuse them, so a plan fails before it touches anything.

# One host. Staging and production differ only in the relays, the server type and the allowlists.
relays = {
  relay-fsn = { location = "fsn1", reboot_time = "02:00" }
}
server_type = "cx23"

# Inside the staging dashboard zone, as in infra/cloudflare's staging tfvars; never under the engine domain.
relay_domain  = "<staging-zone>"
engine_domain = "<staging-engine-domain>"
registry_url  = "https://app.<staging-zone>"
acme_email    = "<ops-email>"

admins = {
  "<admin-name>" = ["<admin-ssh-public-key>"]
}
ssh_allowlist = ["<admin-network-cidr>"]
