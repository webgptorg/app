import { verifyEd25519 } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createMemoryIdentityStore } from './memory-identity-store';

describe('createMemoryIdentityStore', () => {
    it('creates one identity per store and keeps returning it', async () => {
        const store = createMemoryIdentityStore();
        const first = await store.loadOrCreate();
        expect(await store.loadOrCreate()).toBe(first);
        expect((await createMemoryIdentityStore().loadOrCreate()).engineId).not.toBe(first.engineId);
        const message = Uint8Array.of(1, 2, 3);
        expect(verifyEd25519(first.publicKey, message, await first.sign(message))).toBe(true);
    });
});
