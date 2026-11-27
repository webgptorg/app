import { describe, expect, it } from 'vitest';

import { GATEWAY_PAGES } from './assets';
import { renderGatewayPage } from './render-page';
import type { GatewayPageValues } from './render-page';
import { SAMPLE_VALUES, readPage } from './testing/pages';

describe('renderGatewayPage', () => {
    it('fills every placeholder', () => {
        expect(
            renderGatewayPage('<html lang="{{lang}}"><p>{{command}} on {{hostname}} ({{owner}})</p>', SAMPLE_VALUES),
        ).toBe(`<html lang="en"><p>mock-engine on ${SAMPLE_VALUES.hostname} (none)</p>`);
    });

    it('escapes every value for text and attributes', () => {
        const rendered = renderGatewayPage('<p title="{{engineId}}">{{hostname}}</p>', {
            ...SAMPLE_VALUES,
            engineId: `"'><script>`,
            hostname: `a&b<c>"d'`,
        });
        expect(rendered).toBe('<p title="&quot;&#39;&gt;&lt;script&gt;">a&amp;b&lt;c&gt;&quot;d&#39;</p>');
    });

    it('renders every page with the shared value set', () => {
        for (const page of GATEWAY_PAGES) {
            const rendered = renderGatewayPage(readPage(page), SAMPLE_VALUES);
            expect(rendered).not.toContain('{{');
            expect(rendered).toContain(SAMPLE_VALUES.hostname);
        }
    });

    it('uses the real ptbk operations while keeping the mock CLI', () => {
        for (const page of ['setup.html', 'sign-in.html'] as const) {
            const real = renderGatewayPage(readPage(page), { ...SAMPLE_VALUES, command: 'ptbk' });
            expect(real).toContain('ptbk connect --setup-link');
            expect(real).toContain('ptbk connect --reset-owner');
            expect(real).not.toMatch(/ptbk (?:setup-link|owner --reset)/);
            const mock = renderGatewayPage(readPage(page), SAMPLE_VALUES);
            expect(mock).toContain('mock-engine setup-link');
            expect(mock).toContain('mock-engine owner --reset');
        }
    });

    it('accepts complete recovery commands for a pending initialization and escapes them', () => {
        const prefix = `ptbk connect --onboarding ${SAMPLE_VALUES.engineId}`;
        const html = renderGatewayPage(
            '<code>{{setupLinkCommand}}</code><code>{{resetOwnerCommand}}</code><code>{{statusCommand}}</code>',
            {
                ...SAMPLE_VALUES,
                command: 'ptbk',
                setupLinkCommand: `${prefix} --setup-link`,
                resetOwnerCommand: `${prefix} --reset-owner`,
                statusCommand: `ptbk onboarding --id ${SAMPLE_VALUES.engineId} --json`,
            },
        );
        expect(html).toBe(
            `<code>${prefix} --setup-link</code><code>${prefix} --reset-owner</code><code>ptbk onboarding --id ${SAMPLE_VALUES.engineId} --json</code>`,
        );
        expect(
            renderGatewayPage('{{setupLinkCommand}}', {
                ...SAMPLE_VALUES,
                setupLinkCommand: '<script>',
            }),
        ).toBe('&lt;script&gt;');
    });

    it('refuses an unknown placeholder', () => {
        expect(() => renderGatewayPage('<p>{{secret}}</p>', SAMPLE_VALUES)).toThrow(/Unknown .*\{\{secret\}\}/);
        expect(() => renderGatewayPage('<p>{{ lang }}</p>', SAMPLE_VALUES)).toThrow(/Unknown/);
    });

    it('refuses a stray or nested opening brace pair', () => {
        expect(() => renderGatewayPage('<p>{{lang</p>', SAMPLE_VALUES)).toThrow(/Malformed/);
        expect(() => renderGatewayPage('<p>{{a{{lang}}</p>', SAMPLE_VALUES)).toThrow(/Malformed/);
    });

    it('refuses a missing value', () => {
        const withoutCommand = Object.fromEntries(Object.entries(SAMPLE_VALUES).filter(([name]) => name !== 'command'));
        expect(() => renderGatewayPage('<p></p>', withoutCommand as unknown as GatewayPageValues)).toThrow(
            /"command" is missing/,
        );
    });

    it.each([
        ['lang', { lang: 'de' }],
        ['owner', { owner: 'maybe' }],
        ['fingerprintCells', { fingerprintCells: '1'.repeat(24) }],
        ['fingerprintCells', { fingerprintCells: '2'.repeat(25) }],
    ])('refuses a malformed %s', (name, override) => {
        const values = { ...SAMPLE_VALUES, ...override } as unknown as GatewayPageValues;
        expect(() => renderGatewayPage('<p></p>', values)).toThrow(new RegExp(`"${name}"`));
    });
});
