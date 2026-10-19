# Infra

Infrastructure that does not belong to a single app:

- **Relay hosts:** VPSs on 443 (Hetzner EU first, a second host before the paid launch, other providers in v1).
- **Engine DNS:** Cloudflare DNS, DNS-only (never proxied, so TLS stays end to end). A wildcard for the engine domain pointing at every relay.
- **Cloudflare resources** shared across apps. App-specific bindings stay in each app's `wrangler` config.

Tooling: OpenTofu (Hetzner and Cloudflare providers) plus cloud-init; monitoring is Cloudflare-first (see tasks I-01, I-02, I-04).
