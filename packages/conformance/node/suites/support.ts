import { createPrivateKey, createPublicKey } from 'node:crypto';
import type { KeyObject } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { LinkCode } from '@ptbk/protocol';

import type { FakeDashboard, FakeDashboardOptions } from '../fakes/dashboard';
import { EngineExited, WaitTimeout, startFakeDashboard, waitWhileRunning } from '../fakes/dashboard';
import type { EngineProcess } from '../harness/engine-process';
import type { LaunchEnv } from '../harness/launch-env';
import type { PlatformCheckContext } from '../harness/platform';

export interface LinkedEngine {
    readonly dashboard: FakeDashboard;
    readonly engine: EngineProcess;
    readonly linkCode: LinkCode;
}

/** A fake dashboard and an engine started with a fresh link code for it; nothing is awaited beyond the spawn. */
export async function startLinkedEngine(
    ctx: PlatformCheckContext,
    dashboardOptions: FakeDashboardOptions = {},
    env: LaunchEnv = {},
): Promise<LinkedEngine> {
    const dashboard = ctx.use(await startFakeDashboard(ctx, dashboardOptions));
    const linkCode = dashboard.issueLinkCode();
    const engine = await ctx.engine({ env: { ...dashboard.env, PTBK_LINK_CODE: linkCode, ...env } });
    await engine.start();
    return { dashboard, engine, linkCode };
}

/** Waits like `waitWhileRunning`, but returns the reason instead of throwing, for checks that collect findings. */
export async function attemptWait<T>(
    ctx: PlatformCheckContext,
    linked: Pick<LinkedEngine, 'dashboard' | 'engine'>,
    what: string,
    select: () => T | undefined,
    timeoutMs?: number,
): Promise<{ readonly ok: true; readonly value: T } | { readonly ok: false; readonly reason: string }> {
    try {
        return {
            ok: true,
            value: await waitWhileRunning(ctx, linked.engine, linked.dashboard, what, select, timeoutMs),
        };
    } catch (error) {
        if (error instanceof WaitTimeout || error instanceof EngineExited) return { ok: false, reason: error.message };
        throw error;
    }
}

/** Lets `ms` pass, for the windows in which something must not happen; ends early when the check is aborted. */
export function quietly(ms: number, signal: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}

/** The engine's output from `offset` on, so a check reads only what one start wrote. */
export function outputSince(engine: EngineProcess, offset: number): string {
    return engine.logs().slice(offset);
}

/** The encodings a secret could leak in: as given, hex, standard base64 (padded or not) and base64url. */
export function secretForms(secret: string | Uint8Array): readonly string[] {
    const bytes = typeof secret === 'string' ? Buffer.from(secret, 'utf8') : Buffer.from(secret);
    const base64 = bytes.toString('base64');
    return [
        ...(typeof secret === 'string' ? [secret] : []),
        bytes.toString('hex'),
        base64,
        base64.replace(/=+$/, ''),
        bytes.toString('base64url'),
    ];
}

const MAX_SCANNED_FILE_BYTES = 1024 * 1024;

/** Every regular file under `dir`, never following a symbolic link. */
export async function regularFiles(dir: string): Promise<readonly string[]> {
    const found: string[] = [];
    for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) found.push(...(await regularFiles(path)));
        else if (entry.isFile()) found.push(path);
    }
    return found.sort();
}

export interface EngineKeyFile {
    readonly path: string;
    /** The private key's 32-byte seed. */
    readonly seed: Buffer;
    /** The PKCS#8 DER, whose base64 is a PEM file's body. */
    readonly pkcs8: Buffer;
}

/**
 * Finds the file under `dataDir` that holds the private half of `enginePublicKey` (base64url): PKCS#8 PEM or DER, a
 * JWK, or the raw 32-byte seed (binary, hex or base64). The guide fixes no file name or format, so the check looks.
 */
export async function findEngineKey(dataDir: string, enginePublicKey: string): Promise<EngineKeyFile | null> {
    for (const path of await regularFiles(dataDir)) {
        const stats = await lstat(path);
        if (stats.size > MAX_SCANNED_FILE_BYTES) continue;
        const content = await readFile(path);
        for (const key of candidateKeys(content)) {
            const jwk = createPublicKey(key).export({ format: 'jwk' });
            if (jwk.x !== enginePublicKey) continue;
            const pkcs8 = key.export({ type: 'pkcs8', format: 'der' });
            return { path, seed: pkcs8.subarray(pkcs8.length - 32), pkcs8 };
        }
    }
    return null;
}

/** The PKCS#8 prefix of an Ed25519 private key (RFC 8410), before the 32-byte seed. */
const ED25519_PKCS8_PREFIX = Buffer.from('302e020100300506032b657004220420', 'hex');

function candidateKeys(content: Buffer): KeyObject[] {
    const keys: KeyObject[] = [];
    const attempt = (make: () => KeyObject): void => {
        try {
            const key = make();
            if (key.asymmetricKeyType === 'ed25519') keys.push(key);
        } catch {
            // Not a key in this format.
        }
    };
    const text = content.toString('utf8');
    for (const block of text.match(/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z ]*PRIVATE KEY-----/g) ??
        []) {
        attempt(() => createPrivateKey(block));
    }
    attempt(() => createPrivateKey({ key: content, format: 'der', type: 'pkcs8' }));
    attempt(() => createPrivateKey({ key: JSON.parse(text) as never, format: 'jwk' }));
    const seeds = [content, Buffer.from(text.trim(), 'hex'), Buffer.from(text.trim(), 'base64')];
    for (const seed of seeds) {
        if (seed.length !== 32) continue;
        attempt(() =>
            createPrivateKey({ key: Buffer.concat([ED25519_PKCS8_PREFIX, seed]), format: 'der', type: 'pkcs8' }),
        );
    }
    return keys;
}
