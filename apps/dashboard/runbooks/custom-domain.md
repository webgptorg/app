# Enterprise custom domain

How to put an Enterprise customer's engine on their own hostname, such as `agents.customer.com`. It is set up by hand with each customer; there is no self-service. Security does not rest on this procedure: a relay routes the hostname only if the engine's signed claim verifies **and** the hostname's CNAME points at that same engine's default hostname, and it checks both itself. The dashboard checks them too, but only to give you immediate feedback.

Apex domains (`customer.com` itself) are not supported in v0: an apex cannot carry a CNAME, and the relay's DNS check needs one.

## What the customer does

1. **Pick a subdomain** they control, e.g. `agents.customer.com`.
2. **Verify engine support first.** Current ptbk does not implement `PTBK_CUSTOM_DOMAIN` or a custom-domain CLI. This workflow requires an engine version that can obtain a certificate and produce a signed claim for the hostname; setting the variable alone does not enable it. The integration requires: The engine accepts it with the protocol's `Hostname` rules (ASCII, internationalized names as A-labels, lowercase) and produces the **claim**: an Ed25519 signature by the engine key over `"ptbk-hostname-v1" | hostname | engineId`. It shows the hostname and the claim as base64url (86 characters). How the claim reaches us (CLI output the customer sends, or a later API field) is up to the engine team (E-01); today the customer sends us the engine ID, the hostname and the claim.
3. **Create exactly one DNS record**, once you have confirmed the target (below):

   ```text
   agents.customer.com.  CNAME  <engineId>.<engine domain>.
   ```

   The target is the engine's default hostname, **never a relay hostname**. A CNAME to a relay, or anything else, is not routed.

Once the relays route the hostname, the engine obtains its own certificate for it with ACME TLS-ALPN-01 through the relay, as for its default hostname. We never hold a key or certificate for it.

## What the platform admin does

You need the platform admin role ([scripts/make-admin.md](../scripts/make-admin.md)) and a passkey: every change asks for a step-up and is written to `admin_audit_log`.

1. Open `/admin`, enter the engine ID under **Custom domains** and open the engine's page (`/admin/engines/<engineId>/hostnames`).
2. Copy the **CNAME target** shown on the page and send it to the customer. It is the same for every hostname of the engine.
3. **Add a custom domain** with the hostname and the claim. The dashboard refuses:
   - `invalid-hostname`: not a routable name (an IP address, a wildcard, over 253 characters, a single label);
   - `reserved-domain`: under `ptbk.io`, the engine domain or a relay hostname;
   - `taken`: another engine (or this one) already has it; remove it there first;
   - `bad-claim`: not signed by this engine's key for exactly this hostname and engine ID. Ask the customer to verify engine support and send the claim for the exact hostname again;
   - `limit-reached`: the engine has the 31 custom hostnames a registry entry can carry.

   The hostname is stored as **Waiting for DNS** (`pending-dns`). Relays do not see it yet.

4. When the customer says the record is in place, press **Check DNS**. The page shows what DNS answered when it does not match (another target, no CNAME, or a failed lookup). On the right target the hostname becomes **Active** and appears in the registry entry relays read, with its claim. A failed lookup changes nothing; try again.

## Verify through the relay

The dashboard does not re-check DNS after that; relays do, at every registry refresh (5 minutes), and keep the last positive answer through DNS failures for at most 24 hours. So a hostname can be Active here while relays refuse it, for example after the customer changed the record. Check what the relays do:

1. **DNS:** `dig +short CNAME agents.customer.com` prints `<engineId>.<engine domain>.` and nothing else.
2. **Wait for the refresh:** relays pick the hostname up within 5 minutes of activation, or when the engine reconnects. The engine's tunnel `ready.hostnames` lists the hostnames a relay routes for it; the engine can show them.
3. **Through a relay:** for each relay in `RELAYS`,

   ```sh
   openssl s_client -connect <relay hostname>:443 -servername agents.customer.com -alpn h2 </dev/null
   ```

   A routed hostname reaches the engine: once its certificate is issued, the handshake completes with a certificate for `agents.customer.com` issued to the engine's key. A hostname the relay does not route is closed right after the ClientHello, with no ServerHello. Before the engine has its certificate the engine fails the handshake itself; give ACME a few minutes after routing starts.

4. **In a browser:** `https://agents.customer.com/` loads the engine without a certificate warning.

## Remove

1. On the engine's page, **Remove** the hostname and confirm. Relays stop routing it within one registry cache TTL (5 minutes).
2. Ask the customer to delete the CNAME and remove the hostname from the engine configuration.

A customer who points the CNAME elsewhere stops routing at the relays' next DNS check (5 minutes), whatever the dashboard shows; remove the row too, so the registry stays accurate.
