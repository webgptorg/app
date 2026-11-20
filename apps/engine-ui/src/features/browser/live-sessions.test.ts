import { describe, expect, it, vi } from 'vitest';

import type { LiveSession } from './live-session';
import { createLiveSessions } from './live-sessions';

function fakeSession(id: string): LiveSession {
    return {
        id,
        end: vi.fn(() => Promise.resolve()),
        dispose: vi.fn(),
    } as unknown as LiveSession;
}

describe('the member’s live sessions', () => {
    it('keeps one at a time, ending the one it replaces', async () => {
        const sessions = createLiveSessions();
        const listener = vi.fn();
        const unsubscribe = sessions.subscribe(listener);
        const first = fakeSession('live-1');
        const second = fakeSession('live-2');
        sessions.show(first);
        sessions.show(first);
        expect(listener).toHaveBeenCalledOnce();
        sessions.show(second);
        expect(sessions.current()).toBe(second);
        expect(first.end).toHaveBeenCalledOnce();
        await vi.waitFor(() => {
            expect(first.dispose).toHaveBeenCalledOnce();
        });
        unsubscribe();
        sessions.dispose();
        expect(second.dispose).toHaveBeenCalledOnce();
        expect(sessions.current()).toBeNull();
        expect(listener).toHaveBeenCalledTimes(2);
    });
});
