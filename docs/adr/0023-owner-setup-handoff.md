# 0023. Owner setup handoff from the pairing browser

- **Status:** Accepted (Seb, 2026-11-25)
- **Date:** 2026-11-23

## Context

After the copied install command pairs an engine, the owner creates the first passkey at `https://<engine>/setup#<secret>`. Only the engine knows that setup secret ([spec, Pairing and identity](../spec/zero-trust-spec.md#pairing-and-identity)): it prints the link in its terminal and, on a local desktop, may open it. On a server reached over SSH nothing opens. The dashboard tab that showed the command sees the engine come online ([onboarding.md](../design/onboarding.md), step 4, row 5) but can only say "open the link in your terminal". Non-technical owners get stuck there.

The dashboard cannot redirect because it never holds the secret, on purpose: app.ptbk.io must not be able to make anyone an engine's owner. This ADR lets the browser tab that created the link code finish setup, while our servers still never see a secret that grants anything.

## Decision

Seb accepted it on 2026-11-25: on by default, for every install (desktop and server), with the early heartbeat. Strict mode and the engine setting keep the original claim. It is built after the engine's server onboarding fixes ship and pass a blank-server run, because a flawless first setup comes first.

**The pairing tab makes a second, one-time setup secret and gives the engine only its hash, through the dashboard.**

1. **Issue.** On "New project", before it asks for a link code, the SPA draws `S`: 16 bytes from `crypto.getRandomValues`, base64url (22 characters), the same format as the engine's own setup secret. It keeps `S` only in `sessionStorage` under the link code's ID, and sends `ownerSetupCommitment = base64url(SHA-256(S))` in the body of `POST /api/engines/link-codes` and the team variant (today they take no input; the field is optional and strictly parsed).
2. **Carry.** The dashboard stores the commitment next to the link code's hash and hands it over once, in the registration response: a new field `ownerSetupCommitment` in `RegisterEngineResponse`, nullable with default `null`, like `memberKey`. It nulls the column when the code is redeemed, cancelled or expires.
3. **Accept.** An engine that understands the field keeps it as a second setup slot: digest and an expiry of 30 minutes from registration. `/setup/options` and `/setup/verify` accept a secret that matches either slot. The first owner passkey spends both. `--setup-link` replaces only the engine's own slot. `--reset-owner` drops the handoff slot. An engine that already has an owner, or runs with handoff off, ignores the field.
4. **Signal.** While the handoff slot is live, the engine has no owner and its address serves browsers (relay connected, certificate valid), its heartbeat carries a new optional field `ownerHandoff: "ready"`.
5. **Redirect.** The tab that holds `S` for this code waits for: code `linked`, engine reachable, `members` = 0 and `ownerHandoff: "ready"`. It then deletes `S` from `sessionStorage` and calls `location.assign("https://<hostname>/setup#" + S)`. Same-tab navigation needs no user gesture, so no popup blocker applies. The gateway setup page is unchanged: it already reads the fragment, removes it from the address bar and posts it only to the engine.
6. **Fallback.** Everything else stays as today: the engine still prints its own setup link, and a tab without `S` (closed, another tab or device, an engine without support, past 30 minutes) shows today's row 5 copy.

**Why a plain SHA-256.** `S` is 128 uniformly random bits, so its hash hides it and binds to it; an HMAC would need a key that no party here can share. Both engines already store their setup secret as hex SHA-256 of its text, so the engine checks the second slot with the code it has. The commitment travels base64url like every binary value ([ADR 0014](0014-cryptography.md)).

**Why a heartbeat signal.** The certificate is ordered only after a tunnel is up, so "reachable" alone could send the owner to a certificate error. The signal also negotiates the feature: an engine sends it only after a dashboard gave it a commitment, so an old dashboard never sees the unknown field, and the tab never sends an old engine a secret it would reject. The engine sends a heartbeat as soon as the signal turns on, so the tab redirects within seconds rather than up to one interval (60 s) later.

**On a local desktop** an engine that holds a commitment does not open its own link in the browser, so the owner does not end up with two setup pages racing; it still prints the link.

## Threat analysis

What changes: our servers still never see a secret that grants ownership (the dashboard stores and relays only `SHA-256(S)`; the relay sees the navigation only as TLS to the engine; the fragment is never sent). But **code we serve on app.ptbk.io now holds a setup secret in the owner's browser.** If that code were compromised while someone pairs, it could read `S` and claim the owner seat without the user running anything malicious.

Why we accept it, and how far it reaches:

- **It adds little to what that code can already do.** The same SPA renders the install command the user pastes into a root shell and serves the install scripts. A compromised dashboard during pairing can already own the machine outright. The handoff does not give it any engine it could not already take.
- **Bounded.** Only engines registered with a commitment from a compromised page, only while they have no owner, only for 30 minutes after registration. Engines already set up ignore the field; nothing re-arms the slot.
- **Not silent** (security goal 3). An owner claimed this way locks the real person out at once ("This project already has an owner"); the dashboard turns "Owner set up", and the engine records the setup in its audit log with the client IP, marked as a handoff, and says so in its terminal. `ptbk connect --reset-owner` recovers.
- **Opt-out.** An engine setting turns handoff off, and strict mode turns it off by default: such engines accept only the terminal link, and the spec's original claim holds for them.

Other cases:

| Case                                   | Result                                                                                                                                                                                                                                                                         |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Link code leaks to someone else        | They can register their own engine to the victim's account, as today. They never get `S`, so they cannot claim the victim's engine. If they pair theirs, the victim's tab may open their engine's setup; the setup page and the dashboard show the same fingerprint, as today. |
| Dashboard database or logs leak        | Only `SHA-256` of a 128-bit secret, nulled after use: no preimage.                                                                                                                                                                                                             |
| XSS on app.ptbk.io                     | Same as the compromise above. The SPA's CSP (no inline script, no external origins, Trusted Types) is what keeps it unlikely.                                                                                                                                                  |
| Several tabs, or a duplicated tab      | Each page load gets its own code and `S`. A duplicated tab copies `sessionStorage`; both may redirect, one passkey wins, the other sees "already has an owner".                                                                                                                |
| Tab closed, reloaded, other device     | Reload keeps `S` (same tab). Otherwise no redirect; the terminal link works as today.                                                                                                                                                                                          |
| Replay                                 | Single use: the first owner spends both slots. Wrong, expired and spent secrets get the same answer.                                                                                                                                                                           |
| Downgrade                              | An engine without support drops the unknown response field (tolerant parsing) and never sends the signal, so the tab never redirects. An old dashboard sends no commitment.                                                                                                    |
| Navigation fails (offline, cert error) | The URL with `S` stays in that tab's history until a setup page loads, exactly like the printed link today, and expires in 30 minutes.                                                                                                                                         |

No extra confirmation step on the setup page. The person who would compare a fingerprint is the one who never looked at the terminal, and the page already shows the engine's fingerprint, which the dashboard shows too.

## Contract changes

- `packages/protocol`: `RegisterEngineResponse.ownerSetupCommitment` (base64url, 32 bytes, nullable, default `null`); heartbeat `ownerHandoff` (optional enum `ready`, v1 and v2). Both are additions in the same version (ADR 0010): servers accept them before any engine sends them, and engines read the response tolerantly.
- Dashboard: optional strict input on both link-code routes, a nullable column on link codes, the field in the registration answer, `ownerHandoff` in the engine view, and the SPA's issue, wait and redirect. No new route.
- Engine (engine team, via the AGENT_BRIEF): the second slot, the signal, the setting, the audit entry, skipping the auto-open. The mock engine and conformance cover the same, including a wrong `S`, an expired slot, a slot on an engine that has an owner, and an old engine.
- Docs, with the implementation (not before, so the spec never claims less than what runs): the spec's sentence "We never see the setup secret, so we cannot claim the owner seat" becomes the bounded claim above; onboarding.md row 5; engine-first-installation.md.

## Alternatives considered

- **Status quo with better copy and a QR code on the dashboard.** No trust change, but the QR cannot carry the secret either, and the stuck step remains copying from an SSH session.
- **Device confirmation code shown in both places** (the engine prints a short code, the tab shows it, the user confirms). It still needs the user to look at the terminal, which is the step that fails, and a short code that the dashboard relays is phishable.
- **The dashboard server holds the setup secret.** Then app.ptbk.io and anyone with its database could claim every new engine, silently and at any time. It breaks the spec's core claim; rejected.
- **Reuse the dashboard passkey.** Passkeys are bound to their RP ID; one made for app.ptbk.io cannot sign in to `<engineId>.<engine domain>`.

## Consequences

- An SSH install ends with the owner's browser on the engine's passkey prompt, with no copying.
- The zero-trust claim for the first 30 minutes after pairing narrows from "we cannot" to "code we serve could, visibly, and only where it could already have changed the command you ran". Strict mode keeps the old claim.
- Two optional contract fields and a second setup slot on the engine. Nothing changes for engines or dashboards that do not adopt it.
