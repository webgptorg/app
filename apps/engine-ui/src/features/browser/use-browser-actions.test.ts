import { describe, expect, it } from 'vitest';

import { RERUN, signInOrigin } from './use-browser-actions';

describe('reruns after a full-page step-up', () => {
    it('take back only well-formed inputs from storage', () => {
        expect(RERUN.controlTab({ tabId: 'tab-1' })).toEqual({ tabId: 'tab-1' });
        expect(RERUN.controlTab({ tabId: '../tab' })).toBeUndefined();
        expect(RERUN.controlTab('tab-1')).toBeUndefined();
        expect(RERUN.controlTab(null)).toBeUndefined();
        expect(RERUN.takeControl({ sessionId: 'live-1' })).toEqual({ sessionId: 'live-1' });
        expect(RERUN.takeControl({ sessionId: 7 })).toBeUndefined();
        expect(RERUN.signIn({ origin: 'https://github.com' })).toEqual({ origin: 'https://github.com' });
        expect(RERUN.signIn({ origin: 'https://github.com/login' })).toBeUndefined();
        expect(RERUN.signIn({ origin: 'javascript:alert(1)' })).toBeUndefined();
    });

    it('offers a sign-in tab only for a canonical https site', () => {
        expect(signInOrigin('https://github.com')).toBe('https://github.com');
        expect(signInOrigin('http://intranet.example')).toBeNull();
        expect(signInOrigin('https://github.com/')).toBeNull();
    });
});
