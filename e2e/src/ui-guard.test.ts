import { describe, expect, it } from 'vitest';

import { emptyGuardReport, guardFindings, isForeignRequest, isPolicyMessage } from './ui-guard.ts';

const ENGINE = 'abc.engine.test';

describe('isForeignRequest', () => {
    it("keeps the engine's own origin and blob URLs it created", () => {
        expect(isForeignRequest(`https://${ENGINE}/api/v1/agents`, ENGINE)).toBe(false);
        expect(isForeignRequest(`blob:https://${ENGINE}/0b0e7c1e`, ENGINE)).toBe(false);
        expect(isForeignRequest('data:image/svg+xml,%3Csvg%2F%3E', ENGINE)).toBe(false);
    });

    it('flags every other origin, scheme or port', () => {
        expect(isForeignRequest('https://attacker.example/?d=secret', ENGINE)).toBe(true);
        expect(isForeignRequest(`http://${ENGINE}/`, ENGINE)).toBe(true);
        expect(isForeignRequest(`https://${ENGINE}:8443/`, ENGINE)).toBe(true);
        expect(isForeignRequest(`https://x.${ENGINE}/`, ENGINE)).toBe(true);
        expect(isForeignRequest('blob:https://attacker.example/1', ENGINE)).toBe(true);
        expect(isForeignRequest('not a url', ENGINE)).toBe(true);
    });
});

describe('isPolicyMessage', () => {
    it("matches Chromium's and Firefox's CSP and Trusted Types reports", () => {
        expect(
            isPolicyMessage(
                'Refused to apply inline style because it violates the following Content Security Policy directive: "style-src \'self\'"',
            ),
        ).toBe(true);
        expect(
            isPolicyMessage('Content-Security-Policy: The page’s settings blocked an inline style (style-src-elem)'),
        ).toBe(true);
        expect(isPolicyMessage("This document requires 'TrustedHTML' assignment.")).toBe(false);
        expect(isPolicyMessage('Failed to set innerHTML: requires Trusted Types')).toBe(true);
        expect(isPolicyMessage('Failed to load resource: the server responded with a status of 500')).toBe(false);
    });
});

describe('guardFindings', () => {
    it('is empty for a clean report and names every finding otherwise', () => {
        expect(guardFindings(emptyGuardReport())).toEqual([]);
        expect(
            guardFindings({
                cspViolations: [{ directive: 'style-src-elem', blockedUri: 'inline', sourceFile: '' }],
                policyMessages: ['Content Security Policy'],
                pageErrors: ['boom'],
                foreignRequests: ['https://attacker.example/'],
                dialogs: ['alert: x'],
            }),
        ).toEqual([
            'CSP violation: style-src-elem blocked inline in (document)',
            'policy message: Content Security Policy',
            'uncaught error: boom',
            'request to another origin: https://attacker.example/',
            'native dialog: alert: x',
        ]);
    });
});
