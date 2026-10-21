import type { ExpectedWorkflowClaims } from '@ptbk/protocol';
import { FULCIO_OID, RELEASE_PAYLOAD_TYPE, expectedWorkflowClaims } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { TEST_WORKFLOW_IDENTITY } from '../../testing/ui-releases';
import { TEST_PROVENANCE_MEDIA_TYPE, createTestProvenanceVerifier, testProvenanceBundle } from './test-provenance';

const payload = new TextEncoder().encode('{"v":1}');
const expected = expectedWorkflowClaims(TEST_WORKFLOW_IDENTITY, { gitTag: 'ui-v1.0.0', commit: 'c'.repeat(40) });
const envelope = { payloadType: RELEASE_PAYLOAD_TYPE, payload };
const verifier = createTestProvenanceVerifier();
const signal = () => new AbortController().signal;

function bundle(overrides: Partial<Parameters<typeof testProvenanceBundle>[0]> = {}): string {
    return testProvenanceBundle({
        payloadType: RELEASE_PAYLOAD_TYPE,
        payload,
        certificate: expected,
        logIndex: 9,
        timestamps: [new Date('2026-10-01T00:00:00Z'), new Date('2026-10-02T00:00:00Z')],
        ...overrides,
    });
}

describe('createTestProvenanceVerifier', () => {
    it('verifies a matching attestation with the latest timestamp as trusted time', async () => {
        expect(await verifier.verifyProvenance(bundle(), envelope, expected, signal())).toEqual({
            kind: 'verified',
            logIndex: 9,
            trustedTime: new Date('2026-10-02T00:00:00Z'),
        });
    });

    it('applies C-06’s exact matching: another identity, payload or payload type is invalid', async () => {
        const other: ExpectedWorkflowClaims = {
            ...expected,
            subjectAlternativeName: `${expected.subjectAlternativeName}x`,
        };
        expect(await verifier.verifyProvenance(bundle(), envelope, other, signal())).toMatchObject({ kind: 'invalid' });
        const runner = {
            ...expected,
            extensions: { ...expected.extensions, [FULCIO_OID.runnerEnvironment]: 'self-hosted' },
        };
        expect(
            await verifier.verifyProvenance(bundle({ certificate: runner }), envelope, expected, signal()),
        ).toMatchObject({
            kind: 'invalid',
        });
        const changed = { payloadType: RELEASE_PAYLOAD_TYPE, payload: new TextEncoder().encode('{"v":2}') };
        expect(await verifier.verifyProvenance(bundle(), changed, expected, signal())).toEqual({
            kind: 'invalid',
            reason: 'payload-mismatch',
        });
    });

    it('answers not-in-log without a log entry', async () => {
        expect(await verifier.verifyProvenance(bundle({ logIndex: null }), envelope, expected, signal())).toMatchObject(
            {
                kind: 'not-in-log',
            },
        );
    });

    it.each([
        ['not JSON', 'not json'],
        ['a Sigstore bundle', JSON.stringify({ mediaType: 'application/vnd.dev.sigstore.bundle.v0.3+json' })],
        ['an unknown field', JSON.stringify({ ...JSON.parse(bundle()), extra: 1 })],
        ['a payload that is not base64', JSON.stringify({ ...JSON.parse(bundle()), payload: '!!' })],
    ])('refuses %s as malformed', async (_, text) => {
        expect(await verifier.verifyProvenance(text, envelope, expected, signal())).toEqual({
            kind: 'invalid',
            reason: 'malformed-bundle',
        });
    });

    it('marks its documents with their own media type', () => {
        expect(JSON.parse(bundle())).toMatchObject({ mediaType: TEST_PROVENANCE_MEDIA_TYPE });
    });
});
