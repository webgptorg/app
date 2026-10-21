import { X509Certificate } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Hostname } from '@ptbk/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createFakeClock } from '../testing/fake-clock';
import type { FakeClock } from '../testing/fake-clock';
import { createFakeIssuer } from '../testing/fake-acme-issuer';
import type { FakeIssuer } from '../testing/fake-acme-issuer';
import { createMemoryLogger } from '../testing/memory-logger';
import type { MemoryLogger } from '../testing/memory-logger';
import { AcmeSetupError } from './acme-account-key';
import type { AcmeCertificateSource } from './acme-certificate-source';
import {
    ACME_CERTIFICATE_FILE,
    ACME_KEY_FILE,
    ACME_TLS_DIRECTORY,
    ISSUE_TIMEOUT_MS,
    createAcmeCertificateSource,
} from './acme-certificate-source';

const HOST = Hostname.parse('abcdefghijklmnopqrstuvwxyz.engine.test');
const CUSTOM = Hostname.parse('chat.customer.test');
const LIFETIME_MS = 90_000;
const START_MS = Date.UTC(2026, 9, 21, 12, 0, 0);

let dataDir: string;
let clock: FakeClock;
let logger: MemoryLogger;
let issuer: FakeIssuer;
const sources: AcmeCertificateSource[] = [];

beforeEach(async () => {
    dataDir = await mkdtemp(join(tmpdir(), 'ptbk-acme-source-'));
    clock = createFakeClock(START_MS);
    logger = createMemoryLogger();
    issuer = createFakeIssuer({ clock, lifetimeMs: LIFETIME_MS });
});

afterEach(async () => {
    for (const source of sources.splice(0)) source.close();
    await rm(dataDir, { recursive: true, force: true });
});

async function source(issueTimeoutMs?: number): Promise<AcmeCertificateSource> {
    const created = await createAcmeCertificateSource({
        issuer,
        dataDir,
        clock,
        logger,
        ...(issueTimeoutMs === undefined ? {} : { issueTimeoutMs }),
    });
    sources.push(created);
    return created;
}

/** Real time for the issuer's promise and the file writes after it; the fake clock only drives the schedule. */
async function settle(): Promise<void> {
    for (let i = 0; i < 10; i++) await new Promise((resolve) => setTimeout(resolve, 2));
}

function events(name: string) {
    return logger.entries.filter((entry) => entry.event === name);
}

/** Waits (in real time, bounded) until `event` was logged `count` times in all. */
async function logged(event: string, count: number): Promise<void> {
    for (let waited = 0; events(event).length < count; waited++) {
        if (waited > 2_000)
            throw new Error(`${event} was logged ${String(events(event).length)} times, not ${String(count)}`);
        await new Promise((resolve) => setTimeout(resolve, 1));
    }
}

const issued = (count: number): Promise<void> => logged('acme.certificate-issued', count);
const failed = (count: number): Promise<void> => logged('acme.issue-failed', count);

function leafOf(acme: AcmeCertificateSource, hostname = HOST): X509Certificate {
    const credentials = acme.current(hostname);
    if (credentials === undefined) throw new Error(`no certificate for ${hostname}`);
    return new X509Certificate(credentials.certificateChainPem);
}

