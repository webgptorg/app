import { execFile } from 'node:child_process';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

import type { Browser, BrowserType, Page, Response } from '@playwright/test';
import type { X509Certificate } from 'node:crypto';

import { leafFromCdpChain } from './certificates.ts';
import { fetchText } from './probe.ts';
import { MOUNTS, PEBBLE, PUBLIC_FILES } from './stack.ts';

const run = promisify(execFile);

/**
 * The root of the certificates Pebble issues: new on every Pebble start, so it is fetched from the management API,
 * whose own certificate chains to Pebble's fixed minica (init published it).
 */
export async function pebbleRootPem(): Promise<string> {
    const minica = await readFile(join(MOUNTS.public, PUBLIC_FILES.pebbleMinica), 'utf8');
    const url = `https://${PEBBLE.hostname}:${String(PEBBLE.managementPort)}/roots/0`;
    return fetchText(url, minica, 5_000);
}

export interface TrustingBrowser {
    readonly browser: Browser;
    close(): Promise<void>;
}

/**
 * A Chromium whose NSS database holds `rootPem` and nothing else we added: its HOME is a fresh directory, not pwuser's,
 * whose database the entrypoint gave the dev CA. The sandbox stays on, as for every browser of this suite.
 */
export async function launchTrusting(chromium: BrowserType, rootPem: string): Promise<TrustingBrowser> {
    const home = await mkdtemp(join(tmpdir(), 'ptbk-acme-home-'));
    const nssdb = `sql:${join(home, '.pki', 'nssdb')}`;
    await mkdir(join(home, '.pki', 'nssdb'), { recursive: true });
    await writeFile(join(home, 'root.pem'), rootPem);
    await run('certutil', ['-N', '-d', nssdb, '--empty-password']);
    await run('certutil', ['-A', '-d', nssdb, '-n', 'pebble-root', '-t', 'C,,', '-i', join(home, 'root.pem')]);
    const browser = await chromium.launch({ chromiumSandbox: true, env: { ...process.env, HOME: home } });
    return {
        browser,
        async close() {
            await browser.close();
            await rm(home, { recursive: true, force: true });
        },
    };
}

export interface LoadedPage {
    readonly page: Page;
    readonly response: Response | null;
    /** The certificate Chromium accepted for the page's origin (CDP `Network.getCertificate`). */
    readonly certificate: X509Certificate;
}

/** Opens `url` in a fresh context, so it gets its own connections and TLS sessions, never reused ones. */
export async function loadInNewContext(browser: Browser, url: string): Promise<LoadedPage> {
    const context = await browser.newContext();
    const page = await context.newPage();
    const session = await context.newCDPSession(page);
    await session.send('Network.enable');
    const response = await page.goto(url);
    const { tableNames } = await session.send('Network.getCertificate', { origin: new URL(url).origin });
    return { page, response, certificate: leafFromCdpChain(tableNames) };
}
