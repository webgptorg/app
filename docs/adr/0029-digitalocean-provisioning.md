# 0029. Who can provision a customer's DigitalOcean Droplet?

- **Status:** Proposed
- **Date:** 2026-11-28

## Context

An owner should be able to create a VPS, pair a new project and enroll the first passkey entirely in a browser. The existing dashboard holds account and routing metadata. Creating a Droplet lets it spend against the customer's cloud team and choose the code that runs as root on first boot. Both powers go beyond the existing owner handoff. [Pairing and identity](../spec/zero-trust-spec.md#pairing-and-identity) · [ADR 0023](0023-owner-setup-handoff.md)

## Decision

The proposal in [PR 377](https://github.com/webgptorg/app/pull/377) gives the dashboard Worker the provisioning grant for one request. After the customer authorizes their team and confirms the quoted price, the Worker exchanges the public client's PKCE code, checks the live plan and reserves the launch. It sends DigitalOcean the selected image, size, region and cloud-init. An uncertain create response keeps the reservation so a retry cannot create a second paid Droplet for that link.

The Worker reads the access token in memory, discards the refresh token and requests revocation when it finishes. DigitalOcean gives a public client's access token a one-hour lifetime. Its create and prerequisite read scopes apply across the team. A compromised Worker could use the grant to create other billable machines, read cloud metadata, retain credentials or replace the bootstrap. Revocation cannot undo a Droplet already created. [DigitalOcean OAuth](https://docs.digitalocean.com/reference/api/oauth/) · [Required scopes](https://docs.digitalocean.com/reference/api/scopes/droplet/create/)

DigitalOcean receives the one-time pairing code and a digest binding the commissioning user and team through Droplet user data. D1 retains the code hash, the public OAuth client ID and the launch reservation with the Droplet ID when known. Rotating the code also clears the pairing tab's owner setup commitment. The engine uses a separate read-only authorization to check the user, team and Droplet from guest metadata. First-passkey enrollment takes place on the engine origin.

## Alternatives

- **Provider-hosted provisioning.** A Marketplace image or provider-hosted deployment could keep create permission entirely on DigitalOcean. Before choosing it, demonstrate a browser-only way to deliver this project's single-use pairing information to the right Droplet and authenticate its first owner.
- **Provision in the customer's browser.** The browser could exchange the grant and call DigitalOcean directly if those endpoints permit cross-origin requests. Dashboard-delivered JavaScript would still handle the token. The engine would need an independently verifiable binding to the commissioned Droplet.
- **A separately operated provisioning service.** An isolated OAuth origin could keep the token out of the dashboard Worker. The operator of that service would still control a team-scoped grant and the first-boot instructions.

## Consequences

Reviewers must decide whether the dashboard may hold this grant or whether provisioning should move to one of the alternatives. The proposal applies only to the DigitalOcean launch option.

Before merge, run the PR on staging with an authorized test team and the VPS reservation migration applied. Record the revision, outcome and cleanup in the PR. Starting in a fresh browser session, confirm the price, create one Droplet and reload while it pairs. Check that only one Droplet exists, that a different user or team cannot enroll, and that the commissioning user can enroll a passkey and reopen the project without a terminal. Delete the test Droplet in DigitalOcean and confirm removal.
