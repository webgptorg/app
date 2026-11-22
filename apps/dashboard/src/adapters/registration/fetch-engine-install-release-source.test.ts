import { describe, expect, it, vi } from 'vitest';

import { TEST_ENGINE_INSTALLATION } from '../../testing/install-fixtures';
import { installationOptions } from '../../domain/registration/installation-options';
import { createFetchEngineInstallReleaseSource } from './fetch-engine-install-release-source';

const VERSION = '0.119.0-125';
const SHA = 'b'.repeat(64);
const signal = new AbortController().signal;

function published(version = VERSION) {
    return {
        tag_name: `v${version}`,
        draft: false,
        published_at: '2026-11-20T09:17:27Z',
        assets: [{ name: `Promptbook-Setup-${version}-windows-x64.exe`, state: 'uploaded', digest: `sha256:${SHA}` }],
    };
}

function source(responses: readonly (Response | Error)[]) {
    const calls: { readonly url: string; readonly init: RequestInit }[] = [];
    const releases = createFetchEngineInstallReleaseSource({
        fetch(url, init) {
            calls.push({ url, init });
            const response = responses[calls.length - 1];
            if (response instanceof Error) return Promise.reject(response);
            if (response === undefined) return Promise.reject(new Error('unexpected metadata request'));
            return Promise.resolve(response);
        },
    });
    return { releases, calls };
}