describe('ACME certificate source', () => {
    it('issues only once a relay routes the engine, then serves the certificate and announces it', async () => {
        const acme = await source();
        let changes = 0;
        acme.onChange(() => changes++);
        acme.addHostnames([HOST]);
        await settle();
        expect(issuer.calls).toEqual([]);
        acme.routable();
        await issued(1);
        expect(issuer.calls).toEqual([[HOST]]);
        expect(changes).toBe(1);
        expect(leafOf(acme).checkHost(HOST)).toBe(HOST);
        expect(acme.current(Hostname.parse('unknown.engine.test'))).toBeUndefined();
        expect(events('acme.certificate-issued')[0]?.fields).toEqual({
            hostnames: 1,
            notAfter: new Date(START_MS + LIFETIME_MS).toISOString(),
        });
    });

    it('stores chain and key 0600 in PTBK_DATA_DIR/tls/, and never logs them', async () => {
        const acme = await source();
        acme.addHostnames([HOST]);
        acme.routable();
        await issued(1);
        const directory = join(dataDir, ACME_TLS_DIRECTORY);
        expect((await stat(directory)).mode & 0o777).toBe(0o700);
        for (const file of [ACME_CERTIFICATE_FILE, ACME_KEY_FILE]) {
            expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
        }
        const key = await readFile(join(directory, ACME_KEY_FILE), 'utf8');
        expect(acme.current(HOST)?.privateKeyPem.reveal()).toBe(key);
        expect(JSON.stringify(logger.entries)).not.toContain('PRIVATE KEY');
    });

    it('renews once a third of the lifetime remains, and the next connection gets the new certificate', async () => {
        const acme = await source();
        acme.addHostnames([HOST]);
        acme.routable();
        await issued(1);
        const first = leafOf(acme).fingerprint256;
        clock.advance((LIFETIME_MS * 2) / 3 - 1);
        await settle();
        expect(issuer.calls).toHaveLength(1);
        clock.advance(1);
        await issued(2);
        expect(issuer.calls).toHaveLength(2);
        expect(leafOf(acme).fingerprint256).not.toBe(first);
    });

    it('keeps serving the current certificate while renewals fail, retrying with backoff', async () => {
        const acme = await source();
        acme.addHostnames([HOST]);
        acme.routable();
        await issued(1);
        const first = leafOf(acme).fingerprint256;
        issuer.behaviour = { kind: 'fail', stage: 'challenge' };
        clock.advance((LIFETIME_MS * 2) / 3);
        await failed(1);
        expect(leafOf(acme).fingerprint256).toBe(first);
        expect(events('acme.issue-failed')[0]?.fields).toEqual({
            problem: 'IssueFailedError',
            stage: 'challenge',
            failures: 1,
            retryInMs: 5_000,
            serving: true,
        });
        clock.advance(4_999);
        await settle();
        expect(issuer.calls).toHaveLength(2);
        clock.advance(1);
        await failed(2);
        expect(events('acme.issue-failed')[1]?.fields['retryInMs']).toBe(10_000);
        issuer.behaviour = { kind: 'issue' };
        clock.advance(10_000);
        await issued(2);
        expect(issuer.calls).toHaveLength(4);
        expect(leafOf(acme).fingerprint256).not.toBe(first);
    });

    it('gives up on an issuance that takes too long, aborting it, and tries again', async () => {
        const acme = await source(1_000);
        issuer.behaviour = { kind: 'hang' };
        acme.addHostnames([HOST]);
        acme.routable();
        await settle();
        clock.advance(1_000);
        await failed(1);
        expect(issuer.lastSignal()?.aborted).toBe(true);
        expect(events('acme.issue-failed')[0]?.fields).toMatchObject({
            problem: 'IssueTimeoutError',
            stage: 'none',
            serving: false,
        });
        expect(acme.current(HOST)).toBeUndefined();
        issuer.behaviour = { kind: 'issue' };
        clock.advance(5_000);
        await issued(1);
        expect(acme.current(HOST)).toBeDefined();
        expect(ISSUE_TIMEOUT_MS).toBe(120_000);
    });

    it('orders again with every hostname when one is added, also while an issuance is running', async () => {
        const acme = await source();
        issuer.behaviour = { kind: 'hang' };
        acme.addHostnames([HOST]);
        acme.routable();
        await settle();
        acme.addHostnames([HOST, CUSTOM]);
        acme.addHostnames([HOST]);
        issuer.behaviour = { kind: 'issue' };
        issuer.release();
        await issued(2);
        expect(issuer.calls).toEqual([[HOST], [HOST, CUSTOM]]);
        expect(leafOf(acme, CUSTOM).checkHost(CUSTOM)).toBe(CUSTOM);
    });

    it('serves a stored certificate after a restart without ordering, and renews it when due', async () => {
        const first = await source();
        first.addHostnames([HOST]);
        first.routable();
        await issued(1);
        const fingerprint = leafOf(first).fingerprint256;
        first.close();

        const restarted = await source();
        restarted.addHostnames([HOST]);
        restarted.routable();
        await settle();
        expect(issuer.calls).toHaveLength(1);
        expect(leafOf(restarted).fingerprint256).toBe(fingerprint);
        expect(events('acme.certificate-loaded')).toHaveLength(1);
        clock.advance(LIFETIME_MS);
        await issued(2);
        expect(issuer.calls).toHaveLength(2);
    });

    it('orders a new certificate when the stored one does not cover a hostname', async () => {
        const first = await source();
        first.addHostnames([HOST]);
        first.routable();
        await issued(1);
        first.close();
        const restarted = await source();
        restarted.addHostnames([HOST, CUSTOM]);
        restarted.routable();
        await issued(2);
        expect(issuer.calls).toEqual([[HOST], [HOST, CUSTOM]]);
    });

    it('ignores a stored pair whose key does not match its certificate', async () => {
        const first = await source();
        first.addHostnames([HOST]);
        first.routable();
        await issued(1);
        first.close();
        const directory = join(dataDir, ACME_TLS_DIRECTORY);
        await writeFile(join(directory, ACME_KEY_FILE), await readFile(join(directory, ACME_CERTIFICATE_FILE)));
        const restarted = await source();
        expect(events('acme.certificate-unusable')).toHaveLength(1);
        restarted.addHostnames([HOST]);
        restarted.routable();
        await issued(2);
        expect(issuer.calls).toHaveLength(2);
    });

    it('refuses stored files or a directory others can read', async () => {
        const directory = join(dataDir, ACME_TLS_DIRECTORY);
        await mkdir(directory, { mode: 0o700 });
        await writeFile(join(directory, ACME_CERTIFICATE_FILE), 'x', { mode: 0o600 });
        await writeFile(join(directory, ACME_KEY_FILE), 'x', { mode: 0o600 });
        await chmod(join(directory, ACME_CERTIFICATE_FILE), 0o644);
        await expect(source()).rejects.toThrow(AcmeSetupError);
        await chmod(directory, 0o755);
        await expect(source()).rejects.toThrow(/accessible by group or others/);
    });

    it('stops renewing on close, and drops an issuance that was running', async () => {
        const acme = await source();
        acme.addHostnames([HOST]);
        acme.routable();
        await issued(1);
        issuer.behaviour = { kind: 'hang' };
        clock.advance((LIFETIME_MS * 2) / 3);
        await settle();
        expect(issuer.calls).toHaveLength(2);
        acme.close();
        expect(issuer.lastSignal()?.aborted).toBe(true);
        await settle();
        expect(clock.pendingTimers()).toBe(0);
        expect(events('acme.issue-failed')).toEqual([]);
        acme.addHostnames([CUSTOM]);
        await settle();
        expect(issuer.calls).toHaveLength(2);
    });

    it('removes onChange listeners, and opens the gate once', async () => {
        const acme = await source();
        let changes = 0;
        acme.onChange(() => changes++)();
        acme.addHostnames([HOST]);
        acme.routable();
        acme.routable();
        await issued(1);
        expect(changes).toBe(0);
        expect(issuer.calls).toHaveLength(1);
    });
});
