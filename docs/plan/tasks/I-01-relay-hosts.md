# I-01. Relay hosts: provisioning and hardening

- **Lane:** I · **Module:** `infra/relay` · **Milestone:** M4
- **Depends on:** R-04 · **Unblocks:** I-03, I-04
- **Status:** todo
- **Spec:** Relay and tunnel (Hosting; No single point of failure; Fairness and DoS); Hosting and stack; Operations; Metadata we still see; Legal and GDPR (sub-processors)

## Goal

Relay hosts are created and hardened from code: one in staging, two in production (Hetzner, EU, different locations), each running the relay as an unprivileged service on raw TCP 443, with OpenTofu and cloud-init.

## Context

The relay needs raw TCP on 443 and long-lived connections, so it runs on plain VPSs, not Workers. It sees only ciphertext, so the host affects availability and metadata, not confidentiality, but a compromised host could still log metadata or drop traffic, so it is hardened anyway. It holds no engine keys, only its own TLS key and its registry token (D-04). Hetzner EU is first; a second production host must exist before the paid launch; other providers come in v1. I-03 deploys the relay image onto these hosts; this task prepares the hosts.

## Scope

- Tooling (decided 2026-10-19): **OpenTofu** with the Hetzner and Cloudflare providers, and **cloud-init** to harden the host and run the signed relay container under systemd. State in an encrypted remote backend (R2), no secrets in plain state. Record the details (backend, module layout, secrets handling) as an ADR with the next free number; I-02 reuses the same setup.
- `infra/relay/`: host definitions for `staging` (1 host) and `production` (2 hosts, e.g. `relay-fsn` and `relay-hel`), IPv4 and IPv6, smallest instance that R-05's load test supports.
- Hardening, all from code:
  - Debian stable (or Ubuntu LTS) image; unattended security upgrades with automatic reboot in a staggered window per host so both production relays never reboot together;
  - provider firewall and host nftables: inbound 443/tcp from anywhere, 22/tcp only from an allowlist in config, ICMP; everything else dropped; outbound limited to what the relay, updates and time sync need;
  - SSH: keys only, no root login, no password authentication, named admin users from config; a separate deploy key with a forced command (used by I-03);
  - relay runs as a dedicated non-root user in a container (Docker or Podman, chosen in the ADR) under systemd: read-only root filesystem, all capabilities dropped (443 via port mapping or `ip_unprivileged_port_start`), `no-new-privileges`, memory and file-descriptor limits sized for 1,000+ tunnels;
  - chrony for time sync; journald persistent with `MaxRetentionSec=7day` (the spec's maximum for engine IPs and tunnel times);
  - no engine keys, certificates or DNS credentials for the engine domain on the host.
- Secrets on the host: registry token and relay TLS key in root-owned 0600 files passed to the service with systemd `LoadCredential`, never in the image, the repo or provisioning state.
- Relay TLS certificate for its own hostname: choose and implement one route in the ADR (the relay answering TLS-ALPN-01 for its own name, or DNS-01 with a credential scoped so it cannot touch the engine domain zone). Renewal is automatic and monitored by I-04.
- `infra/relay/verify.sh`: run against a host over SSH; fails if the service runs as root, if any port other than 443 and 22 listens publicly, if password SSH or root login is enabled, if unattended upgrades are off, or if any file matching engine key or certificate patterns exists outside the relay's own.
- `infra/relay/README.md`: create, rebuild, rotate secrets, add a relay to DNS (with I-02), remove a dead relay.

## Out of scope

- DNS records (I-02); image build, signing and rollout (I-03); metrics and alerting (I-04); relay limits tuning (I-05).
- Providers other than Hetzner (v1).

## Design notes

- Hosts are cattle: no state worth backing up. Rebuilding a host from scratch is the recovery path.
- A DNS credential that can edit the engine domain must never live on a relay: with it, a compromised relay could obtain certificates for engine hostnames.
- Keep host config identical between staging and production except sizes, counts and allowlists.

## Acceptance criteria

- [ ] ADR merged with status `Accepted` and listed in `docs/adr/README.md`.
- [ ] Staging relay created from code; `verify.sh` passes against it; the e2e or spike suite runs green against it with the mock engine.
- [ ] Staging relay destroyed and recreated from code with no manual steps beyond secret placement, documented with timings in the PR.
- [ ] Production hosts defined (created once provider accounts exist); `verify.sh` passes on both.
- [ ] A port scan from outside shows only 443 open (22 only from the allowlist).
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Risks and open points

- Provider accounts and who holds them are a pending human decision (plan README).
- SSH access model: IP allowlist versus a bastion or WireGuard; decide in the ADR with the team.
- Relay hostname domain (under the engine domain or a separate infra domain) is decided in I-02.
- Instance size depends on R-05 results; 1,000 idle tunnels per small VPS is a target to confirm.
