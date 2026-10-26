import { describe, expect, it } from 'vitest';

import { runConformance } from '../../runner';
import type { ConformanceTarget } from '../../target';
import type { UiLoaderDefect } from '../../testing/ui-loader/fake-ui-lab';
import { UI_LOADER_DEFECTS, createFakeUiLab } from '../../testing/ui-loader/fake-ui-lab';
import { UI_LOADER_SUITE, createUiLoaderSuite } from './index';

// The ui-loader checks reach the engine through their lab, never through the run's target.
const UNUSED_TARGET: ConformanceTarget = {
    baseUrl: new URL('https://unused.test/'),
    fetch: () => Promise.reject(new Error('not used')),
    session: () => Promise.resolve(null),
};

async function run(defect: UiLoaderDefect | undefined, only?: readonly string[]) {
    const lab = createFakeUiLab(defect);
    return runConformance({
        target: UNUSED_TARGET,
        suites: [createUiLoaderSuite(lab)],
        timeoutMs: 60_000,
        signal: new AbortController().signal,
        ...(only === undefined ? {} : { filter: (check) => only.includes(check.id) }),
    });
}

/** The check that must catch each defect: every check is shown to fail for at least one of them. */
const CAUGHT_BY: Record<UiLoaderDefect, readonly string[]> = {
    'skip-provenance': ['ui-loader.signature.threshold'],
    'release-key-optional': ['ui-loader.signature.threshold'],
    'ignore-maintainer-threshold': ['ui-loader.signature.threshold'],
    'lenient-ed25519': ['ui-loader.signature.strict-ed25519'],
    'cofactorless-ed25519': ['ui-loader.signature.strict-ed25519'],
    'raw-payload-signature': ['ui-loader.dsse.pae-only'],
    'lenient-payload': ['ui-loader.entry.strict-payload'],
    'contains-san': ['ui-loader.provenance.exact-identity'],
    'lenient-extensions': ['ui-loader.provenance.exact-identity'],
    'log-optional': ['ui-loader.provenance.log-required'],
    'delay-from-published-at': ['ui-loader.delay.trusted-time'],
    'first-seen-in-memory': ['ui-loader.delay.first-seen-persisted'],
    'unchecked-archive-hash': ['ui-loader.artifact.hash-mismatch'],
    'unchecked-manifest-files': ['ui-loader.manifest.files-enforced'],
    'lenient-unpacker': ['ui-loader.archive.unsafe-entries'],
    'ignore-engine-api-range': ['ui-loader.manifest.engine-api-range'],
    'allow-downgrade': ['ui-loader.rollback.not-newer'],
    'install-without-revocations': [
        'ui-loader.revocations.expired-keeps-current',
        'ui-loader.revocations.unverifiable',
    ],
    'revocation-state-in-memory': ['ui-loader.revocations.rollback-persisted'],
    'ignore-revocations': ['ui-loader.revocations.revoked-refused'],
    'keep-revoked-current': ['ui-loader.revocations.revoked-current'],
    'clear-on-failure': ['ui-loader.store.unavailable-keeps-current'],
    'ignore-pinned': ['ui-loader.policy.honoured'],
    'manual-installs': ['ui-loader.policy.honoured'],
    'serve-unlisted': ['ui-loader.serve.listed-files-only'],
    'fallback-shadows-reserved': ['ui-loader.serve.listed-files-only'],
    'manifest-csp': ['ui-loader.serve.security-headers'],
    'no-eligible-at': ['ui-loader.delay.trusted-time', 'ui-loader.delay.first-seen-persisted'],
    'mislabel-refusals': [
        'ui-loader.signature.strict-ed25519',
        'ui-loader.rollback.not-newer',
        'ui-loader.revocations.revoked-current',
    ],
    'panel-wrong-bundle': ['ui-loader.install.pinned-valid'],
    'never-installs': ['ui-loader.install.pinned-valid', 'ui-loader.serve.listed-files-only'],
    'serve-wrong-bytes': ['ui-loader.serve.listed-files-only'],
    // Refusing a malformed key in the trust policy at startup is allowed: the check still passes.
    'reject-malformed-keys': [],
};

describe('the ui-loader suite', () => {
    it('passes every check against a correct loader', async () => {
        const report = await run(undefined);
        const failed = report.results.filter((result) => result.outcome.kind !== 'pass');
        expect(failed.map((result) => [result.id, result.outcome])).toEqual([]);
        expect(report.results).toHaveLength(createUiLoaderSuite(null).checks.length);
    });

    it.each(UI_LOADER_SUITE.checks.map((check) => check.id))('passes %s run on its own', async (id) => {
        const report = await run(undefined, [id]);
        expect(report.results.map((result) => [result.id, result.outcome])).toEqual([[id, { kind: 'pass' }]]);
    });

    it('passes strict-ed25519 for an engine that refuses a malformed key in its policy at startup', async () => {
        const report = await run('reject-malformed-keys', ['ui-loader.signature.strict-ed25519']);
        expect(report.results.map((result) => result.outcome)).toEqual([{ kind: 'pass' }]);
    });

    it.each(UI_LOADER_DEFECTS.filter((defect) => CAUGHT_BY[defect].length > 0))(
        'fails the matching checks for a loader with the defect %s',
        async (defect) => {
            const report = await run(defect, CAUGHT_BY[defect]);
            expect(report.results.map((result) => [result.id, result.outcome.kind])).toEqual(
                CAUGHT_BY[defect].map((id) => [id, 'fail']),
            );
        },
    );

    it('has every check caught by some defect', () => {
        const caught = new Set(Object.values(CAUGHT_BY).flat());
        const uncaught = UI_LOADER_SUITE.checks.map((check) => check.id).filter((id) => !caught.has(id));
        expect(uncaught).toEqual([]);
    });

    it('skips every check without a lab', async () => {
        const report = await runConformance({
            target: UNUSED_TARGET,
            suites: [UI_LOADER_SUITE],
            timeoutMs: 1_000,
            signal: new AbortController().signal,
        });
        expect(new Set(report.results.map((result) => JSON.stringify(result.outcome)))).toEqual(
            new Set([JSON.stringify({ kind: 'skip', reason: 'needs-engine-harness' })]),
        );
    });
});