describe('published engine installation releases', () => {
    it('promotes the npm latest version only with its published Windows digest, retaining the pinned bootstrap', async () => {
        const { releases, calls } = source([
            Response.json({ name: 'ptbk', version: VERSION, ignored: 'upstream metadata' }),
            Response.json(published()),
        ]);
        const release = await releases.current(TEST_ENGINE_INSTALLATION, signal);
        expect(release).toEqual({ ...TEST_ENGINE_INSTALLATION, version: VERSION, windowsSha256: SHA });
        expect(calls.map((call) => call.url)).toEqual([
            'https://registry.npmjs.org/ptbk/latest',
            `https://api.github.com/repos/webgptorg/promptbook/releases/tags/v${VERSION}`,
        ]);
        for (const call of calls) {
            expect(call.init.redirect).toBe('manual');
            expect(call.init.signal).toBeInstanceOf(AbortSignal);
            expect(call.init.headers).not.toHaveProperty('Authorization');
            expect(call.init.headers).not.toHaveProperty('Cookie');
        }
        const options = installationOptions(release, 'https://app.ptbk.io/link#example');
        expect(JSON.stringify(options)).toContain(VERSION);
        expect(JSON.stringify(options)).not.toContain(TEST_ENGINE_INSTALLATION.version);
        expect(options.find((option) => option.kind === 'download')).toMatchObject({ version: VERSION, sha256: SHA });
    });

    it.each(['0.119.0-117', '0.119.0-118', '0.119.0-119'])(
        'keeps the configured release when npm is equal or behind it (%s)',
        async (version) => {
            const fallback = { ...TEST_ENGINE_INSTALLATION, version: '0.119.0-119' };
            const { releases, calls } = source([Response.json({ name: 'ptbk', version })]);
            expect(await releases.current(fallback, signal)).toBe(fallback);
            expect(calls).toHaveLength(1);
        },
    );

    it.each(['0.119.0', '0.120.0-1', '0.120.0', '1.0.0'])(
        'follows later stable and prerelease lines without a Dashboard version bump (%s)',
        async (version) => {
            const { releases } = source([Response.json({ name: 'ptbk', version }), Response.json(published(version))]);
            expect((await releases.current(TEST_ENGINE_INSTALLATION, signal)).version).toBe(version);
        },
    );

    it.each([
        { name: 'another-package', version: VERSION },
        { name: 'ptbk', version: 'latest' },
        { name: 'ptbk', version: '0.114.0-51' },
        { name: 'ptbk', version: '0.119.0-116' },
        { name: 'ptbk', version: '0.119.0-0125' },
        { name: 'ptbk', version: '0.120.0+build.1' },
        { name: 'ptbk', version: '0.119.0-125\n' },
        { name: 'ptbk', version: '0.119.0-125; echo injected' },
        { name: 'ptbk' },
    ])('ignores malformed, unsupported or hostile npm metadata: %o', async (metadata) => {
        const { releases, calls } = source([Response.json(metadata)]);
        expect(await releases.current(TEST_ENGINE_INSTALLATION, signal)).toBe(TEST_ENGINE_INSTALLATION);
        expect(calls).toHaveLength(1);
    });

    it.each([
        { ...published(), tag_name: 'v0.119.0-124' },
        { ...published(), draft: true },
        { ...published(), published_at: null },
        { ...published(), assets: [] },
        { ...published(), assets: [{ ...published().assets[0], digest: null }] },
        { ...published(), assets: [{ ...published().assets[0], digest: 'sha256:wrong' }] },
        { ...published(), assets: [{ ...published().assets[0], state: 'new' }] },
        { ...published(), assets: [{ ...published().assets[0], name: 'another.exe' }] },
        { ...published(), assets: [...published().assets, ...published().assets] },
    ])('keeps the coherent configured release while publication is incomplete: %o', async (release) => {
        const { releases } = source([Response.json({ name: 'ptbk', version: VERSION }), Response.json(release)]);
        expect(await releases.current(TEST_ENGINE_INSTALLATION, signal)).toBe(TEST_ENGINE_INSTALLATION);
    });

    it.each([
        new Error('offline'),
        new Response('', { status: 429 }),
        new Response('not json'),
        new Response(null, { status: 302, headers: { Location: 'https://registry.example/ptbk/latest' } }),
    ])('keeps the configured release when npm cannot be read (%o)', async (response) => {
        const { releases } = source([response]);
        expect(await releases.current(TEST_ENGINE_INSTALLATION, signal)).toBe(TEST_ENGINE_INSTALLATION);
    });

    it.each([
        new Error('offline'),
        new Response('', { status: 404 }),
        new Response('not json'),
        new Response(null, { status: 301, headers: { Location: 'https://releases.example/v0.119.0-125' } }),
    ])('keeps the configured release when GitHub cannot be read (%o)', async (response) => {
        const { releases } = source([Response.json({ name: 'ptbk', version: VERSION }), response]);
        expect(await releases.current(TEST_ENGINE_INSTALLATION, signal)).toBe(TEST_ENGINE_INSTALLATION);
    });

    it('bounds metadata response sizes', async () => {
        const { releases } = source([new Response(' '.repeat(512 * 1024 + 1))]);
        expect(await releases.current(TEST_ENGINE_INSTALLATION, signal)).toBe(TEST_ENGINE_INSTALLATION);
    });

    it('falls back when a successful HTTP response has no registry document', async () => {
        const { releases } = source([new Response(null)]);
        expect(await releases.current(TEST_ENGINE_INSTALLATION, signal)).toBe(TEST_ENGINE_INSTALLATION);
    });

    it('does not turn caller cancellation into a stale installation response', async () => {
        const cancelled = AbortSignal.abort(new Error('request cancelled'));
        const { releases, calls } = source([]);
        await expect(releases.current(TEST_ENGINE_INSTALLATION, cancelled)).rejects.toThrow('request cancelled');
        expect(calls).toHaveLength(0);
    });

    it('uses one deadline for both metadata requests and falls back on timeout', async () => {
        const deadline = AbortSignal.abort(new Error('deadline'));
        const timeout = vi.spyOn(AbortSignal, 'timeout').mockReturnValueOnce(deadline);
        try {
            const { releases, calls } = source([]);
            expect(await releases.current(TEST_ENGINE_INSTALLATION, signal)).toBe(TEST_ENGINE_INSTALLATION);
            expect(timeout).toHaveBeenCalledWith(10_000);
            expect(calls).toHaveLength(0);
        } finally {
            timeout.mockRestore();
        }
    });

    it('resolves again on the next issuance rather than keeping the deployment version forever', async () => {
        const { releases } = source([
            Response.json({ name: 'ptbk', version: VERSION }),
            Response.json(published()),
            Response.json({ name: 'ptbk', version: '0.119.0-126' }),
            Response.json(published('0.119.0-126')),
        ]);
        expect((await releases.current(TEST_ENGINE_INSTALLATION, signal)).version).toBe(VERSION);
        expect((await releases.current(TEST_ENGINE_INSTALLATION, signal)).version).toBe('0.119.0-126');
    });
});
