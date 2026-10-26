import { FULCIO_OID } from '@ptbk/protocol';

import type { ProvenanceSpec } from '../releases';
import { CONFORMANCE_WORKFLOW_IDENTITY } from '../releases';
import type { RefusalCase, UiLoaderCheck } from './common';
import { refusals } from './common';

function provenanceCase(label: string, provenance: ProvenanceSpec, reasons: RefusalCase['reasons']): RefusalCase {
    return { label, reasons, publish: { release: { provenance } } };
}

const identity = CONFORMANCE_WORKFLOW_IDENTITY;
const INVALID = ['signature-threshold-not-met'] as const;

const extension = (oid: string, value: string): ProvenanceSpec => ({
    editClaims: (claims) => ({ ...claims, extensions: { ...claims.extensions, [oid]: value } }),
});

export const exactIdentity: UiLoaderCheck = {
    id: 'ui-loader.provenance.exact-identity',
    title: 'Provenance from the wrong repository, repository ID, workflow, tag, commit, runner, trigger or issuer is refused',
    run: (bench, ctx) =>
        refusals(bench, ctx, [
            provenanceCase(
                'another repository',
                { identity: { ...identity, repository: `${identity.repository}-fork` } },
                INVALID,
            ),
            provenanceCase('another repository ID', { identity: { ...identity, repositoryId: '424243' } }, INVALID),
            provenanceCase(
                'another workflow',
                { identity: { ...identity, workflowPath: '.github/workflows/ui-release-dry.yml' } },
                INVALID,
            ),
            provenanceCase('another tag', { gitTag: 'ui-v9.9.9' }, INVALID),
            provenanceCase('another commit', { commit: 'f'.repeat(40) }, INVALID),
            provenanceCase(
                'a branch instead of the tag',
                {
                    editClaims: (claims) => ({
                        ...claims,
                        subjectAlternativeName: claims.subjectAlternativeName.replace(
                            /@refs\/tags\/.*$/,
                            '@refs/heads/main',
                        ),
                        extensions: { ...claims.extensions, [FULCIO_OID.sourceRepositoryRef]: 'refs/heads/main' },
                    }),
                },
                INVALID,
            ),
            provenanceCase('a self-hosted runner', extension(FULCIO_OID.runnerEnvironment, 'self-hosted'), INVALID),
            provenanceCase('a workflow_dispatch run', extension(FULCIO_OID.buildTrigger, 'workflow_dispatch'), INVALID),
            provenanceCase(
                'another issuer',
                {
                    editClaims: (claims) => ({
                        ...claims,
                        issuer: 'https://token.actions.githubusercontent.com.invalid',
                    }),
                },
                INVALID,
            ),
            provenanceCase(
                'a SAN with an extra prefix',
                {
                    editClaims: (claims) => ({
                        ...claims,
                        subjectAlternativeName: `x${claims.subjectAlternativeName}`,
                    }),
                },
                INVALID,
            ),
            provenanceCase(
                'a SAN with an extra suffix',
                {
                    editClaims: (claims) => ({
                        ...claims,
                        subjectAlternativeName: `${claims.subjectAlternativeName}x`,
                    }),
                },
                INVALID,
            ),
            provenanceCase(
                'extensions that are not DER UTF8Strings',
                { options: { extensionEncoding: 'raw-octets' } },
                INVALID,
            ),
        ]),
};

export const logRequired: UiLoaderCheck = {
    id: 'ui-loader.provenance.log-required',
    title: 'Provenance without a transparency log entry, without an SCT or from a CA outside the trusted root is refused',
    run: (bench, ctx) =>
        refusals(bench, ctx, [
            provenanceCase('no log entry and no timestamp', { options: { omitTlogEntry: true } }, [
                'signature-threshold-not-met',
                'not-in-log',
            ]),
            provenanceCase(
                'no log entry, a TSA timestamp only',
                { options: { omitTlogEntry: true }, tsaTimes: [new Date()] },
                ['signature-threshold-not-met', 'not-in-log'],
            ),
            provenanceCase('no SCT', { options: { omitSct: true } }, INVALID),
            provenanceCase('a CA outside the trusted root', { options: { untrustedCa: true } }, INVALID),
        ]),
};
