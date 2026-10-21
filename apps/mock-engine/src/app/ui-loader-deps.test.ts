import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PINNED_TRUSTED_ROOT_FILE } from '@ptbk/release-tools';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createMemoryLogger } from '../testing/memory-logger';
import type { TestReleaseKeys } from '../testing/ui-releases';
import { createTestReleaseKeys } from '../testing/ui-releases';
import type { UiLoaderConfig } from './config';
import { UiLoaderSetupError, createUiLoaderDeps, provenanceVerifier, readTrustPolicy } from './ui-loader-deps';

let keys: TestReleaseKeys;
beforeAll(async () => {
    keys = await createTestReleaseKeys();
});

let dir: string;
beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ptbk-ui-deps-'));
    await chmod(dir, 0o700);
});
afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
});

function config(overrides: Partial<UiLoaderConfig> = {}): UiLoaderConfig {
    return {
        releaseUrl: 'https://releases.ptbk.test/',
        updatePolicy: { kind: 'auto' },
        trustPolicyFile: join(dir, 'policy.json'),
        trustedRootFile: null,
        checkIntervalS: 3600,
        fakeProvenance: false,
        ...overrides,
    };
}

const signal = () => new AbortController().signal;
const anything = { payloadType: 'x', payload: new Uint8Array() };
const claims = {
    issuer: 'x',
    subjectAlternativeName: 'x',
    subjectAlternativeNamePattern: 'x',
    extensions: {},
} as never;

describe('readTrustPolicy', () => {
    it('reads a C-06 TrustPolicy', async () => {
        await writeFile(join(dir, 'policy.json'), JSON.stringify(keys.policy));
        expect(await readTrustPolicy(join(dir, 'policy.json'))).toEqual(keys.policy);
    });

    it('refuses a missing, oversized or invalid policy, naming the setting but not the content', async () => {
        await expect(readTrustPolicy(join(dir, 'none.json'))).rejects.toThrow(/MOCK_UI_TRUST_POLICY_FILE: cannot read/);
        await writeFile(join(dir, 'big.json'), ' '.repeat(65 * 1024));
        await expect(readTrustPolicy(join(dir, 'big.json'))).rejects.toThrow(/too large/);
        await writeFile(join(dir, 'bad.json'), JSON.stringify({ ...keys.policy, maintainerKeys: [] }));
        await expect(readTrustPolicy(join(dir, 'bad.json'))).rejects.toThrow(UiLoaderSetupError);
    });
});

describe('provenanceVerifier', () => {
    it('uses test attestations only when fake provenance is enabled', async () => {
        const fake = await provenanceVerifier(config({ fakeProvenance: true }));
        expect(await fake.verifyProvenance('{}', anything, claims, signal())).toEqual({
            kind: 'invalid',
            reason: 'malformed-bundle',
        });
    });

    it('uses Sigstore with the pinned root, or with a trusted root file that checks out', async () => {
        for (const verifier of [
            await provenanceVerifier(config()),
            await provenanceVerifier(config({ trustedRootFile: PINNED_TRUSTED_ROOT_FILE })),
        ]) {
            const test = JSON.stringify({ mediaType: 'application/vnd.ptbk.test-provenance+json; v=1' });
            expect(await verifier.verifyProvenance(test, anything, claims, signal())).toEqual({
                kind: 'invalid',
                reason: 'malformed-bundle',
            });
        }
    });

    it('refuses a trusted root file that is not a usable root', async () => {
        const root = JSON.parse(await readFile(PINNED_TRUSTED_ROOT_FILE, 'utf8')) as Record<string, unknown>;
        await writeFile(join(dir, 'root.json'), JSON.stringify({ ...root, timestampAuthorities: [] }));
        await expect(provenanceVerifier(config({ trustedRootFile: join(dir, 'root.json') }))).rejects.toThrow(
            /MOCK_UI_TRUSTED_ROOT_FILE: .* no timestampAuthorities/,
        );
    });
});

describe('createUiLoaderDeps', () => {
    it('opens the file stores under the data directory and warns about fake provenance', async () => {
        await writeFile(join(dir, 'policy.json'), JSON.stringify(keys.policy));
        const logger = createMemoryLogger();
        const deps = await createUiLoaderDeps({
            config: config({ fakeProvenance: true }),
            dataDir: dir,
            fetch: () => Promise.reject(new TypeError('offline')),
            logger,
        });
        expect(deps.trust).toEqual(keys.policy);
        expect(deps.store.active()).toBeUndefined();
        expect(await deps.state.lastAcceptedRevocationIssuedAt()).toBeNull();
        await expect(deps.source.latest(signal())).rejects.toThrow('offline');
        expect(logger.entries).toContainEqual({
            level: 'warn',
            event: 'ui.fake-provenance',
            fields: { enabled: true },
        });
    });
});
