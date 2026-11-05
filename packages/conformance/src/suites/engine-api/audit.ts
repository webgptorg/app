import { ENGINE_API_ROUTES, KNOWN_CAPABILITIES } from '@ptbk/engine-api';
import type { AuditAction, AuditEntry, EngineApiRouteId } from '@ptbk/engine-api';

import type { ConformanceCheck } from '../../check';
import { Findings } from '../../check';
import { CHAT_MESSAGE } from '../../fixtures/books';
import { randomToken } from '../../random';
import type { EngineApi } from './api';
import { requireCapability } from './capability-support';
import { SUITE, attempt } from './support';
import { createWorld } from './world';

const R = ENGINE_API_ROUTES;

/**
 * The audit entry each mutating route must produce: its action, and which path parameter names the target (`created`
 * when the target is the resource the request created, `null` when the action has no target). The contract fixes the
 * action names; the targets follow from what each route acts on.
 */
export const AUDIT_EXPECTATIONS: Partial<
    Record<
        EngineApiRouteId,
        { readonly action: AuditAction; readonly kind: string | null; readonly param: string | null }
    >
> = {
    createAgent: { action: 'agent.create', kind: 'agent', param: 'created' },
    updateAgent: { action: 'agent.update', kind: 'agent', param: 'agentId' },
    deleteAgent: { action: 'agent.delete', kind: 'agent', param: 'agentId' },
    restoreAgent: { action: 'agent.restore', kind: 'agent', param: 'agentId' },
    updateAgentSource: { action: 'agent.source.update', kind: 'agent', param: 'agentId' },
    // Audited when a test conversation starts and whenever one is refused; never per turn.
    testAgentDraft: { action: 'agent.test-chat.start', kind: 'agent', param: 'agentId' },
    createFolder: { action: 'folder.create', kind: 'folder', param: 'created' },
    renameFolder: { action: 'folder.rename', kind: 'folder', param: 'folderId' },
    deleteFolder: { action: 'folder.delete', kind: 'folder', param: 'folderId' },
    createChat: { action: 'chat.create', kind: 'chat', param: 'created' },
    sendChatMessage: { action: 'chat.message.send', kind: 'chat', param: 'chatId' },
    cancelChatReply: { action: 'chat.reply.cancel', kind: 'message', param: 'messageId' },
    createApiToken: { action: 'api-token.create', kind: 'api-token', param: 'created' },
    revokeApiToken: { action: 'api-token.revoke', kind: 'api-token', param: 'apiTokenId' },
    updateSettings: { action: 'settings.update', kind: null, param: null },
    setUpdatePolicy: { action: 'settings.update-policy', kind: null, param: null },
    revokePasskey: { action: 'passkey.revoke', kind: 'passkey', param: 'passkeyId' },
    revokeSession: { action: 'session.revoke', kind: 'session', param: 'sessionId' },
    revokeMyPasskey: { action: 'passkey.revoke', kind: 'passkey', param: 'passkeyId' },
    revokeMySession: { action: 'session.revoke', kind: 'session', param: 'sessionId' },
    revokeMyOtherSessions: { action: 'session.revoke-others', kind: null, param: null },
    addWalletRecord: { action: 'wallet.record.save', kind: 'wallet-record', param: 'created' },
    updateWalletRecord: { action: 'wallet.record.update', kind: 'wallet-record', param: 'recordId' },
    deleteWalletRecord: { action: 'wallet.record.delete', kind: 'wallet-record', param: 'recordId' },
    markWalletRequestSeen: { action: 'wallet.request.seen', kind: 'wallet-request', param: 'requestId' },
    rejectWalletRequest: { action: 'wallet.request.reject', kind: 'wallet-request', param: 'requestId' },
    uploadFile: { action: 'file.upload', kind: 'file', param: 'created' },
    deleteFile: { action: 'file.delete', kind: 'file', param: 'fileId' },
    cancelRun: { action: 'run.cancel', kind: 'run', param: 'runId' },
    retryRun: { action: 'run.retry', kind: 'run', param: 'runId' },
    createTrigger: { action: 'trigger.create', kind: 'trigger', param: 'created' },
    updateTrigger: { action: 'trigger.update', kind: 'trigger', param: 'triggerId' },
    pauseTrigger: { action: 'trigger.pause', kind: 'trigger', param: 'triggerId' },
    resumeTrigger: { action: 'trigger.resume', kind: 'trigger', param: 'triggerId' },
    deleteTrigger: { action: 'trigger.delete', kind: 'trigger', param: 'triggerId' },
    createIntegration: { action: 'integration.create', kind: 'integration', param: 'created' },
    updateIntegration: { action: 'integration.update', kind: 'integration', param: 'integrationId' },
    enableIntegration: { action: 'integration.enable', kind: 'integration', param: 'integrationId' },
    disableIntegration: { action: 'integration.disable', kind: 'integration', param: 'integrationId' },
    deleteIntegration: { action: 'integration.delete', kind: 'integration', param: 'integrationId' },
};

