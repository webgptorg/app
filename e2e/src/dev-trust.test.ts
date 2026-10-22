import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { DevCaFacts, TrustState } from './dev-trust.ts';
import {
    LINUX_RESOLVED_CONTENT,
    LINUX_RESOLVED_FILE,
    MAC_RESOLVER_CONTENT,
    inspectDevCa,
    isTrusted,
    leftovers,
    parseKeychainHashes,
    resolverFiles,
    shellLine,
    trustPlan,
    trustPlatform,
    untrustPlan,
} from './dev-trust.ts';

const HOME = '/Users/dev';
const KEYCHAIN = '/Users/dev/Library/Keychains/login.keychain-db';
const fixture = (name: string): string => readFileSync(join(import.meta.dirname, 'fixtures', name), 'utf8');
const CA: DevCaFacts = { certFile: '/repo/.dev/pki/dev-ca/ca-cert.pem', sha1: 'A'.repeat(40), sha256: 'B'.repeat(64) };
const MAC_FILES = ['/etc/resolver/engine.test', '/etc/resolver/ptbk.test'];

function macState(storedCas: readonly string[], state: 'ours' | 'absent' | 'foreign' = 'absent'): TrustState {
    return { storeExists: true, storedCas, resolverFiles: MAC_FILES.map((path) => ({ path, state })) };
}

function linuxState(stored: boolean, state: 'ours' | 'absent' = 'absent', storeExists = true): TrustState {
    return {
        storeExists,
        storedCas: stored ? ['ptbk-dev-ca'] : [],
        resolverFiles: [{ path: LINUX_RESOLVED_FILE, state }],
    };
}

describe('trustPlan on macOS', () => {
    it('trusts the CA in the login keychain and writes both resolver files in one sudo', () => {
        const plan = trustPlan('darwin', macState([]), CA, HOME);
        if (plan.kind !== 'steps') throw new Error('refused');
        expect(plan.steps.map((step) => step.argv)).toEqual([
            ['security', 'add-trusted-cert', '-r', 'trustRoot', '-k', KEYCHAIN, CA.certFile],
            [
                'sudo',
                'sh',
                '-c',
                'mkdir -p /etc/resolver && printf "nameserver 127.0.0.1\\nport 1053\\n" > /etc/resolver/engine.test && printf "nameserver 127.0.0.1\\nport 1053\\n" > /etc/resolver/ptbk.test',
            ],
        ]);
        expect(plan.steps.filter((step) => step.argv[0] === 'sudo')).toHaveLength(1);
    });

    it('replaces an earlier CA and leaves alone what is already in place', () => {
        const plan = trustPlan('darwin', macState(['C'.repeat(40), CA.sha1], 'ours'), CA, HOME);
        expect(plan).toEqual({
            kind: 'steps',
            steps: [
                expect.objectContaining({
                    argv: ['security', 'delete-certificate', '-Z', 'C'.repeat(40), '-t', KEYCHAIN],
                }),
            ],
        });
        expect(trustPlan('darwin', macState([CA.sha1], 'ours'), CA, HOME)).toEqual({ kind: 'steps', steps: [] });
    });

    it('refuses to overwrite a resolver file someone else wrote', () => {
        expect(trustPlan('darwin', macState([], 'foreign'), CA, HOME)).toMatchObject({ kind: 'refused' });
    });

    it('covers ptbk.test and engine.test only, never all of .test', () => {
        expect(resolverFiles('darwin')).toEqual(MAC_FILES);
        expect(MAC_RESOLVER_CONTENT).toBe('nameserver 127.0.0.1\nport 1053\n');
    });
});

describe('trustPlan on Linux', () => {
    it('adds the CA to the NSS database and a resolved drop-in for the two domains', () => {
        const plan = trustPlan('linux', linuxState(false), CA, '/home/dev');
        if (plan.kind !== 'steps') throw new Error('refused');
        expect(plan.steps.map((step) => step.argv)).toEqual([
            ['certutil', '-A', '-d', 'sql:/home/dev/.pki/nssdb', '-n', 'ptbk-dev-ca', '-t', 'C,,', '-i', CA.certFile],
            [
                'sudo',
                'sh',
                '-c',
                'mkdir -p /etc/systemd/resolved.conf.d && printf "[Resolve]\\nDNS=127.0.0.1:1053\\nDomains=~engine.test ~ptbk.test\\n" > /etc/systemd/resolved.conf.d/ptbk-dev.conf && systemctl restart systemd-resolved',
            ],
        ]);
        expect(LINUX_RESOLVED_CONTENT).toContain('Domains=~engine.test ~ptbk.test');
    });

    it('creates the database first when Chrome never did, and replaces a stored CA', () => {
        const fresh = trustPlan('linux', linuxState(false, 'ours', false), CA, '/home/dev');
        expect(fresh.kind === 'steps' && fresh.steps.map((step) => step.argv.slice(0, 2))).toEqual([
            ['mkdir', '-p'],
            ['certutil', '-N'],
            ['certutil', '-A'],
        ]);
        const again = trustPlan('linux', linuxState(true, 'ours'), CA, '/home/dev');
        expect(again.kind === 'steps' && again.steps.map((step) => step.argv.slice(0, 2))).toEqual([
            ['certutil', '-D'],
            ['certutil', '-A'],
        ]);
    });
});

