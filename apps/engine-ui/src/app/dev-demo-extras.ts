import type { InMemorySeed } from '@ptbk/engine-api/in-memory';

const MINUTE_MS = 60_000;

const MAC_CHROME =
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/142.0.0.0 Safari/537.36';
const IPHONE_SAFARI =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 19_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/19.1 Mobile/15E148 Safari/604.1';
const WINDOWS_FIREFOX = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0';

/**
 * Passkeys, sessions and an audit trail for the offline demo, so the admin screens show what an engine in use has.
 * The demo seed leaves them to the in-memory defaults: one passkey, one session, an empty log.
 */
export function demoAdminExtras(
    now: Date,
    userAgent: string,
): Pick<InMemorySeed, 'passkeys' | 'sessions' | 'auditEntries'> {
    const ago = (minutes: number): string => new Date(now.getTime() - minutes * MINUTE_MS).toISOString();
    const later = (minutes: number): string => new Date(now.getTime() + minutes * MINUTE_MS).toISOString();
    const owner = { kind: 'member', memberId: 'member-owner' } as const;
    const jana = { kind: 'member', memberId: 'member-jana' } as const;
    const here = { ip: '127.0.0.1', userAgent };
    const phone = { ip: '203.0.113.24', userAgent: IPHONE_SAFARI };
    const office = { ip: '198.51.100.40', userAgent: WINDOWS_FIREFOX };
    return {
        passkeys: [
            {
                id: 'passkey-owner',
                memberId: 'member-owner',
                name: 'MacBook',
                createdAt: ago(60 * 24 * 30),
                lastUsedAt: ago(1),
                authenticator: { attachment: 'platform', backedUp: true },
            },
            {
                id: 'passkey-owner-key',
                memberId: 'member-owner',
                name: 'YubiKey 5C',
                createdAt: ago(60 * 24 * 21),
                lastUsedAt: ago(60 * 24 * 3),
                authenticator: { attachment: 'cross-platform', backedUp: false },
            },
            {
                id: 'passkey-jana',
                memberId: 'member-jana',
                name: 'Windows Hello',
                createdAt: ago(60 * 24 * 30),
                lastUsedAt: ago(42),
                authenticator: { attachment: 'platform', backedUp: false },
            },
        ],
        sessions: [
            {
                id: 'session-current',
                memberId: 'member-owner',
                current: true,
                client: here,
                passkeyId: 'passkey-owner',
                createdAt: ago(1),
                lastSeenAt: ago(0),
                expiresAt: later(60 * 24 * 7),
            },
            {
                id: 'session-owner-phone',
                memberId: 'member-owner',
                current: false,
                client: phone,
                passkeyId: 'passkey-owner',
                createdAt: ago(60 * 24 * 2),
                lastSeenAt: ago(60 * 5),
                expiresAt: later(60 * 24 * 5),
            },
            {
                id: 'session-jana',
                memberId: 'member-jana',
                current: false,
                client: office,
                passkeyId: 'passkey-jana',
                createdAt: ago(60 * 3),
                lastSeenAt: ago(42),
                expiresAt: later(60 * 24 * 6),
            },
        ],
        auditEntries: [
            {
                at: ago(60 * 24 * 30),
                actor: owner,
                action: 'invite.create',
                target: { kind: 'invite', id: 'invite-jana', name: null },
                outcome: 'success',
                client: { ip: '127.0.0.1', userAgent: MAC_CHROME },
                details: { role: 'admin' },
            },
            {
                at: ago(60 * 24 * 21),
                actor: owner,
                action: 'passkey.register',
                target: { kind: 'passkey', id: 'passkey-owner-key', name: 'YubiKey 5C' },
                outcome: 'success',
                client: { ip: '127.0.0.1', userAgent: MAC_CHROME },
            },
            {
                at: ago(60 * 24 * 7),
                actor: owner,
                action: 'agent.create',
                target: { kind: 'agent', id: 'agent-iris', name: 'Iris' },
                outcome: 'success',
                client: { ip: '127.0.0.1', userAgent: MAC_CHROME },
            },
            {
                at: ago(60 * 24 * 2),
                actor: owner,
                action: 'auth.sign-in',
                target: null,
                outcome: 'success',
                client: phone,
            },
            {
                at: ago(60 * 26),
                actor: { kind: 'system' },
                action: 'engine.update.install',
                target: { kind: 'engine', id: 'engine', name: '1.0.0' },
                outcome: 'success',
                client: null,
            },
            {
                at: ago(60 * 3),
                actor: jana,
                action: 'auth.sign-in',
                target: null,
                outcome: 'success',
                client: office,
            },
            {
                at: ago(60 * 2 + 50),
                actor: jana,
                action: 'settings.update-policy',
                target: { kind: 'settings', id: 'settings', name: null },
                outcome: 'denied',
                client: office,
                details: { reason: 'step-up required' },
            },
            {
                at: ago(60 * 2 + 10),
                actor: jana,
                action: 'trigger.pause',
                target: { kind: 'trigger', id: 'trigger-weekly-report', name: 'Weekly report' },
                outcome: 'success',
                client: office,
            },
            {
                at: ago(60 + 20),
                actor: owner,
                action: 'wallet.record.save',
                target: { kind: 'wallet-record', id: 'wallet-github', name: 'github.com' },
                outcome: 'success',
                client: { ip: '127.0.0.1', userAgent: MAC_CHROME },
            },
            {
                at: ago(55),
                actor: owner,
                action: 'integration.enable',
                target: { kind: 'integration', id: 'integration-github', name: 'GitHub' },
                outcome: 'failed',
                client: { ip: '127.0.0.1', userAgent: MAC_CHROME },
                details: { error: 'The token was rejected.' },
            },
            {
                at: ago(1),
                actor: owner,
                action: 'auth.sign-in',
                target: null,
                outcome: 'success',
                client: here,
            },
        ],
    };
}
