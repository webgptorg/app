import { existsSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { createBrowserOpener } from './browser-opener';

// Stand-in launchers, so the tests never open a browser on the machine that runs them.
const LAUNCHERS = { ok: 'true', fails: 'false', missing: 'ptbk-no-such-launcher' };

let dir: string | undefined;
afterEach(async () => {
    if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    dir = undefined;
});

describe('createBrowserOpener', () => {
    it('reports whether the launcher took the URL', async () => {
        expect(await createBrowserOpener('ok', LAUNCHERS)('https://engine.example/setup#secret')).toBe(true);
        expect(await createBrowserOpener('fails', LAUNCHERS)('https://engine.example/setup#secret')).toBe(false);
    });

    it('answers false, without throwing, when the launcher is missing or the platform has none', async () => {
        expect(await createBrowserOpener('missing', LAUNCHERS)('https://engine.example/')).toBe(false);
        expect(await createBrowserOpener('win32')('https://engine.example/')).toBe(false);
    });

    it('passes the URL as one argument, never through a shell', async () => {
        dir = await mkdtemp(join(tmpdir(), 'ptbk-opener-'));
        const planted = join(dir, 'planted');
        expect(
            await createBrowserOpener('ok', LAUNCHERS)(`https://engine.example/#$(touch ${planted});touch ${planted}`),
        ).toBe(true);
        expect(existsSync(planted)).toBe(false);
    });
});
