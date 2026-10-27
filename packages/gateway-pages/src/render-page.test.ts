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
