import { afterEach, describe, expect, it, vi } from 'vitest';

import { createFakePopups } from '../../testing/fake-popups';
import { createPopupNonce, stepUpPopupUrl, waitForStepUpPopup } from './step-up-popup';

const LOCATION = { origin: 'https://engine.localhost', pathname: '/wallet', search: '?dialog=new', hash: '' };

afterEach(() => {
    vi.useRealTimers();
});

function opened() {
    const popups = createFakePopups();
    const popup = popups.open(stepUpPopupUrl(LOCATION, 'nonce-0123456789abcdef'));
    if (popup === null) throw new Error('blocked');
    return { popups, popup };
}

describe('step-up popup', () => {
    it('points the window at the gateway in popup mode with the nonce and the way back', () => {
        const url = new URL(stepUpPopupUrl(LOCATION, 'nonce-0123456789abcdef'), LOCATION.origin);
        expect(url.pathname).toBe('/auth/step-up');
        expect(Object.fromEntries(url.searchParams)).toEqual({
            mode: 'popup',
            nonce: 'nonce-0123456789abcdef',
            returnTo: '/wallet?dialog=new',
        });
    });

    it('makes a URL-safe nonce the gateway accepts', () => {
        const nonce = createPopupNonce((bytes) => bytes.fill(255));
        expect(nonce).toMatch(/^[A-Za-z0-9_-]{16,64}$/);
    });

    it('resolves confirmed on the answer with its nonce, and ignores any other', async () => {
        const { popups } = opened();
        const outcome = waitForStepUpPopup(popups, popups.opened[0] as never, 'nonce-0123456789abcdef');
        popups.post({ type: 'step-up-confirmed', nonce: 'from-another-tab-000' });
        popups.post('noise');
        popups.post(null);
        popups.confirm();
        await expect(outcome).resolves.toBe('confirmed');
    });

    it('resolves closed when the window closes without an answer', async () => {
        vi.useFakeTimers();
        const { popups, popup } = opened();
        const outcome = waitForStepUpPopup(popups, popup, 'nonce-0123456789abcdef');
        popup.close();
        await vi.advanceTimersByTimeAsync(1_000);
        await expect(outcome).resolves.toBe('closed');
    });

    it('still counts an answer that arrives just after the window closed itself', async () => {
        vi.useFakeTimers();
        const { popups, popup } = opened();
        const outcome = waitForStepUpPopup(popups, popup, 'nonce-0123456789abcdef');
        popup.close();
        await vi.advanceTimersByTimeAsync(500);
        popups.post({ type: 'step-up-confirmed', nonce: 'nonce-0123456789abcdef' });
        await expect(outcome).resolves.toBe('confirmed');
    });

    it('times out, closing the window', async () => {
        vi.useFakeTimers();
        const { popups, popup } = opened();
        const outcome = waitForStepUpPopup(popups, popup, 'nonce-0123456789abcdef', 60_000);
        await vi.advanceTimersByTimeAsync(60_000);
        await expect(outcome).resolves.toBe('timeout');
        expect(popup.closed).toBe(true);
    });
});