export interface ExpectedEntry {
    readonly route: string;
    readonly action: AuditAction;
    readonly target: { readonly kind: string; readonly id: string } | null;
    readonly outcome: AuditEntry['outcome'];
    readonly memberId: string;
}

/**
 * Finds the entry with this action, target, outcome and acting member, newest first. Reports a missing entry and an
 * entry that names another member differently, since the second means the audit log blames the wrong person.
 */
export async function findAuditEntry(auditor: EngineApi, expected: ExpectedEntry, findings: Findings): Promise<void> {
    const page = await auditor.ok(R.listAuditEntries, {
        query: {
            action: expected.action,
            outcome: expected.outcome,
            limit: 100,
            ...(expected.target === null ? {} : { targetKind: expected.target.kind, targetId: expected.target.id }),
        },
    });
    const matching = page.items.filter(
        (entry) =>
            entry.action === expected.action &&
            entry.outcome === expected.outcome &&
            (expected.target === null ||
                (entry.target?.kind === expected.target.kind && entry.target.id === expected.target.id)),
    );
    const where = `${expected.route} (${expected.action}, ${expected.outcome})`;
    if (matching.length === 0) {
        findings.add(`${where}: no audit entry`);
        return;
    }
    const byMember = matching.some(({ actor }) => actor.kind !== 'system' && actor.memberId === expected.memberId);
    if (!byMember) findings.add(`${where}: the audit entry names another member than the one who acted`);
}

