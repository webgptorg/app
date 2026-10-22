# 0011. Infrastructure as code: OpenTofu and cloud-init

- **Status:** Accepted
- **Date:** 2026-10-19 (relay hosts added 2026-10-22)

## Context

Our side runs on Cloudflare (dashboard Worker, D1, DNS, email) and on plain VPSs (relays). The spec (Hosting and stack) wants all of it reproducible from the repo. Two properties matter more than convenience:

- **The engine domain is part of the trust argument.** Whoever can edit it can point an engine hostname elsewhere and get a certificate for it (spec, Residual risks, item 1). A proxied record would make Cloudflare terminate engine TLS. Changes to it must be reviewed, and the rules (DNS-only, no wildcard certificates, nothing on the bare domain) must be checked by code, not by memory.
- **Credentials are the weak point.** A staging credential must not reach production, a deploy credential must not edit DNS, and no relay may hold a credential for the engine domain.

The team chose OpenTofu and cloud-init on 2026-10-19 (plan, Decisions). This ADR records how we use them. Tasks I-01 (relay hosts) and I-02 (DNS and Cloudflare) share it.

## Decision

- **OpenTofu** (`~> 1.10`) with the Cloudflare provider, and the Hetzner provider for relay hosts. **cloud-init** configures hosts at first boot; hosts are rebuilt, not patched by hand.
- **Layout.** One directory per area under `infra/` (`infra/cloudflare`, `infra/relay`). Each has `modules/` with the real configuration and `environments/<env>/` roots that only set the backend, encryption, provider and values. Staging and production use the same module, so they differ only in values, sizes and counts.
- **One state per environment and area**, in an R2 bucket in that environment's own Cloudflare account (S3 backend, `use_lockfile` for locking). The bucket is created by hand once; each is reached with an R2 token scoped to that bucket.
- **State and plans are encrypted client-side** with OpenTofu's state encryption (AES-GCM, key from a PBKDF2 passphrase), `enforced = true`. The passphrase per environment lives in the team password manager and is passed as `TF_VAR_state_passphrase`. Nobody who can read the bucket can read the state without it.
- **Credentials only from the environment** (`CLOUDFLARE_API_TOKEN`, `AWS_*` for R2, `HCLOUD_TOKEN`), never in files. API tokens are created by hand with the scopes documented in each area's README, not by OpenTofu: managing tokens from code would need a token that can mint any token, and would put token values into state.
- **Humans apply.** `tofu plan` and `tofu apply` run on a maintainer's machine; CI holds no IaC credential. Deploys of application code (I-03) use separate, narrower tokens.
- **Providers pinned exactly** (at least 7 days old, as for npm packages), with `.terraform.lock.hcl` committed for Linux and macOS on amd64 and arm64.
- **Rules are code.** Security rules are `precondition`s and variable validations in the modules, so a violating plan fails before it touches anything. Each rule has a `tofu test` case with a mocked provider that runs offline, without an account or token. Placeholder values (`<...>`) fail validation, so nothing can be applied until real values are in.
- **Each app's own config stays with the app.** The dashboard's routes, custom domain and bindings are in `apps/dashboard/wrangler.jsonc` and deployed by wrangler; OpenTofu creates only what must exist first (D1 databases, zones, DNS, email domain) and outputs the IDs that go into `wrangler.jsonc`.

### Relay hosts (I-01)

- **Only the Hetzner provider in `infra/relay`.** Relay DNS records stay in `infra/cloudflare`, whose single record resource carries the DNS-only and no-apex rules; the relay stack outputs the addresses that go there. The R2 bucket is the S3 backend, not a provider.
- **State:** the environment's existing bucket under its own key (`relay/terraform.tfstate`), with the same enforced encryption and passphrase as `infra/cloudflare`. Nothing secret enters the configuration: the user data holds only public keys, addresses and settings, and secrets never pass through OpenTofu.
- **Secrets reach a host by hand.** An admin installs each one over SSH as a root-owned 0600 file in `/etc/ptbk-relay/credentials`; the units read them with systemd `LoadCredential`. Rebuilding a host therefore needs one manual step, which keeps tokens out of tfvars, state and user data.
- **Debian 13 on Hetzner Cloud**, EU locations only, configured once by cloud-init and rebuilt rather than patched. IPv4 and IPv6 primary IPs outlive the server (`auto_delete = false`, delete protection), so a rebuild (`tofu apply -replace`) changes no DNS record.
- **Podman, not Docker.** Podman runs daemonless as the unit's own child, so `Restart=always`, cgroup limits and journald apply to the relay directly, and there is no root daemon socket. Docker's daemon rewrites the host firewall on start, beside nftables. Podman runs rootful (rootless needs setuid `newuidmap` and subordinate IDs on the host), but the relay inside runs as uid 10001 with a read-only root, no capabilities and `no-new-privileges`. It uses host networking, so the relay sees real client addresses for its per-IP limits and no container NAT sits in the path; it binds 443 because `ip_unprivileged_port_start` is 443.
- **The relay's own certificate: ACME DNS-01 through a challenge zone, not TLS-ALPN-01.** `_acme-challenge.<relay hostname>` is a CNAME into a zone that serves nothing else, and the host holds a Cloudflare token that can edit only that zone. lego (Debian's package, so it gets security updates) issues and renews the certificate from a sandboxed timer unit. TLS-ALPN-01 would need no credential at all, but the relay must already hold a certificate to start, would have to answer the challenge itself (an ACME client inside the relay), and could not renew while it is down. The cost: a compromised relay could obtain certificates for every name delegated to the challenge zone, which are the relay hostnames only, never an engine name or the dashboard. Per-relay CAA `accounturi` records would narrow it further.
- **A renewal restarts the relay.** systemd 257 does not refresh credentials on reload, so the new certificate is loaded by a restart; the relay closes its tunnels with `SHUTTING_DOWN` and engines move to a peer relay. Each host renews an hour after its own reboot window, and the windows of an environment's relays are at least two hours apart.
- **SSH: an IP allowlist** in both the Hetzner firewall and nftables, with key-only logins for named admins and a separate deploy key with a forced command. No bastion or WireGuard for now; either can replace the allowlist without touching the rest.
- **Connection tracking stays on**, sized for 262,144 entries, rather than `notrack` on 443: the per-source connection limits in nftables count tracked connections.
- **The user data is rendered by a module without a provider**, so CI renders it and checks it with cloud-init, nft, systemd-analyze, sshd and ShellCheck, then boots it in a VM, all without an account or token.

## Consequences

- Every DNS change, including on the engine domain, is a reviewed diff, and drift shows up as a non-empty `tofu plan`.
- The DNS-only and no-apex rules hold for any record added later, as long as it goes through the module's single record resource; reviewers check that new DNS resources do.
- Losing an environment's state passphrase means rebuilding its state by import; the passphrase is backed up like a root credential.
- A credential leak is limited by design: the deploy token cannot edit DNS, staging tokens cannot see production, and a relay holds no credential for the engine or dashboard zones, only a token for the ACME challenge zone.
- Humans running `apply` is slower than a pipeline and depends on discipline: apply only from a merged `main`, and run `tofu plan` first. A CI plan job (no apply) can come later with a read-only token.
- CI runs `tofu fmt -check`, `tofu validate` and `tofu test` for every module under `infra/` (`infra/relay/scripts/check.sh`, runnable locally with Docker), and boots the relay host's user data in a VM.
- Relay hosts need a human to place their secrets after every rebuild, and an ACME challenge zone per environment.
