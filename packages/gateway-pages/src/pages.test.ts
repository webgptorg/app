// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';

import { GATEWAY_ASSETS, GATEWAY_ASSET_PATH, GATEWAY_PAGES } from './assets';
import type { GatewayPage } from './assets';
import { readPackageFile, readPage } from './testing/pages';

const COMMON_STATES = ['loading', 'prompt', 'cancelled', 'unsupported', 'rate-limited', 'failed', 'offline', 'error'];
const EXPECTED: Readonly<Record<GatewayPage, { readonly page: string; readonly states: readonly string[] }>> = {
    'setup.html': {
        page: 'setup',
        states: [...COMMON_STATES, 'valid', 'done', 'expired', 'owner-exists', 'missing', 'not-verified'],
    },
    'sign-in.html': {
        page: 'sign-in',
        states: [...COMMON_STATES, 'checking', 'ready', 'not-recognised', 'no-owner', 'done'],
    },
    'step-up.html': {
        page: 'step-up',
        states: [...COMMON_STATES, 'ready', 'not-recognised', 'signed-out', 'done', 'confirmed'],
    },
    'join.html': {
        page: 'join',
        states: [
            ...COMMON_STATES,
            'valid',
            'waiting',
            'done',
            'declined',
            'missing',
            'invalid',
            'expired',
            'used',
            'already-member',
            'full',
            'not-verified',
        ],
    },
};
const ACTIONS = new Set(['create', 'confirm', 'reopen', 'retry', 'close']);

const parse = (page: GatewayPage) => new DOMParser().parseFromString(readPage(page), 'text/html');
const assetName = (url: string | null) =>
    url?.startsWith(GATEWAY_ASSET_PATH) ? url.slice(GATEWAY_ASSET_PATH.length) : null;

