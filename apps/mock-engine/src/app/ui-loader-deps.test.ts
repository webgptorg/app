import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PINNED_TRUSTED_ROOT_FILE } from '@ptbk/release-tools';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createMemoryLogger } from '../testing/memory-logger';
import type { TestReleaseKeys } from '../testing/ui-releases';
import { createTestReleaseKeys } from '../testing/ui-releases';
import type { UiLoaderConfig, UiTrustConfig } from './config';
import {
    UiLoaderSetupError,
    createUiLoaderDeps,
    provenanceVerifier,
    readConformanceTrust,
    readTrustPolicy,
} from './ui-loader-deps';

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

type FileTrust = Extract<UiTrustConfig, { kind: 'files' }>;

function fileTrust(overrides: Partial<FileTrust> = {}): FileTrust {
    return {
        kind: 'files',
        trustPolicyFile: join(dir, 'policy.json'),
        trustedRootFile: null,
        fakeProvenance: false,
        stagingPolicyAllowed: true,
        ...overrides,
    };
}

function config(trust: UiTrustConfig = fileTrust()): UiLoaderConfig {
    return { releaseUrl: 'https://releases.ptbk.test/', updatePolicy: { kind: 'auto' }, trust, checkIntervalS: 3600 };
}

async function pinnedRoot(): Promise<Record<string, unknown>> {
    return JSON.parse(await readFile(PINNED_TRUSTED_ROOT_FILE, 'utf8')) as Record<string, unknown>;
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
    const anywhere = { stagingAllowed: true };
    const staging = () => ({
        ...keys.policy,
        profile: 'staging',
        delays: { regularMs: 300_000, securityMs: 300_000 },
    });

    it('reads a C-06 TrustPolicy', async () => {
        await writeFile(join(dir, 'policy.json'), JSON.stringify(keys.policy));
        expect(await readTrustPolicy(join(dir, 'policy.json'), anywhere)).toEqual(keys.policy);
        expect(await readTrustPolicy(join(dir, 'policy.json'), { stagingAllowed: false })).toEqual(keys.policy);
    });

    it('refuses a missing, oversized or invalid policy, naming the setting but not the content', async () => {
        await expect(readTrustPolicy(join(dir, 'none.json'), anywhere)).rejects.toThrow(
            /PTBK_UI_TRUST_POLICY_FILE: cannot read/,
        );
        await writeFile(join(dir, 'big.json'), ' '.repeat(65 * 1024));
        await expect(readTrustPolicy(join(dir, 'big.json'), anywhere)).rejects.toThrow(/too large/);
        await writeFile(join(dir, 'bad.json'), JSON.stringify({ ...keys.policy, maintainerKeys: [] }));
        await expect(readTrustPolicy(join(dir, 'bad.json'), anywhere)).rejects.toThrow(UiLoaderSetupError);
    });

    it('reads a staging policy outside production', async () => {
        await writeFile(join(dir, 'staging.json'), JSON.stringify(staging()));
        expect(await readTrustPolicy(join(dir, 'staging.json'), anywhere)).toEqual(staging());
    });

    it('refuses a staging policy in production', async () => {
        await writeFile(join(dir, 'staging.json'), JSON.stringify(staging()));
        await expect(readTrustPolicy(join(dir, 'staging.json'), { stagingAllowed: false })).rejects.toThrow(
            /^PTBK_UI_TRUST_POLICY_FILE: .*staging\.json is a staging trust policy, which must not be used in production$/,
        );
        await expect(
            createUiLoaderDeps({
                config: config(fileTrust({ trustPolicyFile: join(dir, 'staging.json'), stagingPolicyAllowed: false })),
                dataDir: dir,
                fetch: () => Promise.reject(new TypeError('offline')),
                logger: createMemoryLogger(),
            }),
        ).rejects.toThrow(UiLoaderSetupError);
    });
});

