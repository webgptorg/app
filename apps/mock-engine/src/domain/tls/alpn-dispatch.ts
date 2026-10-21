import type { ClientHelloParse, Hostname } from '@ptbk/protocol';
import { Hostname as HostnameSchema } from '@ptbk/protocol';

/** RFC 8737: the only protocol a TLS-ALPN-01 validation server offers. */
export const ACME_TLS_ALPN_PROTOCOL = 'acme-tls/1';

export type AlpnRejectReason =
    'no-pending-challenge' | 'acme-alpn-mixed' | 'acme-without-sni' | 'malformed' | 'too-large';

export type AlpnDispatch =
    | { readonly kind: 'acme-challenge'; readonly hostname: Hostname }
    | { readonly kind: 'normal' }
    | { readonly kind: 'reject'; readonly reason: AlpnRejectReason };

/** A parse that is final: the caller keeps reading while the parser says `need-more`. */
export type CompleteClientHello = Exclude<ClientHelloParse, { readonly kind: 'need-more' }>;

/**
 * Decides what answers a tunnel stream, from its ClientHello alone. Only a hello offering exactly `acme-tls/1`, for a
 * hostname with a challenge pending right now, reaches the challenge responder; any other `acme-tls/1` hello is
 * refused, so outside an issuance the engine never acts as a TLS-ALPN-01 endpoint. Everything else goes to the normal
 * TLS server, which still refuses names it holds no certificate for; a hello that does not parse goes nowhere.
 */
export function dispatchClientHello(
    hello: CompleteClientHello,
    hasPendingChallenge: (hostname: Hostname) => boolean,
): AlpnDispatch {
    switch (hello.kind) {
        case 'malformed':
            return { kind: 'reject', reason: 'malformed' };
        case 'too-large':
            return { kind: 'reject', reason: 'too-large' };
        case 'no-sni':
            return hello.alpn.includes(ACME_TLS_ALPN_PROTOCOL)
                ? { kind: 'reject', reason: 'acme-without-sni' }
                : { kind: 'normal' };
        case 'sni': {
            if (!hello.alpn.includes(ACME_TLS_ALPN_PROTOCOL)) return { kind: 'normal' };
            // RFC 8737 §3: the validation server offers acme-tls/1 and nothing else; a mix is neither a browser nor a CA.
            if (hello.alpn.length !== 1) return { kind: 'reject', reason: 'acme-alpn-mixed' };
            const hostname = HostnameSchema.safeParse(hello.hostname);
            if (!hostname.success || !hasPendingChallenge(hostname.data)) {
                return { kind: 'reject', reason: 'no-pending-challenge' };
            }
            return { kind: 'acme-challenge', hostname: hostname.data };
        }
    }
}
