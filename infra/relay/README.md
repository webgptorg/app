# infra/relay

Relay hosts for staging (one) and production (two, in different locations), built and hardened from code with OpenTofu and cloud-init ([ADR 0011](../../docs/adr/0011-infrastructure-as-code.md)). Task I-01. The relay itself is `apps/relay`; I-03 builds, signs and deploys its image onto these hosts.

Hosts are cattle: nothing on them is worth a backup. Rebuilding one from code is the recovery path.

## What a host is

| Part             | Setting                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ---------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Machine          | Hetzner Cloud, EU (`fsn1`, `nbg1`, `hel1`), `server_type` (default `cx23`, the 2 vCPU, 4 GB class that replaced the deprecated `cx22`), Debian 13. IPv4 and IPv6 primary IPs that outlive the server, so a rebuild keeps its DNS records                                                                                                                                                                                |
| Firewall         | Hetzner firewall and nftables, both: in 443/tcp from anywhere, 22/tcp from `ssh_allowlist` (or from anywhere with `ssh_from_anywhere = true`, which staging sets and which then requires an empty allowlist), ICMP; out 443, 80 (apt, metadata), 53, 123, DHCP, ICMP; everything else dropped. On 443, per source (IPv4 address, IPv6 /64) at most 512 connections and 100 new per second, above the relay's own limits |
| SSH              | Keys only (ed25519 or ECDSA P-256, hardware `sk-` keys welcome), named admins from `admins`, no root, no passwords, no forwarding, at most 3 tries and a 20-second login window. That holds whether SSH is allowlisted (production) or open to every address (staging, whose admins work from changing networks; decided 2026-11-06). No deploy user or deploy key: relays pull their deploys ([Deploys](#deploys))     |
| Relay            | `ptbk-relay.service`: rootful Podman runs the image by digest with host networking, as uid 10001, read-only root, all capabilities dropped, `no-new-privileges`, 3 GiB memory, 65,536 files, V8 heap 1 GiB, `Restart=always`. Settings in `/etc/ptbk-relay/relay.env`, sizes in `limits.env`, image in `/var/lib/ptbk-relay-deploy/image.env` (the deploy's)                                                            |
| Secrets          | Root-owned 0600 files in `/etc/ptbk-relay/credentials`, handed to the units with `LoadCredential`; never in the image, the user data, tfvars or state                                                                                                                                                                                                                                                                   |
| Own certificate  | `ptbk-relay-cert.timer`: lego (the upstream release pinned in `modules/cloud-init/main.tf`) obtains and renews the relay's certificate with ACME DNS-01 through a challenge zone that holds nothing else (staging: directly in its one zone); the relay restarts to load a new one                                                                                                                                      |
| Kernel           | `tcp_syncookies`, `somaxconn` and `tcp_max_syn_backlog` 8192, `nf_conntrack_max` 262144, `ip_unprivileged_port_start` 443, no redirects or source routes, restricted `ptrace`, BPF and kernel pointers                                                                                                                                                                                                                  |
| DNS              | unbound on 127.0.0.1, validating DNSSEC; the host and the relay (`RELAY_DNS_SERVERS`) resolve only through it                                                                                                                                                                                                                                                                                                           |
| Updates and time | unattended security upgrades with automatic reboot at the host's `reboot_time`; chrony as a client only                                                                                                                                                                                                                                                                                                                 |
| Logs             | journald, persistent, `MaxRetentionSec=7day` (engine IPs and tunnel times)                                                                                                                                                                                                                                                                                                                                              |

A relay host holds no engine key, no engine certificate and no credential for the engine domain's DNS. `verify.sh` checks that, along with everything above.

## Layout

```
modules/cloud-init/      One host's user data, rendered from files/ (no provider); its validations refuse bad values
                         Sent gzipped and base64-encoded: Hetzner caps user data at 32 KiB; cloud-init decodes it
modules/cloud-init/files The host's files: units, nftables, sshd, sysctl, unbound, scripts
modules/environment/     Hetzner resources for one environment: firewall, primary IPs, servers
environments/<env>/      Backend, state encryption, provider; values in terraform.tfvars
verify.sh                Checks a running host over SSH
scripts/check.sh         The offline checks of CI's infra job, for all of infra/ (needs Docker only)
scripts/rolling-deploy.sh Moves the relays' deploy tags to one image, one relay at a time (release-relay.yml)
test/vm-test.sh          CI's relay-host-vm job: boots the user data under QEMU/KVM and checks it from outside
test/deploy-test.sh      CI's relay-deploy job: the deploy script on two hosts in containers (host.Containerfile)
test/fake-sigstore/      A test-only Fulcio, CT log, Rekor and TSA in one Go program, for deploy-test.sh
test/render/             The user data with fixed test values, for all of the above
```

Staging and production use the same modules and identical roots (`check.sh` diffs them), so they differ only in `terraform.tfvars`: the relays, the server type and SSH access. The diff ignores only the R2 account in the state endpoint.

## Credentials

| Credential                                                                                                                                     | Where it lives                                                                      | Used for                            |
| ---------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------- | ----------------------------------- |
| `HCLOUD_TOKEN`, read and write on the environment's project                                                                                    | Password manager; environment variable while running tofu                           | Creating hosts                      |
| R2 token for `ptbk-tofu-state-<env>`, state passphrase                                                                                         | Password manager (the same as `infra/cloudflare`)                                   | State; `TF_VAR_state_passphrase`    |
| Admin SSH public keys, `ssh_allowlist`, `ssh_from_anywhere`                                                                                    | `terraform.tfvars`                                                                  | Admin access                        |
| `registry-token`: relay token, one per relay (D-04's mint script)                                                                              | `/etc/ptbk-relay/credentials/registry-token` on that host only                      | `RELAY_REGISTRY_TOKEN_FILE`         |
| `metrics-token`: metrics token, one per relay (`ptbk_mt_` and 43 base64url)                                                                    | `/etc/ptbk-relay/credentials/metrics-token`; the dashboard's `RELAY_METRICS_TOKENS` | `RELAY_METRICS_TOKEN_FILE` (I-04)   |
| `acme-dns-token`: Cloudflare token, DNS edit on the ACME challenge zone only (staging: on `ptbk.link`)                                         | `/etc/ptbk-relay/credentials/acme-dns-token`                                        | The relay's own certificate         |
| `tls.key`, `tls.crt`                                                                                                                           | Created on the host by `ptbk-relay-cert`                                            | The relay's own TLS listener        |
| `registry-auth`: `<account>:<token>`, a GHCR `read:packages` token of a machine account that can read only the relay package, never a person's | `/etc/ptbk-relay/credentials/registry-auth`                                         | Deploys: tag, pull, signature check |

In production, the ACME token must not be able to edit anything but the challenge zone: not the engine zone (with it, a compromised relay could obtain certificates for engine hostnames) and not the dashboard zone. Staging runs on one domain, so its token edits that whole zone, engine names included: a staging-only relaxation ([staging runbook, Staging relaxations](../../docs/staging-runbook.md#staging-relaxations-not-for-production)). Either way, restrict it to the relays' addresses with the token's client IP filter once they exist.

## Bootstrap (once per environment)

1. Create a Hetzner project for the environment and a read and write API token in it.
2. The state bucket and passphrase are `infra/cloudflare`'s (its README, Bootstrap); this stack uses the key `relay/terraform.tfstate`.
3. Production, ACME challenge zone: a zone in the environment's Cloudflare account that serves nothing (for example a dedicated domain), and a token with Zone Read and DNS Edit on that zone only. For every relay, a CNAME `_acme-challenge.<relay hostname>` → `<relay name>.<challenge zone>` in the relay domain's zone, through `extra_records` in `infra/cloudflare`. Staging has no challenge zone and no CNAME: its token has Zone Read and DNS Edit on the staging zone, and lego writes `_acme-challenge.<relay hostname>` there itself.
4. Replace the placeholders in `environments/<env>/terraform.tfvars`. `relay_domain` must be inside one of `infra/cloudflare`'s zones and never under the engine domain (the relay refuses such a hostname).

## Create a host

```sh
cd infra/relay/environments/staging
export HCLOUD_TOKEN=...                                      # the staging project's token
export AWS_ACCESS_KEY_ID=... AWS_SECRET_ACCESS_KEY=...        # R2 token for the state bucket
export TF_VAR_state_passphrase=...
tofu init
tofu plan -out=tfplan
tofu apply tfplan
tofu output relays                                           # addresses for infra/cloudflare's relays variable
```

First boot takes a few minutes: packages, hardening, possibly one reboot for a new kernel. cloud-init reports done even when a first-boot step failed, so check `systemctl is-active unbound` and `command -v lego cosign` on the host first. Then, as an admin:

1. **Place the secrets.** From a machine that holds them, never through the repo, a PR or a chat:
   ```sh
   ssh <admin>@<host> 'sudo install -m 0600 /dev/stdin /etc/ptbk-relay/credentials/registry-token' < registry-token
   printf 'ptbk_mt_%s\n' "$(openssl rand -base64 32 | tr '+/' '-_' | tr -d '=')" > metrics-token   # once per relay
   ssh <admin>@<host> 'sudo install -m 0600 /dev/stdin /etc/ptbk-relay/credentials/metrics-token' < metrics-token
   ssh <admin>@<host> 'sudo install -m 0600 /dev/stdin /etc/ptbk-relay/credentials/acme-dns-token' < acme-dns-token
   ```
2. **Obtain the certificate** (in production, needs the challenge CNAME from Bootstrap): `ssh <admin>@<host> sudo systemctl start ptbk-relay-cert.service`, then `sudo journalctl -u ptbk-relay-cert` shows the result. The timer checks it daily from then on and renews it when lego's default says so: a third of its lifetime left, or earlier if the CA's renewal information asks.
3. **Place `registry-auth`** the same way; until it exists the deploy timer does nothing. Then roll the current release out to this host with `release-relay.yml` (it moves the host's tag; with a dispatch and the current `digest` for a single rebuilt host). The deploy writes `/var/lib/ptbk-relay-deploy/image.env` with the verified digest and starts `ptbk-relay.service`; until all of `image.env`, `registry-token`, `tls.crt` and `tls.key` exist, the unit does not start. `metrics-token` is optional: without it the relay starts with `/metrics` answering 404, and the dashboard's scrape alerts `relay-unreachable` for that relay until it is placed (`sudo systemctl restart ptbk-relay` after placing it).
4. **Verify** from outside: `infra/relay/verify.sh <admin>@<host>` must print `all checks passed`; a port scan from outside the allowlist (`nmap -Pn -p- <host>`) must show only 443 (443 and 22 with `ssh_from_anywhere`).
5. **Add it to DNS**: put its addresses into `relays` in `infra/cloudflare/environments/<env>/terraform.tfvars` (with I-02), plan and apply there.

## Deploys

The relay image is built and signed by `release-relay.yml`, and relays **pull** it: nothing reaches into a host to deploy, so SSH stays admins-only and there is no deploy key (I-03, decided 2026-10-23; rollouts, rollback and rotation in [docs/runbooks/deploy.md](../../docs/runbooks/deploy.md)).

`ptbk-relay-deploy.timer` runs `ptbk-relay-deploy.service` every minute. It reads this host's tag, `ghcr.io/webgptorg/relay:deploy-<relay hostname>`, with the read-only registry token (`LoadCredential`), and when the tag names another image it: verifies the signature with cosign and the exact identity in `deploy.env` (`release-relay.yml` on `main` of `webgptorg/app`, GitHub's OIDC issuer, Rekor entry, SCT and RFC 3161 timestamp, Sigstore's public-good root, whose TUF metadata cosign keeps in `/var/lib/ptbk-relay-deploy`); refuses an image without a build time, or built more than 30 days before the newest image this host ever ran (a high-water mark that only goes up) or before `PTBK_DEPLOY_MIN_CREATED`, unless it is the previous image or listed in `/etc/ptbk-relay/allow-downgrade`; pulls it, swaps `image.env` and restarts the relay; and rolls back unless the relay answers `/healthz` and wins back its engines within 60 s (counted with the relay's `ptbk_relay_tunnels_active` gauge, read with the host's metrics token, or from the relay's journal without one). A refused or failed digest is not tried again until the tag moves; an outage of the registry, Sigstore or DNS is not a refusal, and the next run retries. The relay reports the digest it runs in `/healthz`'s `ptbk-relay-image` header, which is how the pipeline follows a rollout.

As an admin: `sudo ptbk-relay-deploy status` (current, previous and refused image, unit, connected engines, tag), `sudo ptbk-relay-deploy rollback` (back to the previous image and stay there), `sudo ptbk-relay-deploy resume` (follow the tag again). The output is in `journalctl -u ptbk-relay-deploy`.

The user data installs cosign 3.1.3 from its GitHub release, pinned by SHA-256 (`install-cosign`): Debian 13's cosign 2.5 cannot read the bundles cosign 3 writes. It gets no Debian security updates, so its pin is bumped like any other dependency, by Renovate once the repo runs it and by hand until then.

## Rebuild a host

The same steps, with `tofu apply -replace='module.environment.hcloud_server.relay["<name>"]'`. The primary IPs stay, so DNS needs no change; the server shuts down first, so the relay closes its tunnels and engines move to a peer relay. Then place the secrets again and start `ptbk-relay-cert`. Before placing `registry-auth`, set the downgrade floor to the UTC day the current release was built (its digest is in `sudo ptbk-relay-deploy status` on a peer relay; `skopeo login ghcr.io` first), because the rebuilt host has no high-water mark and the empty default would accept any image we ever signed until its first deploy:

```sh
skopeo inspect --format '{{.Created}}' docker://ghcr.io/webgptorg/relay@<current digest>   # e.g. 2026-10-20T09:14:02Z
ssh <admin>@<host> "sudo sed -i 's/^PTBK_DEPLOY_MIN_CREATED=.*/PTBK_DEPLOY_MIN_CREATED=<that day, e.g. 2026-10-20>/' /etc/ptbk-relay/deploy.env"
```

Then place `registry-auth`, deploy and verify. Changing the user data or the server type also replaces the host. Record the timings in the apply PR.

## Rotate secrets

- **Registry token**: mint a new one (D-04), install it as above, `sudo systemctl restart ptbk-relay`, then revoke the old one in the dashboard.
- **Metrics token**: generate a new one, update the relay's entry in the dashboard's `RELAY_METRICS_TOKENS` secret first, then install it as above and `sudo systemctl restart ptbk-relay`; the scrape alerts for the minute in between.
- **ACME token**: roll it in Cloudflare, install it as above; nothing to restart.
- **Relay certificate**: issued and renewed by the timer. To replace it at once (for example after a key leak), `sudo rm -rf /var/lib/private/ptbk-relay-cert/certificates` and `sudo systemctl start ptbk-relay-cert`.
- **lego**: the hosts install the release pinned in `modules/cloud-init/main.tf` (`local.lego`), checked against its SHA-256 (ADR 0011). To bump it, set the new version and both hashes from that release's `lego_<version>_checksums.txt`, run `scripts/check.sh` and the VM test, then rebuild the hosts one at a time.
- **Admin keys, SSH access**: change `terraform.tfvars` and rebuild the hosts one at a time (the user data applies at first boot only). For a leaked key, remove it from `~/.ssh/authorized_keys` on every host by hand at once, then rebuild.

## Remove a dead relay

1. Take it out of the engine wildcard: `in_rotation = false` in `infra/cloudflare` (its README, Runbook: a relay out of rotation). Where the engine wildcard is a load balancer (`relay_dns_mode`), a relay that stops answering its health check has already left by itself (I-07, within about a minute); this keeps it out while you work on it, and in records mode it is what takes it out. Engines and browsers already use the other relays.
2. Rebuild it (above), or remove it from `relays` here and in `infra/cloudflare`. Its primary IPs have delete protection: lift it in the Hetzner console first if the addresses should go too.
3. Put it back in rotation once `verify.sh` passes and engines have reconnected.

## DDoS

Hetzner filters network-layer floods for free. It does not stop TLS-handshake floods or slow connections; the relay's own limits (R-06) do, and nftables drops a single source's floods before they reach Node. What keeps engines reachable is several relays, all in DNS: browsers retry the next address and engines keep tunnels to every relay. A relay that is flooded until it cannot finish handshakes for its own hostname leaves DNS through the load balancer's health check where the engine wildcard is one (`infra/cloudflare` README, Relay DNS) and comes back once it passes again.

Escalation when a relay is attacked:

1. Check whether the attack is volumetric (Hetzner's graphs, `nft list set inet ptbk https_rate_v4`) or reaches the relay (I-04's metrics: pending connections, refusals).
2. If one relay is saturated and the others are healthy, take it out of rotation (above) and open a ticket with Hetzner support.
3. If every relay is hit, add relays in further locations (a new entry in `relays` plus DNS); relays at other providers come in v1.
4. Record the incident in the ops log.

## Checks

```sh
infra/relay/scripts/check.sh            # offline, any machine with Docker: tofu fmt, validate, test; cloud-init, nft,
                                        # systemd-analyze, sshd, unbound, ShellCheck on the rendered user data
sudo infra/relay/test/vm-test.sh        # Linux with KVM, after `bun run --filter @ptbk/relay build`;
                                        # VM_TEST_ACME=direct issues the certificate as staging does, without a CNAME
infra/relay/test/deploy-test.sh         # Docker (privileged containers) and bash 4, after `bun install` and
                                        # `bun run --filter @ptbk/mock-engine build`; about 6 minutes
```

`check.sh` covers `infra/cloudflare` too. A provider upgrade works as in `infra/cloudflare`: a version at least 7 days old in every `required_providers` block, then `tofu providers lock` for the four platforms in each directory that has a lock file.

## Not here

DNS records (`infra/cloudflare`, I-02); the release pipeline itself (`.github/workflows/release-relay.yml`, I-03); metrics and alerts, including the certificate's expiry (I-04); tuning the relay's limits (I-05, through `relay_settings` in `terraform.tfvars`). Providers other than Hetzner come in v1.