describe('provenanceVerifier', () => {
    it('uses test attestations only when fake provenance is enabled', async () => {
        const fake = await provenanceVerifier(fileTrust({ fakeProvenance: true }));
        expect(await fake.verifyProvenance('{}', anything, claims, signal())).toEqual({
            kind: 'invalid',
            reason: 'malformed-bundle',
        });
    });

    it('uses Sigstore with the pinned root, or with a trusted root file that checks out', async () => {
        for (const verifier of [
            await provenanceVerifier(fileTrust()),
            await provenanceVerifier(fileTrust({ trustedRootFile: PINNED_TRUSTED_ROOT_FILE })),
        ]) {
            const test = JSON.stringify({ mediaType: 'application/vnd.ptbk.test-provenance+json; v=1' });
            expect(await verifier.verifyProvenance(test, anything, claims, signal())).toEqual({
                kind: 'invalid',
                reason: 'malformed-bundle',
            });
        }
    });

    it('refuses a trusted root file that is not a usable root', async () => {
        await writeFile(join(dir, 'root.json'), JSON.stringify({ ...(await pinnedRoot()), timestampAuthorities: [] }));
        await expect(provenanceVerifier(fileTrust({ trustedRootFile: join(dir, 'root.json') }))).rejects.toThrow(
            /MOCK_UI_TRUSTED_ROOT_FILE: .* no timestampAuthorities/,
        );
    });
});

describe('readConformanceTrust', () => {
    const path = () => join(dir, 'conformance.json');
    const write = async (file: unknown) => writeFile(path(), JSON.stringify(file));
    const valid = async () => ({ v: 1, trustPolicy: keys.policy, trustedRoot: await pinnedRoot() });

    it('takes the trust policy, and Sigstore under the trusted root', async () => {
        await write(await valid());
        const { trust, provenance } = await readConformanceTrust(path());
        expect(trust).toEqual(keys.policy);
        const test = JSON.stringify({ mediaType: 'application/vnd.ptbk.test-provenance+json; v=1' });
        expect(await provenance.verifyProvenance(test, anything, claims, signal())).toEqual({
            kind: 'invalid',
            reason: 'malformed-bundle',
        });
    });

    it('refuses a missing, oversized or malformed file, naming the setting and path but never the contents', async () => {
        const refused = async (pattern: RegExp) => {
            const error: unknown = await readConformanceTrust(path()).catch((thrown: unknown) => thrown);
            expect(error).toBeInstanceOf(UiLoaderSetupError);
            expect((error as Error).message).toMatch(pattern);
            expect((error as Error).message).not.toContain('canary');
        };
        await refused(/^PTBK_CONFORMANCE_TRUST_FILE: cannot read \//);
        await writeFile(path(), ' '.repeat(1100 * 1024));
        await refused(/too large/);
        await writeFile(path(), '{"v":1, canary-not-json');
        await refused(/is not a valid conformance trust file$/);
        await write({ ...(await valid()), canary: 'canary-unknown-field' });
        await refused(/is not a valid conformance trust file$/);
        await write({ ...(await valid()), v: 2 });
        await refused(/is not a valid conformance trust file$/);
        await write({ ...(await valid()), trustPolicy: { ...keys.policy, maintainerKeys: [] } });
        await refused(/is not a valid conformance trust file$/);
        const staging = { ...keys.policy, profile: 'staging', delays: { regularMs: 300_000, securityMs: 300_000 } };
        await write({ ...(await valid()), trustPolicy: staging });
        await refused(/is not a valid conformance trust file$/);
        await write({ ...(await valid()), trustedRoot: { ...(await pinnedRoot()), timestampAuthorities: [] } });
        await refused(/trustedRoot: no timestampAuthorities$/);
        await write({ ...(await valid()), trustedRoot: { mediaType: 'canary-media-type' } });
        await refused(/trustedRoot: unexpected media type$/);
    });
});

describe('createUiLoaderDeps', () => {
    it('takes its trust from the conformance trust file, and warns that it does', async () => {
        await writeFile(
            join(dir, 'conformance.json'),
            JSON.stringify({ v: 1, trustPolicy: keys.policy, trustedRoot: await pinnedRoot() }),
        );
        const logger = createMemoryLogger();
        const deps = await createUiLoaderDeps({
            config: config({ kind: 'conformance', file: join(dir, 'conformance.json') }),
            dataDir: dir,
            fetch: () => Promise.reject(new TypeError('offline')),
            logger,
        });
        expect(deps.trust).toEqual(keys.policy);
        expect(logger.entries).toEqual([{ level: 'warn', event: 'ui.conformance-trust', fields: { enabled: true } }]);
    });

    it('opens the file stores under the data directory and warns about fake provenance', async () => {
        await writeFile(join(dir, 'policy.json'), JSON.stringify(keys.policy));
        const logger = createMemoryLogger();
        const deps = await createUiLoaderDeps({
            config: config(fileTrust({ fakeProvenance: true })),
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
