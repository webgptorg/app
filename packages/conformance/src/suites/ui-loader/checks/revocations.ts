import { REVOCATION_MAX_VALIDITY_MS } from '@ptbk/protocol';

import { Findings } from '../../../check';
import type { Bench } from '../bench';
import { describeCheck } from '../bench';
import { MIRROR_LAYOUT_V1 } from '../store-layout';
import type { RefusalCase, UiLoaderCheck } from './common';
import { expectRefusal, expectStillActive, refusals } from './common';

const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;

const second = (ms: number): Date => new Date(Math.floor(ms / 1000) * 1000);

function unverifiable(
    label: string,
    reason: NonNullable<RefusalCase['revocationReason']>,
    prepare: (bench: Bench) => Promise<void>,
): RefusalCase {
    return {
        label,
        reasons: ['revocations-unverifiable'],
        revocationReason: reason,
        keepRevocations: true,
        prepare: async (bench, version) => {
            await bench.publish(version);
            await prepare(bench);
        },
    };
}

export const expiredKeepsCurrent: UiLoaderCheck = {
    id: 'ui-loader.revocations.expired-keeps-current',
    title: 'An expired revocation list keeps the current version',
    run: (bench, ctx) =>
        refusals(bench, ctx, [
            unverifiable('a list that expired a day ago', 'expired', (lab) =>
                lab.revocations([], {
                    issuedAt: second(Date.now() - 8 * DAY_MS),
                    expiresAt: second(Date.now() - DAY_MS),
                }),
            ),
        ]),
};

export const revocationsUnverifiable: UiLoaderCheck = {
    id: 'ui-loader.revocations.unverifiable',
    title: 'A missing list, an untrusted signer, a list from the future or one valid too long keeps the current version',
    run: (bench, ctx) =>
        refusals(bench, ctx, [
            unverifiable('no list', 'missing', (lab) => {
                lab.lab.store.delete(MIRROR_LAYOUT_V1.revocations);
                return Promise.resolve();
            }),
            unverifiable('a list signed by an untrusted key', 'invalid', (lab) =>
                lab.revocations([], { signer: lab.keys.outsider }),
            ),
            unverifiable('a list issued an hour from now', 'invalid', (lab) =>
                lab.revocations([], {
                    issuedAt: second(Date.now() + HOUR_MS),
                    expiresAt: second(Date.now() + 2 * HOUR_MS),
                }),
            ),
            unverifiable('a list valid for longer than allowed', 'invalid', (lab) => {
                const issuedAt = second(Date.now());
                return lab.revocations([], {
                    issuedAt,
                    expiresAt: new Date(issuedAt.getTime() + REVOCATION_MAX_VALIDITY_MS + DAY_MS),
                });
            }),
        ]),
};

export const rollbackPersisted: UiLoaderCheck = {
    id: 'ui-loader.revocations.rollback-persisted',
    title: 'After a restart, a validly signed revocation list older than the last accepted one is rolled-back',
    async run(bench, ctx) {
        const findings = new Findings();
        // A fresh install accepts a list issued now; every check after this one is a new engine process.
        await bench.install(ctx);
        await expectRefusal(
            bench,
            ctx,
            findings,
            unverifiable('a list issued an hour before the accepted one', 'rolled-back', (lab) =>
                lab.revocations([], { issuedAt: second(Date.now() - HOUR_MS), expiresAt: second(Date.now() + DAY_MS) }),
            ),
        );
        return findings.outcome();
    },
};

export const revokedRefused: UiLoaderCheck = {
    id: 'ui-loader.revocations.revoked-refused',
    title: 'A release whose version is on the revocation list is refused',
    run: (bench, ctx) =>
        refusals(bench, ctx, [
            {
                label: 'the candidate revoked',
                reasons: ['revoked'],
                keepRevocations: true,
                prepare: async (lab, version) => {
                    await lab.publish(version);
                    await lab.revocations([version]);
                },
            },
        ]),
};

export const revokedCurrent: UiLoaderCheck = {
    id: 'ui-loader.revocations.revoked-current',
    title: 'A revoked active bundle stops being served: the previous one returns if not revoked, else the plain page',
    async run(bench, ctx) {
        const findings = new Findings();
        await bench.install(ctx);
        const previous = await bench.install(ctx);
        const active = await bench.install(ctx);
        // The engine keeps one previous bundle: the one installed right before the active one.
        await bench.revocations([active.version]);
        for (const label of ['active version revoked', 'after another restart']) {
            const seen = await bench.pinned(ctx, active.version);
            if (
                seen.check.outcome !== 'refused' ||
                seen.check.reason !== 'revoked' ||
                seen.check.version !== active.version
            ) {
                findings.add(`${label}: expected refused ${active.version} revoked, got ${describeCheck(seen.check)}`);
            }
            await expectStillActive(bench, ctx, findings, label, previous, seen);
        }
        await bench.revocations([previous.version, active.version]);
        const seen = await bench.pinned(ctx, active.version);
        if (seen.check.outcome !== 'refused' || seen.check.reason !== 'revoked') {
            findings.add(`active and previous revoked: expected refused revoked, got ${describeCheck(seen.check)}`);
        }
        const served = await bench.servedVersion(ctx);
        if (served !== null) findings.add(`active and previous revoked: the engine still serves ${served}`);
        bench.active = null;
        bench.installed.length = 0;
        await bench.revocations();
        return findings.outcome();
    },
};
