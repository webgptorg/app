import { describe, expect, it, vi } from 'vitest';

import { TOKEN } from '../../testing/fixtures';
import { createFragmentTokens, parseFragmentToken } from './fragment-token';

describe('parseFragmentToken', () => {
    it('reads a 256-bit base64url token, with or without the leading #', () => {
        expect(parseFragmentToken(`#${TOKEN}`)).toEqual({ kind: 'token', token: TOKEN });
        expect(parseFragmentToken(TOKEN)).toEqual({ kind: 'token', token: TOKEN });
    });

    it('tells nothing from something malformed', () => {
        expect(parseFragmentToken('')).toEqual({ kind: 'none' });
        expect(parseFragmentToken('#')).toEqual({ kind: 'none' });
        expect(parseFragmentToken(`#${TOKEN}x`)).toEqual({ kind: 'malformed' });
        expect(parseFragmentToken('#not a token')).toEqual({ kind: 'malformed' });
    });
});

describe('fragment token holder', () => {
    it('holds a token per purpose until forgotten, and counts arrivals for subscribers', () => {
        const tokens = createFragmentTokens();
        const listener = vi.fn();
        const unsubscribe = tokens.subscribe(listener);
        expect(tokens.peek('signup')).toEqual({ kind: 'none' });
        expect(tokens.arrivals()).toBe(0);

        tokens.put('signup', { kind: 'token', token: TOKEN });
        expect(tokens.peek('signup')).toEqual({ kind: 'token', token: TOKEN });
        expect(tokens.peek('signup')).toEqual({ kind: 'token', token: TOKEN });
        expect(tokens.peek('recovery')).toEqual({ kind: 'none' });
        expect(tokens.arrivals()).toBe(1);
        expect(listener).toHaveBeenCalledTimes(1);

        tokens.forget('signup');
        expect(tokens.peek('signup')).toEqual({ kind: 'none' });

        unsubscribe();
        tokens.put('recovery', { kind: 'malformed' });
        expect(listener).toHaveBeenCalledTimes(1);
        expect(tokens.arrivals()).toBe(2);
    });
});
