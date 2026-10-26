import { ENGINE_API_ROUTES, PERMISSIONS, isReadPermission } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings, fail, skip } from '../../check';
import type { EngineApi } from './api';
import { describe } from './api';
import { snapshot } from './probes';
import { validRequest } from './requests';
import { SUITE, attempt, cleanUpUnexpected } from './support';
import { createWorld, sessionFor } from './world';

const R = ENGINE_API_ROUTES;

/** Like a viewer: every read permission except `security.read`, and nothing that manages members. */
const VIEWER_LIKE = PERMISSIONS.filter((permission) => isReadPermission(permission) && permission !== 'security.read');

function viewer(ctx: Parameters<ConformanceCheck['run']>[0]): Promise<EngineApi> {
    return sessionFor(ctx, { kind: 'member', permissions: VIEWER_LIKE }, 'members with chosen permissions');
}

export const MEMBER_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.me.own-sessions',
        suite: SUITE,
        title: 'A viewer lists and revokes their own sessions under /me; revoke-others keeps the current one',
        async run(ctx) {
            const member = await viewer(ctx);
            const findings = new Findings();
            const { memberId } = await member.ok(R.getMe);
            const sessions = (await member.ok(R.listMySessions)).items;
            if (sessions.some((session) => session.memberId !== memberId)) {
                findings.add("GET /me/sessions: lists another member's session");
            }
            const current = sessions.filter((session) => session.current);
            if (current.length !== 1) fail(`GET /me/sessions: ${String(current.length)} sessions are marked current`);
            const { revoked } = await member.ok(R.revokeMyOtherSessions);
            const left = (await member.ok(R.listMySessions)).items;
            if (left.length !== 1 || left[0]?.id !== current[0]?.id) {
                findings.add(
                    `POST /me/sessions/revoke-others: ${String(left.length)} sessions left, not just the current one`,
                );
            }
            if (revoked !== sessions.length - 1) {
                findings.add(
                    `POST /me/sessions/revoke-others: reports ${String(revoked)}, revoked ${String(sessions.length - 1)}`,
                );
            }
            await member.ok(R.revokeMySession, { params: { sessionId: current[0]?.id ?? '' } });
            await attempt(findings, async () => {
                await member.problem(R.getMe, {}, 'unauthenticated');
            });
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.me.own-passkeys',
        suite: SUITE,
        title: 'A viewer lists their own passkeys under /me and revokes one, never the last',
        async run(ctx) {
            const member = await viewer(ctx);
            const findings = new Findings();
            const { memberId } = await member.ok(R.getMe);
            const passkeys = (await member.ok(R.listMyPasskeys)).items;
            if (passkeys.some((passkey) => passkey.memberId !== memberId)) {
                findings.add("GET /me/passkeys: lists another member's passkey");
            }
            const [first] = passkeys;
            if (first === undefined) skip('the member has no passkey to revoke (listing passed)');
            const result = await member.call(R.revokeMyPasskey, { params: { passkeyId: first.id } });
            if (result.kind === 'problem' && result.problem.code === 'step-up-required') {
                skip('revoking a passkey needs a step-up the suite cannot give (listing passed)');
            }
            if (passkeys.length === 1) {
                if (result.kind !== 'problem' || result.problem.code !== 'last-passkey') {
                    findings.add('DELETE /me/passkeys/{passkeyId}: the last passkey was not refused with last-passkey');
                }
            } else if (result.kind === 'problem') {
                findings.add(`DELETE /me/passkeys/{passkeyId}: refused with ${result.problem.code}`);
            } else if ((await member.ok(R.listMyPasskeys)).items.some(({ id }) => id === first.id)) {
                findings.add('DELETE /me/passkeys/{passkeyId}: the revoked passkey is still listed');
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.me.others-credentials-404',
        suite: SUITE,
        title: "Another member's (or an unknown) session or passkey ID under /me answers 404, never 403",
        async run(ctx) {
            const world = await createWorld(ctx);
            const member = await viewer(ctx);
            const findings = new Findings();
            const ownerSession = (await world.owner.ok(R.listMySessions)).items.find((session) => session.current);
            if (ownerSession === undefined) fail("GET /me/sessions: the owner's current session is not listed");
            const ownerPasskey = (await world.owner.ok(R.listMyPasskeys)).items[0];
            const unknown = `conformance-${ctx.runId}-unknown`;
            const probes: (readonly [typeof R.revokeMySession | typeof R.revokeMyPasskey, string, string])[] = [
                [R.revokeMySession, 'sessionId', ownerSession.id],
                [R.revokeMySession, 'sessionId', unknown],
                [R.revokeMyPasskey, 'passkeyId', unknown],
                ...(ownerPasskey === undefined ? [] : [[R.revokeMyPasskey, 'passkeyId', ownerPasskey.id] as const]),
            ];
            for (const [route, param, id] of probes) {
                await attempt(findings, async () => {
                    const result = await member.call(route, { params: { [param]: id } });
                    if (result.kind === 'problem' && result.problem.code === 'step-up-required') return;
                    if (result.kind === 'ok' || result.problem.code !== 'not-found') {
                        const got = result.kind === 'ok' ? String(result.status) : result.problem.code;
                        findings.add(
                            `${describe(route)}: ${id === unknown ? 'an unknown' : "another member's"} ID got ${got}`,
                        );
                    }
                });
            }
            const still = (await world.owner.ok(R.listMySessions)).items.some(({ id }) => id === ownerSession.id);
            if (!still) findings.add("DELETE /me/sessions/{sessionId}: another member's session was revoked");
            if (ownerPasskey !== undefined) {
                const kept = (await world.owner.ok(R.listMyPasskeys)).items.some(({ id }) => id === ownerPasskey.id);
                if (!kept) findings.add("DELETE /me/passkeys/{passkeyId}: another member's passkey was revoked");
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.cross-member.private-resources',
        suite: SUITE,
        title: 'A second member with the same permissions gets 403 or 404 on resources the engine keeps private to the first',
        async run(ctx) {
            const policy = ctx.target.memberPrivateResources;
            if (policy === undefined || policy.agentRoutes.length === 0) {
                skip('the target reports no resources private to one member');
            }
            const owner = await createWorld(ctx);
            const subject = { kind: 'member', permissions: policy.permissions } as const;
            const first = await createWorld(ctx, await sessionFor(ctx, subject, 'members with chosen permissions'));
            const second = await sessionFor(ctx, subject, 'members with chosen permissions');
            const findings = new Findings();
            await first.agent();
            for (const id of policy.agentRoutes) {
                const route = R[id];
                await attempt(findings, async () => {
                    const request = await validRequest(route, first);
                    if (request === null) fail(`${describe(route)}: the suite cannot build a request for it`);
                    const before = await snapshot(owner.owner, route, request);
                    const result = await second.call(route, request);
                    if (result.kind === 'ok') {
                        cleanUpUnexpected(ctx, owner.owner, route, result);
                        findings.add(`${describe(route)}: the second member got ${String(result.status)}`);
                    } else if (result.problem.code !== 'forbidden' && result.problem.code !== 'not-found') {
                        findings.add(
                            `${describe(route)}: the second member got ${result.problem.code}, not 403 or 404`,
                        );
                    }
                    if (before !== null && (await snapshot(owner.owner, route, request)) !== before) {
                        findings.add(`${describe(route)}: the refused request changed state`);
                    }
                });
            }
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.cross-member.chat-writes',
        suite: SUITE,
        title: 'A member who may write in chats gets 403 or 404 sending or cancelling in a chat another member started',
        async run(ctx) {
            const world = await createWorld(ctx);
            const second = await sessionFor(
                ctx,
                { kind: 'member', permissions: ['agents.read', 'chats.read', 'chats.write'] },
                'members with chosen permissions',
            );
            const { id: chatId } = await world.chat();
            const { replyMessageId } = await world.reply();
            const before = (await world.owner.ok(R.getChat, { params: { chatId } })).messageCount;
            const findings = new Findings();
            const probes = [
                [R.sendChatMessage, { params: { chatId }, body: { content: 'conformance: not your chat' } }],
                [R.cancelChatReply, { params: { chatId, messageId: replyMessageId } }],
            ] as const;
            for (const [route, request] of probes) {
                await attempt(findings, async () => {
                    const result = await second.call(route, request);
                    if (result.kind === 'ok') {
                        findings.add(`${describe(route)}: the second member got ${String(result.status)}`);
                    } else if (result.problem.code !== 'forbidden' && result.problem.code !== 'not-found') {
                        findings.add(
                            `${describe(route)}: the second member got ${result.problem.code}, not 403 or 404`,
                        );
                    }
                });
            }
            const after = (await world.owner.ok(R.getChat, { params: { chatId } })).messageCount;
            if (after !== before)
                findings.add('POST /chats/{chatId}/messages: the refused message was added to the chat');
            return findings.outcome();
        },
    },
];
