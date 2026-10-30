import { describe, expect, it } from 'vitest';

import { createMemoryStorage, REFUSING_STORAGE } from '../../testing/memory-storage';
import { saveStepUpIntent, STEP_UP_INTENT_KEY, STEP_UP_INTENT_MAX_AGE_MS, takeStepUpIntent } from './step-up-intent';

const NOW = 1_000_000;
const INTENT = { action: 'settings.update-policy', data: { policy: 'manual' } };

describe('step-up intent', () => {
    it('comes back once, on the page and for the action it was saved for', () => {
        const storage = createMemoryStorage();
        saveStepUpIntent(storage, INTENT, '/settings', NOW);
        expect(takeStepUpIntent(storage, 'settings.update-policy', '/settings', NOW + 5_000)).toEqual({
            policy: 'manual',
        });
        expect(takeStepUpIntent(storage, 'settings.update-policy', '/settings', NOW + 5_000)).toBeUndefined();
    });

    it('stays for its own page when another page asks', () => {
        const storage = createMemoryStorage();
        saveStepUpIntent(storage, INTENT, '/settings', NOW);
        expect(takeStepUpIntent(storage, 'security.revoke-passkey', '/settings', NOW)).toBeUndefined();
        expect(takeStepUpIntent(storage, 'settings.update-policy', '/security', NOW)).toBeUndefined();
        expect(takeStepUpIntent(storage, 'settings.update-policy', '/settings', NOW)).toEqual({ policy: 'manual' });
    });

    it('expires, and is dropped once seen stale', () => {
        const storage = createMemoryStorage();
        saveStepUpIntent(storage, INTENT, '/settings', NOW);
        const later = NOW + STEP_UP_INTENT_MAX_AGE_MS + 1;
        expect(takeStepUpIntent(storage, 'settings.update-policy', '/settings', later)).toBeUndefined();
        expect(storage.getItem(STEP_UP_INTENT_KEY)).toBe('');
    });

    it('refuses an intent from the future', () => {
        const storage = createMemoryStorage();
        saveStepUpIntent(storage, INTENT, '/settings', NOW);
        expect(takeStepUpIntent(storage, 'settings.update-policy', '/settings', NOW - 1)).toBeUndefined();
    });

    it.each(['not json', '{"action":1,"path":"/settings","at":1000000,"data":{}}', 'null', '[]'])(
        'ignores and drops a malformed entry: %s',
        (raw) => {
            const storage = createMemoryStorage({ [STEP_UP_INTENT_KEY]: raw });
            expect(takeStepUpIntent(storage, 'settings.update-policy', '/settings', NOW)).toBeUndefined();
            expect(storage.getItem(STEP_UP_INTENT_KEY)).toBe('');
        },
    );

    it('works without storage and when the browser refuses it', () => {
        expect(() => {
            saveStepUpIntent(undefined, INTENT, '/settings', NOW);
            saveStepUpIntent(REFUSING_STORAGE, INTENT, '/settings', NOW);
        }).not.toThrow();
        expect(takeStepUpIntent(undefined, 'settings.update-policy', '/settings', NOW)).toBeUndefined();
        expect(takeStepUpIntent(REFUSING_STORAGE, 'settings.update-policy', '/settings', NOW)).toBeUndefined();
    });
});
