import { describe, expect, it } from 'vitest';

import { evaluateDns, evaluateTls } from './network';
import type { TlsProbe } from './types';

const HOST = 'abcdefghijklmnopqrstuvwxyz.engines.ptbk.link';
const RELAY = {
    hostname: 'relay-fsn.ptbk.link',
    answer: { kind: 'resolved', addresses: ['192.0.2.1', '2001:db8::1'] },
} as const;
const NOW = Date.parse('2026-11-11T00:00:00Z');
const LATER = Date.parse('2027-02-01T00:00:00Z');

function handshake(overrides: Partial<Extract<TlsProbe, { kind: 'handshake' }>> = {}): TlsProbe {
    return {
        kind: 'handshake',
        authorized: true,
        authorizationError: null,
        hostnameMatches: true,
        issuer: { organization: "Let's Encrypt", commonName: 'E6' },
        validToMs: LATER,
        ...overrides,
    };
}

describe('evaluateDns', () => {
    it('passes when every address is the relay’s', () => {
        expect(evaluateDns(HOST, { kind: 'resolved', addresses: ['2001:db8::1', '192.0.2.1'] }, [RELAY])).toMatchObject(
            {
                status: 'pass',
            },
        );
    });

    it.each([
        ['no record', { kind: 'failed', code: 'ENOTFOUND' }, [RELAY], 'does not resolve (ENOTFOUND)', 'connect --link'],
        [
            'another address',
            { kind: 'resolved', addresses: ['192.0.2.1', '198.51.100.9'] },
            [RELAY],
            '198.51.100.9',
            'connect --link',
        ],
        ['no address', { kind: 'resolved', addresses: [] }, [RELAY], 'resolves to nothing', 'connect --link'],
        [
            'an unresolvable relay',
            { kind: 'resolved', addresses: ['192.0.2.1'] },
            [{ hostname: 'relay.test', answer: { kind: 'failed', code: 'ENOTFOUND' } }],
            'the relay relay.test does not resolve',
            '--relay',
        ],
    ] as const)('fails on %s', (_name, engine, relays, detail, fix) => {
        const result = evaluateDns(HOST, engine, relays);
        expect(result.status).toBe('fail');
        expect(result.detail).toContain(detail);
        expect(result.fix).toContain(fix);
    });
});

describe('evaluateTls', () => {
    it("passes a Let's Encrypt certificate and reports issuer and expiry", () => {
        expect(evaluateTls(HOST, handshake(), NOW)).toEqual({
            result: {
                id: 'staging.tls.public-certificate',
                status: 'pass',
                detail: "Let's Encrypt E6, expires 2027-02-01",
            },
            reachable: true,
        });
    });

    it.each([
        ['a reset (no tunnel)', { kind: 'failed', code: 'ECONNRESET' }, 'ECONNRESET', 'no tunnel', false],
        ['a timeout', { kind: 'failed', code: 'TIMEOUT' }, 'TIMEOUT', 'no tunnel', false],
        [
            'a refused connection',
            { kind: 'failed', code: 'ECONNREFUSED' },
            'ECONNREFUSED',
            'nothing accepts connections',
            false,
        ],
        [
            'a development CA',
            handshake({
                authorized: false,
                authorizationError: 'SELF_SIGNED_CERT_IN_CHAIN',
                issuer: { organization: null, commonName: 'Mock engine dev CA' },
            }),
            'issuer Mock engine dev CA',
            'development CA certificate',
            false,
        ],
        [
            "a Let's Encrypt staging certificate",
            handshake({
                authorized: false,
                authorizationError: 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
                issuer: { organization: "(STAGING) Let's Encrypt", commonName: 'Fake E6' },
            }),
            'does not verify against public roots',
            'staging directory',
            false,
        ],
        [
            'an expired certificate',
            handshake({ authorized: false, authorizationError: 'CERT_HAS_EXPIRED' }),
            'CERT_HAS_EXPIRED',
            'renewal failed',
            false,
        ],
        [
            'another verification error',
            handshake({
                authorized: false,
                authorizationError: 'CERT_REVOKED',
                issuer: { organization: null, commonName: null },
            }),
            'issuer unnamed',
            'does not verify against public roots',
            false,
        ],
        ['an unexplained refusal', handshake({ authorized: false }), 'unknown error', 'does not verify', false],
        ['another hostname', handshake({ hostnameMatches: false }), `does not name ${HOST}`, 'its own hostname', false],
        ['an expiry in the past', handshake({ validToMs: NOW - 1 }), 'expired on', 'enable ACME', false],
        [
            'another public CA',
            handshake({ issuer: { organization: 'Google Trust Services', commonName: 'WE1' } }),
            'issued by Google Trust Services WE1',
            "Let's Encrypt production",
            true,
        ],
    ] as const)('fails on %s', (_name, probe, detail, fix, reachable) => {
        const evaluated = evaluateTls(HOST, probe, NOW);
        expect(evaluated.reachable).toBe(reachable);
        expect(evaluated.result.status).toBe('fail');
        expect(evaluated.result.detail).toContain(detail);
        expect(evaluated.result.fix).toContain(fix);
    });
});