export const AUDIT_CHECKS: readonly ConformanceCheck[] = [
    {
        id: 'engine-api.audit.mutations-recorded',
        suite: SUITE,
        title: 'Every mutation is in /audit with the acting member, its action and its target',
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.audit);
            const { owner } = world;
            const { memberId } = await world.me();
            const findings = new Findings();
            const done: ExpectedEntry[] = [];
            const record = (route: string, action: AuditAction, kind: string, id: string): void => {
                done.push({ route, action, target: { kind, id }, outcome: 'success', memberId });
            };

            const agent = await world.createAgent('audited');
            const agentParams = { agentId: agent.id };
            record('POST /agents', 'agent.create', 'agent', agent.id);
            const manages = await world.advertises(R.updateAgent);
            if (manages) {
                await owner.ok(R.updateAgent, { params: agentParams, body: { visibility: agent.visibility } });
                record('PATCH /agents/{agentId}', 'agent.update', 'agent', agent.id);
            }
            if (await world.advertises(R.updateAgentSource)) {
                const source = await owner.ok(R.getAgentSource, { params: agentParams });
                await owner.ok(R.updateAgentSource, {
                    params: agentParams,
                    body: { source: `${source.source}\nNOTE Audited edit.\n`, baseRevisionId: source.revisionId },
                });
                record('PUT /agents/{agentId}/source', 'agent.source.update', 'agent', agent.id);
            }
            await owner.ok(R.deleteAgent, { params: agentParams });
            record('DELETE /agents/{agentId}', 'agent.delete', 'agent', agent.id);
            if (manages) {
                await owner.ok(R.restoreAgent, { params: agentParams });
                record('POST /agents/{agentId}/restore', 'agent.restore', 'agent', agent.id);
            }

            const folder = await owner.ok(R.createFolder, { body: { name: world.name('audited') } });
            record('POST /folders', 'folder.create', 'folder', folder.id);
            await owner.ok(R.renameFolder, { params: { folderId: folder.id }, body: { name: world.name('renamed') } });
            record('PATCH /folders/{folderId}', 'folder.rename', 'folder', folder.id);
            await owner.ok(R.deleteFolder, { params: { folderId: folder.id } });
            record('DELETE /folders/{folderId}', 'folder.delete', 'folder', folder.id);

            const chat = await owner.ok(R.createChat, {
                body: { agentId: agent.id, title: world.name('audited') },
            });
            record('POST /chats', 'chat.create', 'chat', chat.id);
            await owner.ok(R.sendChatMessage, { params: { chatId: chat.id }, body: { content: CHAT_MESSAGE } });
            record('POST /chats/{chatId}/messages', 'chat.message.send', 'chat', chat.id);

            const login = await world.createWalletLogin('audited', randomToken(ctx.random, 32));
            if (login !== null) {
                const params = { recordId: login.id };
                record('POST /wallet/records', 'wallet.record.save', 'wallet-record', login.id);
                await owner.ok(R.updateWalletRecord, {
                    params,
                    body: {
                        origin: login.origin,
                        username: login.username ?? 'ada',
                        password: randomToken(ctx.random, 32),
                    },
                });
                record('PUT /wallet/records/{recordId}', 'wallet.record.update', 'wallet-record', login.id);
                await owner.ok(R.deleteWalletRecord, { params });
                record('DELETE /wallet/records/{recordId}', 'wallet.record.delete', 'wallet-record', login.id);
            }

            for (const expected of done) await attempt(findings, () => findAuditEntry(owner, expected, findings));
            return findings.outcome();
        },
    },
    {
        id: 'engine-api.audit.hash-chain',
        suite: SUITE,
        title: "Within a page of /audit each entry's prevHash is the previous entry's hash, and /audit/verify is intact",
        async run(ctx) {
            const world = await createWorld(ctx);
            await requireCapability(world, KNOWN_CAPABILITIES.audit);
            const findings = new Findings();
            await world.folder();
            await world.createFolder('chain');
            const page = await world.owner.ok(R.listAuditEntries, { query: { limit: 50 } });
            if (page.items.length < 2) findings.add('GET /audit: fewer than two entries after two mutations');
            for (let index = 0; index + 1 < page.items.length; index++) {
                const newer = page.items[index] as AuditEntry;
                const older = page.items[index + 1] as AuditEntry;
                if (newer.seq !== older.seq + 1) {
                    findings.add(`GET /audit: seq ${String(older.seq)} is followed by ${String(newer.seq)}`);
                } else if (newer.prevHash !== older.hash) {
                    findings.add(
                        `GET /audit: entry ${String(newer.seq)}'s prevHash is not entry ${String(older.seq)}'s hash`,
                    );
                }
            }
            const verification = await world.owner.ok(R.verifyAuditLog);
            if (verification.status !== 'intact') {
                findings.add(
                    `GET /audit/verify: the chain is ${verification.status} at ${String(verification.firstBrokenSeq)}`,
                );
            }
            const newest = page.items[0];
            if (newest !== undefined && verification.lastSeq !== null && verification.lastSeq < newest.seq) {
                findings.add('GET /audit/verify: lastSeq is older than the newest listed entry');
            }
            return findings.outcome();
        },
    },
];
