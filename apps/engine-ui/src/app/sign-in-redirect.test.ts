import { SIGN_IN_PATH } from '@ptbk/engine-api';
import { describe, expect, it, vi } from 'vitest';

import { createSignInRedirect, signInUrl } from './sign-in-redirect';

const origin = 'https://engine.example';
const at = (pathname: string, search = '', hash = '') => ({ origin, pathname, search, hash, assign: vi.fn() });

describe('signInUrl', () => {
    it('sends the current path, query and fragment as next', () => {
        const url = new URL(signInUrl(at('/agents', '?sort=-name', '#top')), origin);
        expect(url.pathname).toBe(SIGN_IN_PATH);
        expect(url.searchParams.get('next')).toBe('/agents?sort=-name#top');
    });

    it('falls back to / when the current path is engine-owned', () => {
        expect(new URL(signInUrl(at('/auth/sign-in')), origin).searchParams.get('next')).toBe('/');
    });
});

describe('createSignInRedirect', () => {
    it('navigates to the sign-in page once, however many requests fail', () => {
        const location = at('/agents');
        const redirect = createSignInRedirect(location);

        redirect();
        redirect();

        expect(location.assign).toHaveBeenCalledExactlyOnceWith(`${SIGN_IN_PATH}?next=%2Fagents`);
    });
});
