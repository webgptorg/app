# I-01. Relay hosts: provisioning and hardening

- **Lane:** I · **Module:** `infra/relay` · **Milestone:** M4
- **Depends on:** R-04, R-06 (R-05 supplies only the sizing value; see Scope)
- **Status:** in progress (feat/i-01-relay-hosts)
- **Spec:** Relay and tunnel (Hosting; No single point of failure; Fairness and DoS); Hosting and stack; Operations; Metadata we still see; Legal and GDPR (sub-processors)

## Goal

Relay hosts are created and hardened from code: one in staging, two in production (Hetzner, EU, different locations), each running the relay as an unprivileged service on raw TCP 443, with OpenTofu and cloud-init.

## Context

The relay needs raw TCP on 443 and long-lived connections, so it runs on plain VPSs, not Workers. It sees only ciphertext, so the host affects availability and metadata, not confidentiality, but a compromised host could still log metadata or drop traffic, so it is hardened anyway. It holds no engine keys, only its own TLS key and its registry token (D-04). Hetzner EU is first; a second production host must exist before the paid launch; other providers come in v1. I-03 deploys the relay image onto these hosts; this task prepares the hosts.

## Scope

- Tooling (decided 2026-10-19): **OpenTofu** with the Hetzner and Cloudflare providers, and **cloud-init** to harden the host and run the signed relay container under systemd. State in an encrypted remote backend (R2), no secrets in plain state. Record the details (backend, module layout, secrets handling) as ADR 0011 (infrastructure as code), shared with I-02: whichever of the two starts first writes it, the other reuses it.
- `infra/relay/`: host definitions for `staging` (1 host) and `production` (2 hosts, e.g. `relay-fsn` and `relay-hel`), IPv4 and IPv6. The instance type is a `server_type` variable defaulting to the CX22 class; R-05's load test results change only the tfvars, so this task does not wait for R-05.
- Hardening, all from code:
  - Debian stable (or Ubuntu LTS) image; unattended security upgrades with automatic reboot in a staggered window per host so both production relays never reboot together;
  - provider firewall and host nftables: inbound 443/tcp from anywhere, 22/tcp only from an allowlist in config, ICMP; everything else dropped; outbound limited to what the relay, updates and time sync need;
  - SSH: keys only, no root login, no password authentication, named admin users from config; a separate deploy key with a forced command (used by I-03);
  - relay runs as a dedicated non-root user in a container (Docker or Podman, chosen in the ADR) under systemd: read-only root filesystem, all capabilities dropped (443 via port mapping or `ip_unprivileged_port_start`), `no-new-privileges`, memory and file-descriptor limits sized for 1,000+ tunnels;
  - chrony for time sync; journald persistent with `MaxRetentionSec=7day` (the spec's maximum for engine IPs and tunnel times);
  - no engine keys, certificates or DNS credentials for the engine domain on the host;
  - Node 24 at the latest patch (at least 24.17, which fixed TLS and SNI issues); `--max-old-space-size` set explicitly, below the container's memory limit with headroom for socket buffers, which live outside the JS heap; `LimitNOFILE` at least four times the relay's global connection cap; `Restart=always`;
  - kernel: `net.ipv4.tcp_syncookies=1`, raised `net.core.somaxconn` and `net.ipv4.tcp_max_syn_backlog` with a matching listen backlog; no connection tracking for 443/tcp (`notrack`), or `nf_conntrack_max` sized for 10,000+ long-lived connections;
  - nftables per-IP connection-count and new-connection-rate limits on 443 ahead of Node (IPv6 per /64), set above the relay's own limits so they only stop floods;
  - a local DNSSEC-validating resolver (e.g. unbound) used by the relay, so a spoofed answer cannot fake a custom domain's CNAME check (R-02) or an ACME validation routed through it.
- Secrets on the host: registry token and relay TLS key in root-owned 0600 files passed to the service with systemd `LoadCredential`, never in the image, the repo or provisioning state. The relay reads `RELAY_REGISTRY_TOKEN` only from the environment today (`apps/relay/src/app/config.ts`); add `RELAY_REGISTRY_TOKEN_FILE` (exactly one of the two set; a test covers both and the conflict), since `LoadCredential` provides a file.
- CI without credentials, in `ci.yml`: `tofu fmt -check`, `tofu validate` and `tofu test` (provider `mock_provider`, no backend) for every module under `infra/`, including I-02's; `cloud-init schema` on the user data; `nft -c -f` on the ruleset; `systemd-analyze verify` and `systemd-analyze security` on the unit; shellcheck on the scripts. Then boot a Debian genericcloud image with the same cloud-init (NoCloud seed) in QEMU/KVM on a GitHub-hosted runner and run `verify.sh` and a port scan against it.
- Relay TLS certificate for its own hostname: choose and implement one route in the ADR (the relay answering TLS-ALPN-01 for its own name, or DNS-01 with a credential scoped so it cannot touch the engine domain zone). Renewal is automatic and monitored by I-04.
- `infra/relay/verify.sh`: run against a host over SSH; fails if the service runs as root, if `Restart=always`, the sysctls above or DNSSEC validation are missing, if any port other than 443 and 22 listens publicly, if password SSH or root login is enabled, if unattended upgrades are off, or if any file matching engine key or certificate patterns exists outside the relay's own.
- `infra/relay/README.md`: create, rebuild, rotate secrets, add a relay to DNS (with I-02), remove a dead relay.
- DDoS: the provider's free filtering covers network floods only, not TLS-handshake or slow-connection attacks, which R-06's limits handle. Several relays at different providers, all returned by DNS, keep engines reachable when one is attacked; document this and the escalation path in the README.

## Out of scope

- DNS records (I-02); image build, signing and rollout (I-03); metrics and alerting (I-04); relay limits tuning (I-05).
- Providers other than Hetzner (v1).

## Design notes

- Hosts are cattle: no state worth backing up. Rebuilding a host from scratch is the recovery path.
- A DNS credential that can edit the engine domain must never live on a relay: with it, a compromised relay could obtain certificates for engine hostnames.
- Keep host config identical between staging and production except sizes, counts and allowlists.

## Acceptance criteria

- [ ] ADR 0011 merged (by this task or I-02) with status `Accepted` and listed in `docs/adr/README.md`.
- [ ] The CI checks in Scope run on every PR that touches `infra/` and pass, including `tofu test` for I-02's module.
- [ ] In the CI VM, `verify.sh` passes, and a port scan shows only 443 open and 22 only from the allowlist; a deliberately broken setting (for example password SSH enabled) makes `verify.sh` fail (verified once, noted in the PR).
- [ ] `RELAY_REGISTRY_TOKEN_FILE` is supported and tested.
- [ ] Production hosts are defined in code (two locations); staging and production differ only in sizes, counts and allowlists.
- [ ] `bun run check` passes.
- [ ] **Status** line above set to `done (#<PR>)`.

## Apply (needs credentials)

Tracked in [apply.md](../apply.md). Needs a Hetzner project and `HCLOUD_TOKEN` per environment, the admin SSH keys and allowlist, the R2 state bucket and passphrase, a relay registry token (D-04) and the relay hostname in DNS (I-02).

- Staging relay created from code; `verify.sh` passes against it; the e2e or spike suite runs green against it with the mock engine.
- Staging relay destroyed and recreated from code with no manual steps beyond secret placement, with timings recorded.
- A port scan from outside shows only 443 open (22 only from the allowlist).
- Production hosts created; `verify.sh` passes on both.

## Risks and open points

- Provider accounts and who holds them are a pending human decision (plan README).
- SSH access model: IP allowlist versus a bastion or WireGuard; decide in the ADR with the team.
- Relay hostname domain (under the engine domain or a separate infra domain) is decided in I-02.
- Instance size depends on R-05 results; 1,000 idle tunnels per small VPS is a target to confirm. Only the `server_type` default changes with it.
