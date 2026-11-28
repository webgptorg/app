import { describe, expect, it } from 'vitest';

import { cryptoRandom } from '../crypto-random';
import { newOrgId, newUserId } from '../../domain/ids';
import { createHmacUnsubscribeTokens } from './hmac-unsubscribe-tokens';

const secret = new Uint8Array(32).fill(7);
const claims = {
    userId: newUserId(cryptoRandom),
    orgId: newOrgId(cryptoRandom),
    kinds: ['task-failed', 'agent-waiting', 'task-failed'] as const,
};

describe('HMAC unsubscribe tokens', () => {
    it('round-trips its claims, kinds sorted and once each, in a URL-safe token', async () => {
        const tokens = createHmacUnsubscribeTokens(secret);
        const token = await tokens.sign(claims);
        expect(token).toMatch(/^u1\.[a-z2-7]{26}\.[a-z2-7]{26}\.agent-waiting\+task-failed\.[A-Za-z0-9_-]{43}$/);
        expect(await tokens.verify(token)).toEqual({ ...claims, kinds: ['agent-waiting', 'task-failed'] });
    });

    it('refuses a forged, tampered, truncated or foreign token', async () => {
        const tokens = createHmacUnsubscribeTokens(secret);
        const token = await tokens.sign(claims);
        const other = await createHmacUnsubscribeTokens(new Uint8Array(32).fill(8)).sign(claims);
        const widened = token.replace('agent-waiting+task-failed', 'agent-waiting+project-status+task-failed');
        const otherUser = token.replace(claims.userId, newUserId(cryptoRandom));
        const mac = token.slice(-43);
        const flipped = `${token.slice(0, -43)}${mac.startsWith('A') ? 'B' : 'A'}${mac.slice(1)}`;
        // The same MAC spelled with the last character's spare bits set.
        const respelled = `${token.slice(0, -1)}${String.fromCharCode(token.charCodeAt(token.length - 1) + 1)}`;
        for (const bad of [
            other,
            widened,
            otherUser,
            flipped,
            respelled,
            token.slice(0, -2),
            `x${token}`,
            '',
            'u1....',
        ]) {
            expect(await tokens.verify(bad)).toBeNull();
        }
    });

    it('refuses a correctly signed token naming a kind the registry does not know', async () => {
        const tokens = createHmacUnsubscribeTokens(secret);
        const forged = await tokens.sign({ ...claims, kinds: ['no-such-kind' as never] });
        expect(await tokens.verify(forged)).toBeNull();
    });
});
