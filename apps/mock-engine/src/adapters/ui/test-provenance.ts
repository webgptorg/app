import type { ExpectedWorkflowClaims, ProvenanceVerifier } from '@ptbk/protocol';
import { createFakeProvenanceVerifier, decodeBase64Std, encodeBase64Std } from '@ptbk/protocol';
import { z } from 'zod';

/** Marks a test attestation, so it can never be mistaken for (or parsed as) a Sigstore bundle. */
export const TEST_PROVENANCE_MEDIA_TYPE = 'application/vnd.ptbk.test-provenance+json; v=1';
const MAX_TIMESTAMPS = 4;

const TestProvenance = z.strictObject({
    mediaType: z.literal(TEST_PROVENANCE_MEDIA_TYPE),
    payloadType: z.string().max(256),
    /** Standard base64 of the exact payload bytes, as in DSSE. */
    payload: z.string().max(128 * 1024),
    certificate: z.strictObject({
        issuer: z.string().max(256),
        subjectAlternativeName: z.string().max(1024),
        extensions: z.record(z.string().regex(/^[0-9.]{1,64}$/), z.string().max(256)),
    }),
    logIndex: z.int().min(0).nullable(),
    timestamps: z.array(z.iso.datetime({ offset: false })).max(MAX_TIMESTAMPS),
});
export type TestProvenance = z.infer<typeof TestProvenance>;

export interface TestProvenanceInput {
    readonly payloadType: string;
    readonly payload: Uint8Array;
    readonly certificate: Pick<ExpectedWorkflowClaims, 'issuer' | 'subjectAlternativeName' | 'extensions'>;
    readonly logIndex: number | null;
    readonly timestamps: readonly Date[];
}

/** The `provenance` text of a release signed for tests: what Sigstore would have attested, stated in the clear. */
export function testProvenanceBundle(input: TestProvenanceInput): string {
    const document: TestProvenance = {
        mediaType: TEST_PROVENANCE_MEDIA_TYPE,
        payloadType: input.payloadType,
        payload: encodeBase64Std(input.payload),
        certificate: {
            issuer: input.certificate.issuer,
            subjectAlternativeName: input.certificate.subjectAlternativeName,
            extensions: { ...input.certificate.extensions },
        },
        logIndex: input.logIndex,
        timestamps: input.timestamps.map((time) => time.toISOString()),
    };
    return JSON.stringify(TestProvenance.parse(document));
}

/**
 * `MOCK_UI_FAKE_PROVENANCE=enabled` (tests and the e2e stack only; refused under `NODE_ENV=production`): C-06's
 * `createFakeProvenanceVerifier` over the attestation the bundle text states, so the exact matching of payload,
 * payload type and certificate claims against `expectedWorkflowClaims` is C-06's own. Unlike Sigstore, nothing here
 * proves who made the attestation; the release key's signature is still required as always.
 */
export function createTestProvenanceVerifier(): ProvenanceVerifier {
    return {
        verifyProvenance(bundle, envelope, expected, signal) {
            let document: TestProvenance;
            try {
                document = TestProvenance.parse(JSON.parse(bundle));
            } catch {
                return Promise.resolve({ kind: 'invalid', reason: 'malformed-bundle' });
            }
            const payload = decodeBase64Std(document.payload);
            if (payload.kind === 'invalid') return Promise.resolve({ kind: 'invalid', reason: 'malformed-bundle' });
            const verifier = createFakeProvenanceVerifier([
                {
                    bundle,
                    payloadType: document.payloadType,
                    payload: payload.bytes,
                    certificate: {
                        issuer: document.certificate.issuer,
                        subjectAlternativeName: document.certificate.subjectAlternativeName,
                        extensions: new Map(Object.entries(document.certificate.extensions)),
                    },
                    logIndex: document.logIndex,
                    timestamps: document.timestamps.map((time) => new Date(time)),
                },
            ]);
            return verifier.verifyProvenance(bundle, envelope, expected, signal);
        },
    };
}
