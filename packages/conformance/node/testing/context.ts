import { request } from 'node:https';

import { createSeededRandom } from '../../src/index';
import type { Closable, PlatformCheckContext } from '../harness/platform';
import { HARNESS_ENGINE_DOMAIN } from '../harness/run-platform';
import { createTestCa } from '../pki/test-ca';

/** A platform context for unit tests of fakes: a real CA and random, no engines. Close what `use` collected. */
export function createTestContext(): PlatformCheckContext & { closeAll(): Promise<void> } {
    const fixtures: Closable[] = [];
    return {
        random: createSeededRandom(7),
        runId: 'test',
        signal: new AbortController().signal,
        resources: { defer: () => undefined },
        ca: createTestCa('unit test CA', { permittedDomains: ['localhost'] }),
        engineDomain: HARNESS_ENGINE_DOMAIN,
        expectations: {
            heartbeatIntervalMs: 1000,
            intervalOverridden: false,
            startTimeoutMs: 1000,
            quietWindowMs: 500,
        },
        productionBuild: false,
        tempDir: () => Promise.reject(new Error('no temp dirs in unit tests')),
        engine: () => Promise.reject(new Error('no engines in unit tests')),
        use(fixture) {
            fixtures.push(fixture);
            return fixture;
        },
        suiteFixture: () => Promise.reject(new Error('no suite fixtures in unit tests')),
        engineTarget: () => null,
        engineCertificateAuthority: () => Promise.resolve(null),
        async closeAll() {
            for (const fixture of fixtures.reverse()) await fixture.close();
        },
    };
}

export interface PostResult {
    readonly status: number;
    readonly contentType: string | undefined;
    readonly body: string;
}

/** A POST that trusts `ca`, as an engine started by the harness would through NODE_EXTRA_CA_CERTS. */
export function post(url: string, body: string | Uint8Array, ca: string, headers: Record<string, string> = {}) {
    return new Promise<PostResult>((resolve, reject) => {
        const outgoing = request(url, { method: 'POST', ca, headers }, (incoming) => {
            const chunks: Buffer[] = [];
            incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
            incoming.on('end', () => {
                resolve({
                    status: incoming.statusCode ?? 0,
                    contentType: incoming.headers['content-type'],
                    body: Buffer.concat(chunks).toString('utf8'),
                });
            });
        });
        outgoing.on('error', reject);
        outgoing.end(body);
    });
}
