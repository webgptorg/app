import type { DnsAnswer, StagingResult, TlsProbe } from './types';

const LETS_ENCRYPT = "Let's Encrypt";
const ACME_FIX =
    'enable ACME: PTBK_ACME_DIRECTORY_URL=https://acme-v02.api.letsencrypt.org/directory (the mock engine also needs MOCK_CERT_SOURCE=acme); the certificate is issued through the relay by TLS-ALPN-01 a minute or so after the engine connects';
const NO_TUNNEL_FIX =
    'the relay has no tunnel for this engine: is the engine running, linked (connect --link) and connected to its relay?';
/** Chain errors that mean the leaf does not lead to a public root at all, as with a development CA. */
const UNTRUSTED_CHAIN = new Set([
    'SELF_SIGNED_CERT_IN_CHAIN',
    'DEPTH_ZERO_SELF_SIGNED_CERT',
    'UNABLE_TO_GET_ISSUER_CERT',
    'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
    'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
]);

/**
 * The engine hostname must resolve, through the dashboard's DNS, to the relay and nowhere else: browsers reach engines
 * only through it, and any other address means another record or a stale override.
 */
export function evaluateDns(
    hostname: string,
    engine: DnsAnswer,
    relays: readonly { readonly hostname: string; readonly answer: DnsAnswer }[],
): StagingResult {
    const id = 'staging.dns.via-relay';
    const fix =
        'the hostname must resolve through the dashboard DNS to the relay: is the engine linked (connect --link) and registered on the dashboard?';
    if (engine.kind === 'failed')
        return { id, status: 'fail', detail: `${hostname} does not resolve (${engine.code})`, fix };
    const relayAddresses = new Set<string>();
    for (const relay of relays) {
        if (relay.answer.kind === 'failed') {
            return {
                id,
                status: 'fail',
                detail: `the relay ${relay.hostname} does not resolve (${relay.answer.code})`,
                fix: "check --relay and this machine's DNS; the relay hostnames are public",
            };
        }
        for (const address of relay.answer.addresses) relayAddresses.add(address);
    }
    const stray = engine.addresses.filter((address) => !relayAddresses.has(address));
    const resolved = engine.addresses.join(', ');
    if (engine.addresses.length === 0 || stray.length > 0) {
        return {
            id,
            status: 'fail',
            detail: `${hostname} resolves to ${resolved || 'nothing'}, which is not only ${relays.map((relay) => relay.hostname).join(', ')} (${[...relayAddresses].join(', ')})`,
            fix,
        };
    }
    return { id, status: 'pass', detail: `${hostname} → ${resolved} (the relay)` };
}

/**
 * Whether the TLS connection verifies against public roots only. `reachable` says whether the HTTP checks can run:
 * they go through Node's fetch, which refuses what the public roots refuse.
 */
export function evaluateTls(
    hostname: string,
    probe: TlsProbe,
    nowMs: number,
): { readonly result: StagingResult; readonly reachable: boolean } {
    const id = 'staging.tls.public-certificate';
    if (probe.kind === 'failed') {
        // Behind an SNI relay a reset or a silent socket means nobody holds a tunnel for the name.
        const fix =
            probe.code === 'ECONNREFUSED'
                ? `nothing accepts connections on ${hostname}:443: check staging.dns.via-relay and that the relay is up`
                : NO_TUNNEL_FIX;
        return {
            result: { id, status: 'fail', detail: `no TLS handshake with ${hostname}:443 (${probe.code})`, fix },
            reachable: false,
        };
    }
    const issuer = issuerName(probe.issuer);
    const expires = new Date(probe.validToMs).toISOString().slice(0, 10);
    if (!probe.authorized) {
        const code = probe.authorizationError ?? 'unknown error';
        const fix =
            code === 'CERT_HAS_EXPIRED'
                ? "the certificate expired: the engine's ACME renewal failed, see its log; it renews through the relay by TLS-ALPN-01"
                : probe.issuer.organization?.includes('(STAGING)') === true
                  ? "the certificate comes from the Let's Encrypt staging directory: use the production one, PTBK_ACME_DIRECTORY_URL=https://acme-v02.api.letsencrypt.org/directory"
                  : UNTRUSTED_CHAIN.has(code)
                    ? `the engine serves its development CA certificate: ${ACME_FIX}`
                    : `the certificate does not verify against public roots: ${ACME_FIX}`;
        return {
            result: {
                id,
                status: 'fail',
                detail: `the certificate (issuer ${issuer}) does not verify against public roots: ${code}`,
                fix,
            },
            reachable: false,
        };
    }
    if (!probe.hostnameMatches) {
        return {
            result: {
                id,
                status: 'fail',
                detail: `the certificate (issuer ${issuer}) does not name ${hostname}`,
                fix: `the engine must serve a certificate for its own hostname: ${ACME_FIX}`,
            },
            reachable: false,
        };
    }
    if (probe.validToMs <= nowMs) {
        return {
            result: {
                id,
                status: 'fail',
                detail: `the certificate (issuer ${issuer}) expired on ${expires}`,
                fix: ACME_FIX,
            },
            reachable: false,
        };
    }
    if (probe.issuer.organization !== LETS_ENCRYPT) {
        return {
            result: {
                id,
                status: 'fail',
                detail: `the certificate is publicly trusted but issued by ${issuer}, not Let's Encrypt`,
                fix: `staging uses Let's Encrypt production: ${ACME_FIX}`,
            },
            reachable: true,
        };
    }
    return { result: { id, status: 'pass', detail: `${issuer}, expires ${expires}` }, reachable: true };
}

function issuerName(name: { readonly organization: string | null; readonly commonName: string | null }): string {
    const parts = [name.organization, name.commonName].filter((part) => part !== null);
    return parts.length === 0 ? 'unnamed' : parts.join(' ');
}
