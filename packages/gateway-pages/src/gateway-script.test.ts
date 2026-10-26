// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { GatewayPage } from './assets';
import { renderGatewayPage } from './render-page';
import type { GatewayPageValues } from './render-page';
import { SAMPLE_CELLS, SAMPLE_VALUES, readPage } from './testing/pages';

// Not a literal, so TypeScript does not look for declarations of a plain browser script.
const GATEWAY_SCRIPT = '../pages/gateway.js';
const SECRET = 'AbCdEfGhIjKlMnOpQrSt_-';
const OPTIONS = { challenge: 'Y2hhbGxlbmdl', rp: { id: 'engine.example' } };
const CREDENTIAL = { id: 'credential', type: 'public-key' };

interface Reply {
    readonly status: number;
    readonly body?: unknown;
}
type Route = Reply | 'network-error' | 'not-json';

interface Request {
    readonly path: string;
    readonly init: RequestInit;
    readonly body: unknown;
}

function fakeEngine(routes: Record<string, Route | Route[]>) {
    const requests: Request[] = [];
    const fetch = vi.fn((path: string, init: RequestInit) => {
        requests.push({ path, init, body: JSON.parse(init.body as string) });
        const configured = routes[path];
        const route = Array.isArray(configured) ? (configured.shift() ?? configured.at(-1)) : configured;
        if (route === undefined) return Promise.reject(new Error(`unexpected ${path}`));
        if (route === 'network-error') return Promise.reject(new TypeError('Failed to fetch'));
        if (route === 'not-json') return Promise.resolve(new Response('<html>', { status: 502 }));
        return Promise.resolve(
            new Response(JSON.stringify(route.body ?? {}), {
                status: route.status,
                headers: { 'Content-Type': route.status < 300 ? 'application/json' : 'application/problem+json' },
            }),
        );
    });
    vi.stubGlobal('fetch', fetch);
    return requests;
}

function fakeWebAuthn(overrides: Partial<Record<'supported' | 'register' | 'authenticate', unknown>> = {}) {
    const webauthn = {
        browserSupportsWebAuthn: vi.fn(() => overrides.supported ?? true),
        startRegistration: vi.fn(() =>
            'register' in overrides ? Promise.reject(overrides.register as Error) : Promise.resolve(CREDENTIAL),
        ),
        startAuthentication: vi.fn(() =>
            'authenticate' in overrides ? Promise.reject(overrides.authenticate as Error) : Promise.resolve(CREDENTIAL),
        ),
    };
    vi.stubGlobal('SimpleWebAuthnBrowser', webauthn);
    return webauthn;
}

async function open(
    page: GatewayPage,
    url: string,
    values: Partial<GatewayPageValues> = {},
    beforeStart: () => void = () => undefined,
) {
    const html = renderGatewayPage(readPage(page), { ...SAMPLE_VALUES, ...values });
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    document.replaceChild(document.importNode(parsed.documentElement, true), document.documentElement);
    history.replaceState(null, '', url);
    beforeStart();
    vi.resetModules();
    await import(GATEWAY_SCRIPT);
}

const shownStates = () =>
    [...document.querySelectorAll<HTMLElement>('section[data-state]')]
        .filter((s) => !s.hidden)
        .map((s) => s.getAttribute('data-state'));

const expectState = (state: string) =>
    vi.waitFor(() => {
        expect(shownStates()).toEqual([state]);
    });

function click(action: string) {
    const button = document.querySelector<HTMLButtonElement>(`section:not([hidden]) button[data-action="${action}"]`);
    if (button === null) throw new Error(`no visible ${action} button`);
    button.click();
}

const nextLinks = () => [...document.querySelectorAll('a[data-next-link]')].map((a) => a.getAttribute('href'));

afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('setup page', () => {
    it('removes the secret from the address bar before anything else', async () => {
        fakeEngine({ '/setup/options': { status: 200, body: { options: OPTIONS } } });
        fakeWebAuthn();
        await open('setup.html', `/setup?from=qr#${SECRET}`);
        expect(location.hash).toBe('');
        expect(location.href).not.toContain(SECRET);
        expect(`${location.pathname}${location.search}`).toBe('/setup?from=qr');
    });

    it('registers the owner: options, passkey, verify, done', async () => {
        const requests = fakeEngine({
            '/setup/options': { status: 200, body: { options: OPTIONS } },
            '/setup/verify': { status: 200, body: { next: '/welcome', unknown: true } },
        });
        const webauthn = fakeWebAuthn();
        await open('setup.html', `/setup#${SECRET}`);
        await expectState('valid');
        const filled = [...document.querySelectorAll('section[data-state="valid"] .fp-cell')].map((cell) =>
            cell.classList.contains('is-filled') ? '1' : '0',
        );
        expect(filled.join('')).toBe(SAMPLE_CELLS);
        expect(document.activeElement).toBe(document.querySelector('section[data-state="valid"] h1'));

        click('create');
        expect(shownStates()).toEqual(['prompt']);
        await expectState('done');
        expect(webauthn.startRegistration).toHaveBeenCalledWith({ optionsJSON: OPTIONS });
        expect(requests.map(({ path, body }) => [path, body])).toEqual([
            ['/setup/options', { secret: SECRET }],
            ['/setup/verify', { secret: SECRET, response: CREDENTIAL }],
        ]);
        for (const { init } of requests) {
            expect(init).toMatchObject({
                method: 'POST',
                credentials: 'same-origin',
                headers: { 'Content-Type': 'application/json' },
                cache: 'no-store',
                redirect: 'error',
            });
        }
        expect(nextLinks()).toEqual(['/welcome']);
        expect(document.documentElement.outerHTML).not.toContain(SECRET);
        expect(document.activeElement).toBe(document.querySelector('section[data-state="done"] h1'));
    });

    it.each([
        [{ status: 403, body: { code: 'setup-link-invalid' } }, 'expired'],
        [{ status: 409, body: { code: 'owner-exists' } }, 'owner-exists'],
        [{ status: 429, body: { code: 'rate-limited' } }, 'rate-limited'],
        [{ status: 500, body: { code: 'internal' } }, 'error'],
        [{ status: 200, body: { options: 'nope' } }, 'error'],
        ['not-json', 'error'],
        ['network-error', 'offline'],
    ] as const)('maps an options answer %j to %s', async (reply, state) => {
        fakeEngine({ '/setup/options': reply });
        fakeWebAuthn();
        await open('setup.html', `/setup#${SECRET}`);
        await expectState(state);
    });

    it.each([
        [{ status: 400, body: { code: 'passkey-not-verified' } }, 'not-verified'],
        [{ status: 403, body: { code: 'setup-link-invalid' } }, 'expired'],
        [{ status: 409, body: { code: 'owner-exists' } }, 'owner-exists'],
        [{ status: 400, body: { code: 'invalid-body' } }, 'error'],
        ['network-error', 'offline'],
    ] as const)('maps a verify answer %j to %s', async (reply, state) => {
        fakeEngine({ '/setup/options': { status: 200, body: { options: OPTIONS } }, '/setup/verify': reply });
        fakeWebAuthn();
        await open('setup.html', `/setup#${SECRET}`);
        await expectState('valid');
        click('create');
        await expectState(state);
    });

    it('opens the engine root when the returned next is not a safe path', async () => {
        fakeEngine({
            '/setup/options': { status: 200, body: { options: OPTIONS } },
            '/setup/verify': { status: 200, body: { next: '//evil.example' } },
        });
        fakeWebAuthn();
        await open('setup.html', `/setup#${SECRET}`);
        await expectState('valid');
        click('create');
        await expectState('done');
        expect(nextLinks()).toEqual(['/']);
    });

    it.each([
        ['no fragment', '/setup'],
        ['an empty fragment', '/setup#'],
        ['a short secret', `/setup#${SECRET.slice(1)}`],
        ['a padded secret', `/setup#${SECRET.slice(2)}==`],
        ['a base64 secret', `/setup#${SECRET.slice(1)}+`],
    ])('asks for the link from the terminal with %s', async (_name, url) => {
        const requests = fakeEngine({});
        fakeWebAuthn();
        await open('setup.html', url);
        await expectState('missing');
        expect(requests).toEqual([]);
    });

    it('says the engine has an owner without sending the secret', async () => {
        const requests = fakeEngine({});
        fakeWebAuthn();
        await open('setup.html', `/setup#${SECRET}`, { owner: 'set' });
        await expectState('owner-exists');
        expect(requests).toEqual([]);
        expect(location.href).not.toContain(SECRET);
    });

    it.each([
        ['NotAllowedError', new DOMException('closed', 'NotAllowedError'), 'cancelled'],
        ['AbortError', new DOMException('aborted', 'AbortError'), 'cancelled'],
        ['a ceremony abort', Object.assign(new Error('aborted'), { code: 'ERROR_CEREMONY_ABORTED' }), 'cancelled'],
        ['a wrapped NotAllowedError', new Error('x', { cause: new DOMException('x', 'NotAllowedError') }), 'cancelled'],
        ['NotSupportedError', new DOMException('no', 'NotSupportedError'), 'unsupported'],
        ['SecurityError', new DOMException('no', 'SecurityError'), 'unsupported'],
        ['InvalidStateError', new DOMException('again', 'InvalidStateError'), 'failed'],
        ['a non-error', 'boom', 'failed'],
    ])('maps %s from the browser', async (_name, error, state) => {
        const requests = fakeEngine({ '/setup/options': { status: 200, body: { options: OPTIONS } } });
        fakeWebAuthn({ register: error });
        await open('setup.html', `/setup#${SECRET}`);
        await expectState('valid');
        click('create');
        await expectState(state);
        expect(requests.map(({ path }) => path)).toEqual(['/setup/options']);
    });

    it('tries again with a fresh challenge', async () => {
        const requests = fakeEngine({
            '/setup/options': [
                { status: 200, body: { options: OPTIONS } },
                { status: 200, body: { options: { ...OPTIONS, challenge: 'c2Vjb25k' } } },
            ],
        });
        const webauthn = fakeWebAuthn({ register: new DOMException('closed', 'NotAllowedError') });
        await open('setup.html', `/setup#${SECRET}`);
        await expectState('valid');
        click('create');
        await expectState('cancelled');
        click('retry');
        await expectState('valid');
        click('create');
        await expectState('cancelled');
        expect(requests.map(({ path }) => path)).toEqual(['/setup/options', '/setup/options']);
        expect(webauthn.startRegistration).toHaveBeenLastCalledWith({
            optionsJSON: { ...OPTIONS, challenge: 'c2Vjb25k' },
        });
    });

    it('ignores a second click while the passkey prompt is open', async () => {
        fakeEngine({ '/setup/options': { status: 200, body: { options: OPTIONS } } });
        const webauthn = fakeWebAuthn();
        webauthn.startRegistration.mockReturnValue(new Promise(() => undefined));
        await open('setup.html', `/setup#${SECRET}`);
        await expectState('valid');
        const button = document.querySelector<HTMLButtonElement>('button[data-action="create"]');
        button?.click();
        button?.click();
        expect(webauthn.startRegistration).toHaveBeenCalledTimes(1);
    });

    it.each([
        ['cannot use WebAuthn', () => fakeWebAuthn({ supported: false })],
        ['lacks the library', () => undefined],
    ])('says so when the browser %s', async (_name, install) => {
        fakeEngine({ '/setup/options': { status: 200, body: { options: OPTIONS } } });
        install();
        await open('setup.html', `/setup#${SECRET}`);
        await expectState('valid');
        click('create');
        await expectState('unsupported');
    });

    it('announces a change when focus is elsewhere, in the page language', async () => {
        fakeEngine({ '/setup/options': { status: 200, body: { options: OPTIONS } } });
        fakeWebAuthn();
        const elsewhere = document.createElement('input');
        await open('setup.html', `/setup#${SECRET}`, { lang: 'cs' }, () => {
            document.body.append(elsewhere);
            elsewhere.focus();
        });
        await expectState('valid');
        expect(document.activeElement).toBe(elsewhere);
        expect(document.querySelector('[data-announcer]')?.textContent).toBe('Nastavte svůj engine');
    });
});

