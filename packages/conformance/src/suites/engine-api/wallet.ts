import { ENGINE_API_ROUTE_LIST, ENGINE_API_ROUTES, KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { RouteDefinition } from '@ptbk/engine-api';
import { encodeBase64Std, encodeBase64Url, utf8Encode } from '@ptbk/protocol';

import type { ConformanceCheck } from '../../check';
import { Findings, fail, skip } from '../../check';
import { randomToken } from '../../random';
import { describe } from './api';
import { requireCapability } from './capability-support';
import { EVENT_WINDOW_MS, readRoute } from './schemas';
import { SUITE, attempt } from './support';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;
const CANARY_LENGTH = 32;

/**
 * Every way a value commonly reappears: as is, as hex, and as standard or URL-safe base64 at each of the three byte
 * alignments it can have inside a longer encoded blob (only the characters no neighbouring byte can change).
 */
export function canaryForms(canary: string): readonly { readonly form: string; readonly text: string }[] {
    const bytes = utf8Encode(canary);
    const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    const forms = [
        { form: 'raw', text: canary },
        { form: 'hex', text: hex },
        { form: 'hex', text: hex.toUpperCase() },
    ];
    for (let offset = 0; offset < 3; offset++) {
        const shifted = new Uint8Array(offset + bytes.length);
        shifted.set(bytes, offset);
        for (const [form, encoded] of [
            ['base64', encodeBase64Std(shifted)],
            ['base64url', encodeBase64Url(shifted)],
        ] as const) {
            forms.push({ form, text: encoded.slice(4, encoded.replace(/=+$/, '').length - 4) });
        }
    }
    return forms;
}

const decoder = new TextDecoder();

const NOT_READY = 'the Wallet is not ready on this engine, or saving a login wants a step-up the suite cannot give';
const NO_REQUEST_LEVER = 'the target cannot raise a Wallet request (ConformanceTarget.walletRequest)';

export const WALLET_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.secrets.never-returned',
        suite: SUITE,
        title: 'A Wallet password or field value never comes back: not from any GET route, not on the event stream, in no encoding',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.wallet);
            const seen: { readonly route: RouteDefinition; readonly bytes: Uint8Array }[] = [];
            world.owner.observe((route, bytes) => seen.push({ route, bytes }));
            const findings = new Findings();
            const canaries = Array.from({ length: 3 }, () => randomToken(ctx.random, CANARY_LENGTH));
            const [password = '', fieldValue = '', newPassword = ''] = canaries;

            const events = world.owner.stream(R.streamEvents, {}, { maxMs: EVENT_WINDOW_MS * 3 });
            const login = await world.createWalletLogin('canary', password, fieldValue);
            if (login === null) skip(NOT_READY);
            await world.owner.ok(R.updateWalletRecord, {
                params: { recordId: login.id },
                body: { origin: login.origin, username: login.username ?? 'canary', password: newPassword },
            });
            for (const route of ENGINE_API_ROUTE_LIST) {
                if (route.method !== 'GET' || !(await world.advertises(route))) continue;
                await attempt(findings, () => readRoute(world, world.owner, route, findings));
            }
            await attempt(findings, async () => {
                await events;
            });

            const forms = canaries.flatMap((canary) => canaryForms(canary));
            for (const { route, bytes } of seen) {
                const text = decoder.decode(bytes);
                const found = forms.find(({ text: form }) => text.includes(form));
                if (found) findings.add(`${describe(route)}: a Wallet secret came back (${found.form})`);
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.wallet.lifecycle',
        suite: SUITE,
        title: 'Adding, updating and removing a Wallet login change only that login, and new values stay unverified',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.wallet);
            const { owner } = world;
            const findings = new Findings();
            const created = await world.createWalletLogin('lifecycle', randomToken(ctx.random, CANARY_LENGTH));
            if (created === null) skip(NOT_READY);
            const params = { recordId: created.id };
            const username = created.username ?? world.name('lifecycle');
            if (created.verification !== null) findings.add('POST /wallet/records: a new login is not unverified');
            const listed = async () => (await owner.ok(R.getWallet)).records.filter(({ id }) => id === created.id);
            if ((await listed()).length !== 1) findings.add('GET /wallet: a saved login is not listed once');

            await attempt(findings, async () => {
                const again = await owner.ok(R.addWalletRecord, {
                    body: { origin: created.origin, username, password: randomToken(ctx.random, CANARY_LENGTH) },
                });
                if (again.record.id !== created.id) {
                    fail('POST /wallet/records: the same origin and username made a second login');
                }
            });
            await attempt(findings, async () => {
                const label = world.name('renamed');
                const { record } = await owner.ok(R.updateWalletRecord, {
                    params,
                    body: { origin: created.origin, username, password: randomToken(ctx.random, CANARY_LENGTH), label },
                });
                if (record.id !== created.id || record.label !== label) {
                    fail('PUT /wallet/records/{recordId}: the label did not change, or the login changed identity');
                }
                if (record.verification !== null)
                    fail('PUT /wallet/records/{recordId}: a new password is not unverified');
            });

            await owner.ok(R.deleteWalletRecord, { params });
            if ((await listed()).length !== 0) findings.add('GET /wallet: a removed login is still listed');
            await attempt(findings, async () => {
                await owner.problem(R.deleteWalletRecord, { params }, 'not-found');
            });
            await attempt(findings, async () => {
                await owner.problem(
                    R.updateWalletRecord,
                    { params, body: { origin: created.origin, username, password: 'x' } },
                    'not-found',
                );
            });
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.wallet.requests',
        suite: SUITE,
        title: 'Mark as seen keeps a request waiting, Reject request ends it, a stale step changes nothing and a save resolves it',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.wallet);
            const raise = ctx.target.walletRequest;
            if (raise === undefined) skip(NO_REQUEST_LEVER);
            const { owner } = world;
            const findings = new Findings();
            const origin = (label: string) => `https://${label}.${ctx.runId}.conformance.invalid`;
            const pending = async (id: string) => (await owner.ok(R.getWallet)).pending.find((item) => item.id === id);

            const firstId = await raise(origin('seen'));
            const first = await pending(firstId);
            if (first === undefined) fail('GET /wallet: a raised request is not pending');
            if (first.seenAt !== null) findings.add('GET /wallet: a new request is already seen');
            const params = { requestId: first.id };
            await attempt(findings, async () => {
                await owner.problem(
                    R.markWalletRequestSeen,
                    { params, body: { step: first.step + 1 } },
                    'wallet-request-moved',
                );
                await owner.problem(
                    R.rejectWalletRequest,
                    { params, body: { step: first.step + 1 } },
                    'wallet-request-moved',
                );
            });
            const seen = await owner.ok(R.markWalletRequestSeen, { params, body: { step: first.step } });
            if (seen.seenAt === null) findings.add('POST /wallet/requests/{requestId}/seen: seenAt is not set');
            if ((await pending(first.id))?.seenAt == null) {
                findings.add('GET /wallet: a request marked as seen no longer waits, or lost its seenAt');
            }
            await attempt(findings, async () => {
                const again = await owner.ok(R.markWalletRequestSeen, { params, body: { step: first.step } });
                if (again.seenAt !== seen.seenAt) fail('POST /wallet/requests/{requestId}/seen: not idempotent');
            });
            await owner.ok(R.rejectWalletRequest, { params, body: { step: first.step } });
            if ((await pending(first.id)) !== undefined)
                findings.add('GET /wallet: a rejected request is still pending');
            await attempt(findings, async () => {
                await owner.problem(R.rejectWalletRequest, { params, body: { step: first.step } }, 'not-found');
            });

            await attempt(findings, async () => {
                const secondId = await raise(origin('save'));
                const login = await owner.call(R.addWalletRecord, {
                    body: {
                        origin: origin('save'),
                        username: world.name('requested'),
                        password: randomToken(ctx.random, CANARY_LENGTH),
                        requestId: secondId,
                    },
                });
                if (login.kind === 'problem' && ['wallet-not-ready', 'step-up-required'].includes(login.problem.code)) {
                    return;
                }
                if (login.kind === 'problem') fail(`POST /wallet/records: answered ${login.problem.code}`);
                ctx.resources.defer((signal) =>
                    owner.withSignal(signal).send(R.deleteWalletRecord, { params: { recordId: login.data.record.id } }),
                );
                if (
                    !login.data.resolvedRequestIds.some((id) => id === secondId) ||
                    (await pending(secondId)) !== undefined
                ) {
                    fail('POST /wallet/records: saving the requested login did not resolve the request');
                }
            });
            return findings.outcome();
        },
    },
];