describe.each(GATEWAY_PAGES)('%s', (page) => {
    const source = readPage(page);
    const document = parse(page);
    const elements = [...document.querySelectorAll('*')];

    it('is a page the engine CSP allows: no inline script or style, no handlers', () => {
        expect(document.querySelectorAll('style')).toHaveLength(0);
        for (const element of elements) {
            for (const attribute of element.getAttributeNames()) {
                expect(attribute).not.toBe('style');
                expect(attribute).not.toMatch(/^on/);
            }
        }
        for (const anchor of document.querySelectorAll('a')) {
            expect(anchor.getAttribute('href')).toMatch(/^\/(?![/\\])/);
        }
        expect(source).not.toMatch(/javascript:|<base|<iframe|<form/i);
    });

    it('loads scripts and styles only from the gateway assets', () => {
        const scripts = [...document.querySelectorAll('script')];
        expect(scripts.map((script) => assetName(script.getAttribute('src')))).toEqual([
            'simplewebauthn-browser.umd.min.js',
            'gateway.js',
        ]);
        for (const script of scripts) expect(script.textContent.trim()).toBe('');
        expect(scripts[0]?.hasAttribute('defer')).toBe(true);
        expect(scripts[1]?.getAttribute('type')).toBe('module');
        const links = [...document.querySelectorAll('link')];
        expect(links.map((link) => [link.getAttribute('rel'), assetName(link.getAttribute('href'))])).toEqual([
            ['stylesheet', 'gateway.css'],
        ]);
        for (const url of [...scripts.map((s) => s.getAttribute('src')), ...links.map((l) => l.getAttribute('href'))]) {
            expect(Object.keys(GATEWAY_ASSETS)).toContain(assetName(url));
        }
    });

    it('declares its language, viewport and referrer policy', () => {
        expect(document.documentElement.getAttribute('lang')).toBe('{{lang}}');
        expect(document.querySelector('meta[charset]')?.getAttribute('charset')).toBe('utf-8');
        expect(document.querySelector('meta[name="viewport"]')?.getAttribute('content')).toContain(
            'width=device-width',
        );
        const referrer = document.querySelector('meta[name="referrer"]');
        if (referrer !== null) expect(referrer.getAttribute('content')).toBe('no-referrer');
        expect(document.body.getAttribute('data-page')).toBe(EXPECTED[page].page);
        expect(document.body.getAttribute('data-owner')).toBe('{{owner}}');
    });

    it('has every state, with loading the only one shown first', () => {
        const sections = [...document.querySelectorAll('section[data-state]')];
        expect(sections.map((section) => section.getAttribute('data-state')).sort()).toEqual(
            [...EXPECTED[page].states].sort(),
        );
        expect(
            sections.filter((section) => !section.hasAttribute('hidden')).map((s) => s.getAttribute('data-state')),
        ).toEqual(['loading']);
        expect(document.querySelectorAll('section[data-state] section')).toHaveLength(0);
    });

    it('carries each piece of copy in English and Czech, with a focusable heading per state', () => {
        for (const section of document.querySelectorAll('section[data-state]')) {
            const state = section.getAttribute('data-state') ?? '';
            const english = section.querySelectorAll('[data-lang="en"]');
            const czech = section.querySelectorAll('[data-lang="cs"]');
            expect(english.length, state).toBeGreaterThan(0);
            expect(czech.length, state).toBe(english.length);
            for (const element of [...english, ...czech]) {
                expect(element.textContent.trim(), state).not.toBe('');
                expect(element.parentElement?.closest('[data-lang]'), state).toBeNull();
            }
            const headings = section.querySelectorAll('h1');
            expect(headings, state).toHaveLength(1);
            expect(headings[0]?.getAttribute('tabindex')).toBe('-1');
            expect(headings[0]?.querySelectorAll('[data-lang]')).toHaveLength(2);
        }
        expect(document.querySelectorAll('[data-lang]:not([data-lang="en"]):not([data-lang="cs"])')).toHaveLength(0);
    });

    it('keeps shared copy hidden at first, for states the page has, in English and Czech', () => {
        for (const shared of document.querySelectorAll('[data-shown-in]')) {
            expect(shared.hasAttribute('hidden')).toBe(true);
            expect(shared.closest('section')).toBeNull();
            for (const state of (shared.getAttribute('data-shown-in') ?? '').split(' ')) {
                expect(EXPECTED[page].states).toContain(state);
            }
            const english = shared.querySelectorAll('[data-lang="en"]');
            expect(english.length).toBeGreaterThan(0);
            expect(shared.querySelectorAll('[data-lang="cs"]').length).toBe(english.length);
            expect(shared.querySelectorAll('button, h1')).toHaveLength(0);
        }
    });

    it('wires only known actions and has a live region', () => {
        for (const button of document.querySelectorAll('button')) {
            expect(button.getAttribute('type')).toBe('button');
            expect(ACTIONS.has(button.getAttribute('data-action') ?? '')).toBe(true);
        }
        expect(document.querySelector('[data-announcer]')?.getAttribute('aria-live')).toBe('polite');
    });

    it('draws fingerprint grids of 25 cells coloured by position like packages/ui', () => {
        for (const grid of document.querySelectorAll('[data-fingerprint-cells]')) {
            expect(grid.getAttribute('data-fingerprint-cells')).toBe('{{fingerprintCells}}');
            const cells = [...grid.children];
            expect(cells).toHaveLength(25);
            cells.forEach((cell, index) => {
                const row = Math.floor(index / 5);
                const column = index % 5;
                const tone = ((row + Math.min(column, 4 - column)) % 6) + 1;
                expect(cell.getAttribute('class')).toBe(`fp-cell fp-tone-${String(tone)}`);
                expect(cell.getAttribute('x')).toBe(String(17.5 + column * 6));
                expect(cell.getAttribute('y')).toBe(String(17.5 + row * 6));
            });
        }
    });
});

