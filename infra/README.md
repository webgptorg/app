# Infra

Infrastructure that does not belong to a single app:

- **Relay hosts:** VPSs on 443 (Hetzner EU first, a second host before the paid launch, other providers in v1).
- **Engine DNS:** Cloudflare DNS, DNS-only (never proxied, so TLS stays end to end). A wildcard for the engine domain pointing at every relay.
- **Cloudflare resources** shared across apps. App-specific bindings stay in each app's `wrangler` config.

Tooling: OpenTofu (Hetzner and Cloudflare providers) plus cloud-init ([ADR 0011](../docs/adr/0011-infrastructure-as-code.md)); monitoring is Cloudflare-first (see tasks I-01, I-02, I-04).

- [`cloudflare/`](cloudflare/README.md): engine DNS, relay hostnames, the dashboard's D1 databases and email domain, API tokens and account hardening, per environment.
