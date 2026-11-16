import { describe, expect, it, vi } from 'vitest';

import { createMemoryStorage } from '../../testing/memory-storage';
import { AGENT_VIEW_STORAGE_KEY, morph, rememberAgentView, resolveAgentView } from './agent-view';

const refusing = {
    getItem: () => {
        throw new Error('storage refused');
    },
    setItem: () => {
        throw new Error('storage refused');
    },
};

describe('the agents view', () => {
    it('lets the URL win, then the device’s last choice, then the grid', () => {
        const storage = createMemoryStorage();
        expect(resolveAgentView(undefined, storage)).toBe('grid');
        rememberAgentView('table', storage);
        expect(storage.getItem(AGENT_VIEW_STORAGE_KEY)).toBe('table');
        expect(resolveAgentView(undefined, storage)).toBe('table');
        expect(resolveAgentView('grid', storage)).toBe('grid');
        storage.setItem(AGENT_VIEW_STORAGE_KEY, 'cards');
        expect(resolveAgentView(undefined, storage)).toBe('grid');
    });

    it('falls back to the grid and forgets quietly where the browser refuses storage', () => {
        expect(resolveAgentView(undefined, refusing)).toBe('grid');
        expect(() => {
            rememberAgentView('table', refusing);
        }).not.toThrow();
        expect(resolveAgentView(undefined, undefined)).toBe('grid');
    });
});

describe('morph', () => {
    it('applies the change inside a view transition and swallows a skipped one', async () => {
        const update = vi.fn();
        const skipped = Promise.reject(new Error('Transition was skipped'));
        const startViewTransition = vi.fn((callback: () => void) => {
            callback();
            return { ready: skipped, finished: skipped };
        });
        morph(update, { startViewTransition });
        expect(startViewTransition).toHaveBeenCalledOnce();
        expect(update).toHaveBeenCalledOnce();
        await expect(skipped).rejects.toThrow();
    });

    it('applies the change directly where view transitions are not supported', () => {
        const update = vi.fn();
        morph(update, {});
        expect(update).toHaveBeenCalledOnce();
    });
});
