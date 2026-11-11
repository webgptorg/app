import { spawn } from 'node:child_process';

import type { BrowserOpener } from '../domain/onboarding/setup-link-delivery';

/** A launcher still running after this has handed the URL to a browser that stays in its foreground (xdg-open). */
const SETTLED_MS = 3_000;

const LAUNCHERS: Readonly<Record<string, string>> = { darwin: 'open', linux: 'xdg-open' };

/**
 * `open` on macOS, `xdg-open` on Linux, with the URL as its one argument and no shell, so nothing in the URL is ever
 * interpreted. Not `execFile`: it pipes the launcher's output, and a browser that xdg-open keeps in the foreground
 * would then hold the command open. A launcher that is missing or exits non-zero is a `false`, never an error.
 */
export function createBrowserOpener(
    platform: string,
    launchers: Readonly<Record<string, string>> = LAUNCHERS,
): BrowserOpener {
    const launcher = launchers[platform];
    return (url) => {
        if (launcher === undefined) return Promise.resolve(false);
        return new Promise((resolve) => {
            const child = spawn(launcher, [url], { stdio: 'ignore', detached: true, shell: false });
            let done = false;
            const settle = (opened: boolean): void => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                child.unref();
                resolve(opened);
            };
            const timer = setTimeout(() => {
                settle(true);
            }, SETTLED_MS);
            child.once('error', () => {
                settle(false);
            });
            child.once('exit', (code) => {
                settle(code === 0);
            });
        });
    };
}