describe('untrustPlan and leftovers', () => {
    it('removes every dev CA and only our resolver files, in one sudo', () => {
        const state: TrustState = {
            storeExists: true,
            storedCas: [CA.sha1, 'C'.repeat(40)],
            resolverFiles: [
                { path: '/etc/resolver/engine.test', state: 'ours' },
                { path: '/etc/resolver/ptbk.test', state: 'foreign' },
            ],
        };
        expect(untrustPlan('darwin', state, HOME).map((step) => step.argv)).toEqual([
            ['security', 'delete-certificate', '-Z', CA.sha1, '-t', KEYCHAIN],
            ['security', 'delete-certificate', '-Z', 'C'.repeat(40), '-t', KEYCHAIN],
            ['sudo', 'sh', '-c', 'rm -f /etc/resolver/engine.test'],
        ]);
        expect(leftovers(state)).toEqual([
            `dev CA still in the trust store (${CA.sha1})`,
            `dev CA still in the trust store (${'C'.repeat(40)})`,
            'resolver entry /etc/resolver/engine.test still exists',
            'resolver entry /etc/resolver/ptbk.test still exists',
        ]);
    });

    it('restarts resolved on Linux and reports a clean machine as clean', () => {
        expect(untrustPlan('linux', linuxState(true, 'ours'), '/home/dev').map((step) => step.argv)).toEqual([
            ['certutil', '-D', '-d', 'sql:/home/dev/.pki/nssdb', '-n', 'ptbk-dev-ca'],
            ['sudo', 'sh', '-c', `rm -f ${LINUX_RESOLVED_FILE} && systemctl restart systemd-resolved`],
        ]);
        expect(untrustPlan('linux', linuxState(false), '/home/dev')).toEqual([]);
        expect(leftovers(macState([]))).toEqual([]);
    });
});

describe('isTrusted', () => {
    it('needs the current CA and every resolver file', () => {
        expect(isTrusted(macState([CA.sha1], 'ours'), CA, 'darwin')).toBe(true);
        expect(isTrusted(macState(['C'.repeat(40)], 'ours'), CA, 'darwin')).toBe(false);
        expect(isTrusted(macState([CA.sha1], 'absent'), CA, 'darwin')).toBe(false);
        expect(isTrusted(linuxState(true, 'ours'), CA, 'linux')).toBe(true);
    });
});

describe('inspectDevCa', () => {
    it('accepts a CA critically name-constrained to exactly the two domains', () => {
        const facts = inspectDevCa('ca.pem', fixture('dev-ca-constrained.pem'));
        expect(facts.sha1).toMatch(/^[0-9A-F]{40}$/);
        expect(facts.sha256).toMatch(/^[0-9A-F]{64}$/);
    });

    it.each([
        ['dev-ca-unconstrained.pem', 'not name-constrained'],
        ['dev-ca-not-critical.pem', 'not name-constrained'],
        ['dev-ca-other-domain.pem', 'not name-constrained'],
    ])('refuses %s', (name, message) => {
        expect(() => inspectDevCa(name, fixture(name))).toThrow(message);
    });
});

describe('helpers', () => {
    it('reads keychain hashes, quotes shell lines and knows its platforms', () => {
        expect(parseKeychainHashes(`SHA-256 hash: ${'D'.repeat(64)}\nSHA-1 hash: ${CA.sha1}\nkeychain: "x"\n`)).toEqual(
            [CA.sha1],
        );
        expect(shellLine(['sudo', 'sh', '-c', "rm -f '/x' && y"])).toBe(`sudo sh -c 'rm -f '\\''/x'\\'' && y'`);
        expect(trustPlatform('darwin')).toBe('darwin');
        expect(() => trustPlatform('win32')).toThrow('macOS and Linux');
    });
});
