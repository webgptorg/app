import { beforeEach, describe, expect, it } from 'vitest';

import type { CtCertRecord, CtStore } from '../domain/abuse/ct-store';

const NOW = 1_800_000_000_000;
const DAY = 86_400_000;

export interface CtStoreFixture {
    readonly store: CtStore;
    /** Registers an engine whose default hostname is `hostname`. */
    addEngine(hostname: string): Promise<void>;
}

let counter = 0;

/** Unique per call: the workers project keeps one D1 database for the whole file. */
function hostname(): string {
    counter++;
    return `host-${String(counter)}.engines.ptbk.test`;
}

function record(overrides: Partial<CtCertRecord> = {}): CtCertRecord {
    counter++;
    return {
        issuanceSha256: counter.toString(16).padStart(64, '0'),
        source: 'crt.sh',
        firstSeenAt: NOW,
        notBefore: NOW - DAY,
        hostnames: ['a.engines.ptbk.test'],
        issuer: "C=US, O=Let's Encrypt, CN=R11",
        alert: [],
        ...overrides,
    };
}

/** One suite, run against the D1 and the in-memory CT store. */
export function describeCtStoreContract(name: string, makeFixture: () => CtStoreFixture): void {
    describe(`CtStore contract: ${name}`, () => {
        let fixture: CtStoreFixture;

        beforeEach(() => {
            fixture = makeFixture();
        });

        it('remembers each source’s cursor and replaces it', async () => {
            const { store } = fixture;
            expect(await store.cursor('certspotter')).toBeNull();
            await store.saveCursor('certspotter', '10');
            await store.saveCursor('certspotter', '11');
            await store.saveCursor('crt.sh', '7');
            expect(await store.cursor('certspotter')).toBe('11');
            expect(await store.cursor('crt.sh')).toBe('7');
        });

        it('stores a certificate once and says which keys it knows', async () => {
            const { store } = fixture;
            const first = record({ alert: ['wildcard', 'foreign-issuer'] });
            const other = record();
            await store.insert([first]);
            await store.insert([{ ...first, issuer: 'changed' }, other]);
            const unknown = record().issuanceSha256;
            expect(await store.known([first.issuanceSha256, other.issuanceSha256, unknown])).toEqual(
                new Set([first.issuanceSha256, other.issuanceSha256]),
            );
            expect(await store.known([])).toEqual(new Set());
        });

        it('handles more keys and records than one statement binds', async () => {
            const { store } = fixture;
            const many = Array.from({ length: 120 }, () => record());
            await store.insert(many);
            expect((await store.known(many.map((item) => item.issuanceSha256))).size).toBe(120);
        });

        it('finds registered engine hostnames among names', async () => {
            const registered = hostname();
            await fixture.addEngine(registered);
            expect(await fixture.store.registeredHostnames([registered, hostname()])).toEqual(new Set([registered]));
            expect(await fixture.store.registeredHostnames([])).toEqual(new Set());
        });

        it('counts the certificates issued for a hostname since a time, whole names only', async () => {
            const { store } = fixture;
            const host = hostname();
            await store.insert([
                record({ hostnames: [host], notBefore: NOW - 2 * DAY }),
                record({ hostnames: ['other.example', host], notBefore: NOW - DAY }),
                record({ hostnames: [`x${host}`], notBefore: NOW - DAY }),
                record({ hostnames: [host], notBefore: NOW - 10 * DAY }),
            ]);
            expect(await store.countIssuedSince(host, NOW - 3 * DAY)).toBe(2);
            expect(await store.countIssuedSince(host, NOW - 30 * DAY)).toBe(3);
        });

        it('prunes certificates first seen before a time', async () => {
            const { store } = fixture;
            const old = record({ firstSeenAt: NOW - 500 * DAY });
            const recent = record({ firstSeenAt: NOW - DAY });
            await store.insert([old, recent]);
            await store.prune(NOW - 400 * DAY);
            expect(await store.known([old.issuanceSha256, recent.issuanceSha256])).toEqual(
                new Set([recent.issuanceSha256]),
            );
        });
    });
}