describe('sign-in page', () => {
    const ready = { status: 200, body: { options: OPTIONS } };

    it('signs in and goes to the next page', async () => {
        const requests = fakeEngine({
            '/auth/sign-in/options': ready,
            '/auth/sign-in/verify': { status: 200, body: { next: '/agents/1' } },
        });
        const webauthn = fakeWebAuthn();
        await open('sign-in.html', '/auth/sign-in?next=%2Fagents%2F1', { owner: 'set' });
        await expectState('ready');
        click('confirm');
        await expectState('done');
        expect(webauthn.startAuthentication).toHaveBeenCalledWith({ optionsJSON: OPTIONS });
        expect(requests.map(({ path, body }) => [path, body])).toEqual([
            ['/auth/sign-in/options', {}],
            ['/auth/sign-in/verify', { response: CREDENTIAL, next: '/agents/1' }],
        ]);
        // jsdom cannot navigate, so the location.assign to the same target is left to the Playwright test.
        expect(nextLinks()).toEqual(['/agents/1']);
    });

    it('drops an unsafe next and lets the engine choose', async () => {
        const requests = fakeEngine({
            '/auth/sign-in/options': ready,
            '/auth/sign-in/verify': { status: 200, body: { next: 'https://evil.example/' } },
        });
        fakeWebAuthn();
        await open('sign-in.html', '/auth/sign-in?next=%2F%2Fevil.example', { owner: 'set' });
        await expectState('ready');
        click('confirm');
        await expectState('done');
        expect(requests[1]?.body).toEqual({ response: CREDENTIAL });
        expect(nextLinks()).toEqual(['/']);
    });

    it('says there is no owner yet without asking the engine', async () => {
        const requests = fakeEngine({});
        fakeWebAuthn();
        await open('sign-in.html', '/auth/sign-in', { owner: 'none' });
        await expectState('no-owner');
        expect(requests).toEqual([]);
    });

    it.each([
        [{ status: 401, body: { code: 'passkey-not-recognised' } }, 'not-recognised'],
        [{ status: 400, body: { code: 'passkey-not-verified' } }, 'not-recognised'],
        [{ status: 429 }, 'rate-limited'],
        [{ status: 503 }, 'error'],
        ['network-error', 'offline'],
    ] as const)('maps a verify answer %j to %s', async (reply, state) => {
        fakeEngine({ '/auth/sign-in/options': ready, '/auth/sign-in/verify': reply });
        fakeWebAuthn();
        await open('sign-in.html', '/auth/sign-in', { owner: 'set' });
        await expectState('ready');
        click('confirm');
        await expectState(state);
    });

    it.each([
        [{ status: 429 }, 'rate-limited'],
        ['network-error', 'offline'],
    ] as const)('maps an options answer %j to %s', async (reply, state) => {
        fakeEngine({ '/auth/sign-in/options': reply });
        fakeWebAuthn();
        await open('sign-in.html', '/auth/sign-in', { owner: 'set' });
        await expectState(state);
    });

    it('lets a member try another passkey after a cancelled prompt', async () => {
        fakeEngine({ '/auth/sign-in/options': ready });
        fakeWebAuthn({ authenticate: new DOMException('closed', 'NotAllowedError'), supported: true });
        await open('sign-in.html', '/auth/sign-in', { owner: 'set' });
        await expectState('ready');
        click('confirm');
        await expectState('cancelled');
        click('retry');
        await expectState('ready');
    });

    it('says when the browser cannot use passkeys', async () => {
        fakeEngine({ '/auth/sign-in/options': ready });
        fakeWebAuthn({ supported: false });
        await open('sign-in.html', '/auth/sign-in', { owner: 'set' });
        await expectState('ready');
        click('confirm');
        await expectState('unsupported');
    });
});

