import fc from 'fast-check';
import { describe, expect, it } from 'vitest';

import { LinkCode } from './link-code';
import { LINK_PATH, formatLinkUrl, parseLinkArgument, parseLinkUrl } from './link-url';

const CODE = LinkCode.parse('aaaqeayeaudaocajbifqydiob4');
const URL_TEXT = `https://app.ptbk.link/link#${CODE}`;

describe('parseLinkUrl', () => {
    it('takes the dashboard origin and the code from the fragment', () => {
        expect(parseLinkUrl(URL_TEXT)).toEqual({
            kind: 'ok',
            dashboardOrigin: 'https://app.ptbk.link',
            linkCode: CODE,
        });
    });

    it('keeps a non-default port in the origin and drops the default one', () => {
        expect(parseLinkUrl(`https://app.ptbk.test:8444/link#${CODE}`)).toMatchObject({
            dashboardOrigin: 'https://app.ptbk.test:8444',
        });
        expect(parseLinkUrl(`https://app.ptbk.link:443/link#${CODE}`)).toMatchObject({
            dashboardOrigin: 'https://app.ptbk.link',
        });
    });

    it.each([
        ['not-a-url', 'not a url'],
        ['not-a-url', ''],
        ['not-a-url', `https://app.ptbk.link/link#${CODE}${'a'.repeat(2048)}`],
        ['not-https', `http://app.ptbk.link/link#${CODE}`],
        ['not-https', `wss://app.ptbk.link/link#${CODE}`],
        ['credentials', `https://user@app.ptbk.link/link#${CODE}`],
        ['credentials', `https://user:secret@app.ptbk.link/link#${CODE}`],
        ['not-link-path', `https://app.ptbk.link/#${CODE}`],
        ['not-link-path', `https://app.ptbk.link/link/#${CODE}`],
        ['not-link-path', `https://app.ptbk.link/x/link#${CODE}`],
        ['not-link-path', `https://app.ptbk.link/Link#${CODE}`],
        ['query', `https://app.ptbk.link/link?code=x#${CODE}`],
        ['query', `https://app.ptbk.link/link?#${CODE}`],
        ['invalid-code', 'https://app.ptbk.link/link'],
        ['invalid-code', 'https://app.ptbk.link/link#'],
        ['invalid-code', `https://app.ptbk.link/link#${CODE.toUpperCase()}`],
        ['invalid-code', `https://app.ptbk.link/link#${CODE.slice(1)}`],
        ['invalid-code', `https://app.ptbk.link/link#${CODE}%20`],
    ])('refuses %s: %s', (problem, text) => {
        expect(parseLinkUrl(text)).toEqual({ kind: 'invalid', problem });
    });
});

describe('parseLinkArgument', () => {
    it('takes a bare code without a dashboard', () => {
        expect(parseLinkArgument(CODE)).toEqual({ kind: 'ok', dashboardOrigin: null, linkCode: CODE });
    });

    it('takes a link URL with its dashboard', () => {
        expect(parseLinkArgument(URL_TEXT)).toEqual({
            kind: 'ok',
            dashboardOrigin: 'https://app.ptbk.link',
            linkCode: CODE,
        });
    });

    it('refuses a malformed code as not a URL', () => {
        expect(parseLinkArgument(CODE.slice(1))).toEqual({ kind: 'invalid', problem: 'not-a-url' });
    });
});

describe('formatLinkUrl', () => {
    it('puts the code in the fragment of /link', () => {
        expect(LINK_PATH).toBe('/link');
        expect(formatLinkUrl('https://app.ptbk.link', CODE)).toBe(URL_TEXT);
    });

    it.each(['http://app.ptbk.link', 'https://app.ptbk.link/', 'https://app.ptbk.link/x', 'nope'])(
        'refuses %s as an origin',
        (origin) => {
            expect(() => formatLinkUrl(origin, CODE)).toThrow(TypeError);
        },
    );

    it('round-trips through parseLinkUrl for any code', () => {
        fc.assert(
            fc.property(fc.stringMatching(/^[a-z2-7]{25}[aeimquy4]$/), (text) => {
                const linkCode = LinkCode.parse(text);
                expect(parseLinkUrl(formatLinkUrl('https://app.ptbk.test:8444', linkCode))).toEqual({
                    kind: 'ok',
                    dashboardOrigin: 'https://app.ptbk.test:8444',
                    linkCode,
                });
            }),
        );
    });
});