describe('setup.html', () => {
    it('shows the engine address, ID and fingerprint before the passkey prompt', () => {
        const valid = parse('setup.html').querySelector('section[data-state="valid"]');
        const text = valid?.textContent ?? '';
        expect(text).toContain('https://{{hostname}}');
        expect(text).toContain('{{engineId}}');
        expect(text).toContain('{{fingerprint}}');
        expect(valid?.querySelector('[data-fingerprint-cells]')).not.toBeNull();
        expect(valid?.querySelector('button[data-action="create"]')).not.toBeNull();
    });

    it("uses onboarding.md's English copy", () => {
        const text = parse('setup.html').body.textContent.replace(/\s+/g, ' ');
        for (const copy of [
            'Set up your project',
            'You are about to become the owner of this project. Your passkey stays with you; the project keeps only its public half.',
            'Confirm on your device: fingerprint, face, PIN or security key.',
            'The passkey prompt was closed or timed out. Try again when you are ready.',
            'Sign in from any device with this passkey. To add a device without synced passkeys, use Security in the project.',
            'Setup is done. If you started on the Promptbook dashboard, its tab shows this project as ready by itself; you can close it.',
            'This setup link has expired',
            "Setup links work for 30 minutes. On the project's server, run {{setupLinkCommand}} for a new one.",
            'This project already has an owner',
            'Sign in with your passkey. If you are the owner and lost every passkey, run {{resetOwnerCommand}} on the server.',
            "This page needs the setup link from the project's terminal",
            'This browser cannot create passkeys',
            'Create passkey',
            'Open your project',
            'Try again',
        ]) {
            expect(text).toContain(copy);
        }
    });
});

describe('sign-in.html', () => {
    it('offers ways forward without a passkey here, never a second prompt', () => {
        const document = parse('sign-in.html');
        const ways = document.querySelector('.ways[data-shown-in]');
        expect(ways?.getAttribute('data-shown-in')?.split(' ').sort()).toEqual(
            ['cancelled', 'failed', 'not-recognised', 'ready'].sort(),
        );
        const text = ways?.textContent.replace(/\s+/g, ' ') ?? '';
        for (const copy of [
            'No passkey for this project on this device?',
            "Choose the phone option in the browser's prompt, then confirm on your phone.",
            'Otherwise, sign in on the device where you created it.',
            'Open the project from your Promptbook dashboard: choose Open next to it.',
            'Nemáte na tomto zařízení klíč k tomuto projektu?',
        ]) {
            expect(text).toContain(copy);
        }
        expect(ways?.querySelectorAll('a, button')).toHaveLength(0);
    });
});

describe('join.html', () => {
    it('explains the second passkey and asks for the code to be read out', () => {
        const text = parse('join.html').body.textContent.replace(/\s+/g, ' ');
        for (const copy of [
            'This project has its own secure address, so your browser asks for one more passkey here.',
            'Tell this code to the person approving you',
            'Keep this page open; it signs you in as soon as you are approved.',
            "You're in",
            'Opening the project…',
        ]) {
            expect(text).toContain(copy);
        }
    });

    it('shows the code on its own, large, between the heading and the hint', () => {
        const waiting = parse('join.html').querySelector('section[data-state="waiting"]');
        const code = waiting?.querySelector('[data-join-code]');
        expect(code?.className).toBe('join-code');
        expect(code?.nextElementSibling?.className).toBe('join-code-hint');
        expect(readPackageFile('gateway.css')).toMatch(/\.join-code \{[^}]*font-size: clamp\(/);
    });
});

describe('gateway scripts', () => {
    const BANNED = [
        /innerHTML/,
        /outerHTML/,
        /insertAdjacentHTML/,
        /document\.write/,
        /\beval\b/,
        /\bFunction\s*\(/,
        // A timer with a string body is eval; the only timer allowed is the waiting page's pause, which resolves a promise.
        /setTimeout(?!\(resolve, ms\))|setInterval/,
        /setAttribute/,
        /\.style\b/,
        /\bconsole\./,
        /localStorage|sessionStorage|indexedDB/,
        /document\.cookie/,
        /\bimport\s*\(/,
        /createElement/,
    ];

    it.each(['gateway.js', 'next-path.js'])('%s uses no banned sink or API', (file) => {
        const source = readPackageFile(file);
        for (const pattern of BANNED) expect(source).not.toMatch(pattern);
    });

    it('gateway.js imports only the shared path rule', () => {
        const imports = [...readPackageFile('gateway.js').matchAll(/^import .* from '(.*)';$/gm)].map(
            ([, from]) => from,
        );
        expect(imports).toEqual(['./next-path.js']);
    });
});
