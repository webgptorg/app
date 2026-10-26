import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { readPackageFile } from './testing/pages';

// By path, not by import: this package must not depend on @ptbk/ui, only stay equal to it.
const uiTheme = (file: string) => readFileSync(new URL(`../../ui/src/theme/${file}`, import.meta.url), 'utf8');

const LIGHT = ':root';
const UI_DARK = '.dark';
const GATEWAY_DARK = '@media (prefers-color-scheme: dark) > :root';
const REDUCED_MOTION = '@media (prefers-reduced-motion: reduce) > :root';

/** Custom properties by the chain of selectors and at-rules they are declared in. */
function customProperties(css: string): Map<string, Map<string, string>> {
    const contexts = new Map<string, Map<string, string>>();
    const stack: string[] = [];
    let buffer = '';
    const declare = () => {
        const match = /^\s*(--[\w-]+)\s*:\s*([\s\S]*?)\s*$/.exec(buffer);
        buffer = '';
        if (match === null) return;
        const [, name = '', value = ''] = match;
        const context = stack.join(' > ');
        const properties = contexts.get(context) ?? new Map<string, string>();
        properties.set(name, value.replace(/\s+/g, ' '));
        contexts.set(context, properties);
    };
    for (const character of css.replace(/\/\*[\s\S]*?\*\//g, '')) {
        if (character === '{') {
            stack.push(buffer.trim().replace(/\s+/g, ' '));
            buffer = '';
        } else if (character === '}') {
            declare();
            stack.pop();
        } else if (character === ';') declare();
        else buffer += character;
    }
    return contexts;
}

const merge = (...maps: (Map<string, string> | undefined)[]) =>
    new Map(maps.flatMap((map) => [...(map ?? new Map<string, string>())]));

const gatewayCss = readPackageFile('gateway.css');
const gateway = customProperties(gatewayCss);
const primitives = customProperties(uiTheme('primitives.css'));
const semantic = customProperties(uiTheme('semantic.css'));

describe('gateway.css design tokens', () => {
    it('defines tokens only in the light, dark and reduced-motion blocks', () => {
        expect([...gateway.keys()].sort()).toEqual([LIGHT, GATEWAY_DARK, REDUCED_MOTION].sort());
    });

    it("equals packages/ui's light tokens, primitives and semantics", () => {
        const ui = merge(primitives.get(LIGHT), semantic.get(LIGHT));
        expect(ui.size).toBeGreaterThan(100);
        expect(Object.fromEntries(gateway.get(LIGHT) ?? [])).toEqual(Object.fromEntries(ui));
    });

    it("equals packages/ui's dark tokens", () => {
        const ui = semantic.get(UI_DARK);
        expect(ui?.size).toBeGreaterThan(20);
        expect(Object.fromEntries(gateway.get(GATEWAY_DARK) ?? [])).toEqual(Object.fromEntries(ui ?? []));
    });

    it("equals packages/ui's reduced-motion overrides", () => {
        const ui = semantic.get(REDUCED_MOTION);
        expect(ui?.size).toBeGreaterThan(0);
        expect(Object.fromEntries(gateway.get(REDUCED_MOTION) ?? [])).toEqual(Object.fromEntries(ui ?? []));
    });

    it('styles the pages through semantic tokens only, each of them defined', () => {
        const pageStyles = gatewayCss.slice(gatewayCss.indexOf('/* Pages.'));
        expect(pageStyles.length).toBeGreaterThan(0);
        const used = [...pageStyles.matchAll(/var\((--[\w-]+)\)/g)].map(([, name]) => name);
        expect(used.filter((name) => name?.startsWith('--ptbk-'))).toEqual([]);
        const defined = gateway.get(LIGHT) ?? new Map<string, string>();
        expect(used.filter((name) => name === undefined || !defined.has(name))).toEqual([]);
    });
});
