# Every <...> value is a placeholder until the staging account and keys exist (docs/staging-runbook.md). The modules
# refuse them, so a plan fails before it touches anything.

# One host. Staging and production differ only in the relays, the server type and SSH access.
relays = {
  relay-fsn = { location = "fsn1", reboot_time = "02:00" }
}
server_type = "cx23"

# Staging's one zone, as in infra/cloudflare's staging root: relays at its top level, engines one level down. The
# relay hostname is never under the engine domain. The dashboard is app.ptbk.io, served from ptbk.link (Cloudflare for
# SaaS).
relay_domain  = "ptbk.link"
engine_domain = "engines.ptbk.link"
registry_url  = "https://app.ptbk.io"
acme_email    = "ops@ptbk.link"

# Public keys, not secrets. SSH is open to every address because admins work from changing networks; it stays keys
# only, with no root, passwords or forwarding (decided 2026-11-06).
admins = {
  "seb" = ["ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAII1bGJ51HHpEGKczcCdow989O9PBK9kj8JhDbMYDax97 seb@sebm.local"]
}
ssh_from_anywhere = true
ssh_allowlist     = []