describe('step-up page', () => {
    const ready = { status: 200, body: { options: OPTIONS } };

    it('confirms and returns to where the member was', async () => {
        const requests = fakeEngine({
            '/auth/step-up/options': ready,
            '/auth/step-up/verify': { status: 200, body: { next: '/settings/security' } },
        });
        fakeWebAuthn();
        await open('step-up.html', '/auth/step-up?returnTo=%2Fsettings%2Fsecurity', { owner: 'set' });
        await expectState('ready');
        expect(nextLinks()).toEqual(['/settings/security', '/settings/security']);
        click('confirm');
        await expectState('done');
        expect(requests[1]?.body).toEqual({ response: CREDENTIAL, next: '/settings/security' });
    });

    it('sends a signed-out member to sign in and back', async () => {
        fakeEngine({ '/auth/step-up/options': { status: 401, body: { code: 'unauthenticated' } } });
        fakeWebAuthn();
        await open('step-up.html', '/auth/step-up?returnTo=%2Fsettings', { owner: 'set' });
        await expectState('signed-out');
        expect(document.querySelector('a[data-sign-in-link]')?.getAttribute('href')).toBe(
            '/auth/sign-in?next=%2Fsettings',
        );
    });

    it.each([
        [{ status: 401, body: { code: 'unauthenticated' } }, 'signed-out'],
        [{ status: 401, body: { code: 'passkey-not-recognised' } }, 'not-recognised'],
        [{ status: 400 }, 'not-recognised'],
        [{ status: 429 }, 'rate-limited'],
        [{ status: 500 }, 'error'],
        ['network-error', 'offline'],
    ] as const)('maps a verify answer %j to %s', async (reply, state) => {
        fakeEngine({ '/auth/step-up/options': ready, '/auth/step-up/verify': reply });
        fakeWebAuthn();
        await open('step-up.html', '/auth/step-up', { owner: 'set' });
        await expectState('ready');
        click('confirm');
        await expectState(state);
    });

    it('keeps the default links without a safe return address', async () => {
        fakeEngine({ '/auth/step-up/options': ready });
        fakeWebAuthn();
        await open('step-up.html', '/auth/step-up?returnTo=%2Fauth%2Fsign-in', { owner: 'set' });
        await expectState('ready');
        expect(nextLinks()).toEqual(['/', '/']);
        expect(document.querySelector('a[data-sign-in-link]')?.getAttribute('href')).toBe('/auth/sign-in');
    });
});

describe('any page', () => {
    it('does nothing for an unknown page or action', async () => {
        const requests = fakeEngine({});
        fakeWebAuthn();
        const html = renderGatewayPage(readPage('sign-in.html'), SAMPLE_VALUES).replace(
            'data-page="sign-in"',
            'data-page="other"',
        );
        document.replaceChild(
            document.importNode(new DOMParser().parseFromString(html, 'text/html').documentElement, true),
            document.documentElement,
        );
        vi.resetModules();
        await import(GATEWAY_SCRIPT);
        const stray = document.createElement('button');
        stray.setAttribute('data-action', 'constructor');
        document.body.append(stray);
        stray.click();
        document.body.click();
        expect(shownStates()).toEqual(['loading']);
        expect(requests).toEqual([]);
    });
});
