import { describe, expect, it } from 'vitest';

import { blockedLabel, endReasonLabel, helpTitle, tabState, viewState, whereLabel } from './browser-labels';
import type { LiveView } from './live-session';

const VIEW: LiveView = {
    session: {
        id: 'live-1',
        kind: 'agent-tab',
        tabId: 'tab-1',
        browser: 'default',
        mode: 'watching',
        origin: 'https://shop.example',
        status: 'open',
        endReason: null,
        helpRequestId: null,
        openedAt: '2026-10-01T12:00:00.000Z',
        attachBy: '2026-10-01T12:00:30.000Z',
        endsAt: '2026-10-01T12:10:00.000Z',
    } as LiveView['session'],
    connection: 'open',
    mode: 'watching',
    agent: 'working',
    others: 0,
    viewport: { width: 1280, height: 800 },
    origin: 'https://shop.example',
    blocked: null,
    endReason: null,
    hasFrame: true,
};

describe('live browser labels', () => {
    it('says where the tab is, without its origin when withheld', () => {
        expect(whereLabel('https://www.shop.example')).toBe('on shop.example');
        expect(whereLabel(null)).toBe('on a hidden page');
    });

    it('explains every end reason, an unknown one generically', () => {
        const reasons = [
            'ended',
            'expired',
            'idle',
            'not-attached',
            'revoked',
            'tab-closed',
            'engine-stopped',
            'protocol-error',
            'unknown',
        ] as const;
        const labels = reasons.map(endReasonLabel);
        expect(new Set(labels).size).toBe(reasons.length - 1);
        expect(endReasonLabel('unknown')).toBe(endReasonLabel('ended'));
    });

    it('explains every blocked page, never naming a withheld origin', () => {
        expect(blockedLabel({ reason: 'origin-not-allowed', origin: 'https://elsewhere.example' })).toContain(
            'elsewhere.example',
        );
        expect(blockedLabel({ reason: 'origin-not-allowed', origin: null })).toBe("This page can't be shown.");
        expect(blockedLabel({ reason: 'browser-page', origin: null })).toMatch(/browser itself/);
        expect(blockedLabel({ reason: 'secret-page', origin: null })).toMatch(/secrets/);
        expect(blockedLabel({ reason: 'unknown', origin: null })).toBe("This page can't be shown.");
    });

    it('names the most specific state first', () => {
        expect(viewState({ ...VIEW, endReason: 'idle' }).label).toBe('Ended');
        expect(viewState({ ...VIEW, connection: 'connecting' }).label).toBe('Connecting');
        expect(viewState({ ...VIEW, connection: 'reconnecting' }).label).toBe('Reconnecting');
        expect(viewState({ ...VIEW, connection: 'closed' }).label).toBe('Disconnected');
        expect(viewState({ ...VIEW, blocked: { reason: 'secret-page', origin: null } }).label).toBe('Page hidden');
        expect(viewState({ ...VIEW, mode: 'controlling', agent: 'paused' }).label).toBe("You're in control");
        expect(viewState({ ...VIEW, agent: 'paused' }).label).toBe('Agent paused, someone else is in control');
        expect(viewState({ ...VIEW, agent: 'waiting' }).label).toBe('Agent waiting for help');
        expect(viewState(VIEW)).toEqual({ label: 'Watching', tone: 'live' });
    });

    it('titles a help request by its reason', () => {
        expect(helpTitle('login', 'Ada')).toBe('Ada needs you to sign in');
        expect(helpTitle('captcha', 'Ada')).toBe('Ada needs you to solve a check');
        expect(helpTitle('confirmation', 'Ada')).toBe('Ada needs you to confirm a step');
        expect(helpTitle('blocked', 'Ada')).toBe('Ada is stuck on a page');
        expect(helpTitle('other', 'Ada')).toBe('Ada needs your help in the browser');
        expect(helpTitle('unknown', 'Ada')).toBe('Ada needs your help in the browser');
    });

    it('labels what the agent does in a tab, and nothing for a sign-in tab', () => {
        expect(tabState('working')?.label).toBe('Working');
        expect(tabState('waiting')?.label).toBe('Waiting for help');
        expect(tabState('paused')?.label).toBe('Paused');
        expect(tabState('none')).toBeNull();
        expect(tabState('unknown')).toBeNull();
    });
});
