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

    it('keeps the running one when the same session is shown again', () => {
        const sessions = createLiveSessions();
        const running = fakeSession('live-1');
        const again = fakeSession('live-1');
        sessions.show(running);
        sessions.show(again, { end: false });
        expect(sessions.current()).toBe(running);
        expect(again.dispose).toHaveBeenCalledOnce();
        expect(running.end).not.toHaveBeenCalled();
        expect(running.dispose).not.toHaveBeenCalled();
    });

    it('never ends the previous one from a page load, only closes it', () => {
        const sessions = createLiveSessions();
        const previous = fakeSession('live-1');
        const loaded = fakeSession('live-2');
        sessions.show(previous);
        sessions.show(loaded, { end: false });
        expect(sessions.current()).toBe(loaded);
        expect(previous.end).not.toHaveBeenCalled();
        expect(previous.dispose).toHaveBeenCalledOnce();
    });
});
