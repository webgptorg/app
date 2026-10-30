import { chmod, lstat, rename, symlink, unlink } from 'node:fs/promises';
import { basename, join } from 'node:path';

import { Findings } from '../../../src/index';
import type { PlatformCheck, PlatformCheckContext } from '../../harness/platform';
import type { LinkedEngine } from '../support';
import { attemptWait, findEngineKey, outputSince, startLinkedEngine } from '../support';
import { SUITE } from './request';

function octal(mode: number): string {
    return (mode & 0o777).toString(8).padStart(3, '0');
}

/** Privacy problems of `path` as the guide defines them: a real file or directory, ours, no group or other access. */
async function privacyFindings(path: string, kind: 'directory' | 'file', label: string): Promise<readonly string[]> {
    const stats = await lstat(path);
    const findings: string[] = [];
    if (stats.isSymbolicLink()) findings.push(`${label} is a symbolic link`);
    else if (kind === 'directory' ? !stats.isDirectory() : !stats.isFile()) findings.push(`${label} is not a ${kind}`);
    if (stats.uid !== process.getuid?.()) findings.push(`${label} is not owned by the engine's user`);
    if ((stats.mode & 0o077) !== 0) {
        findings.push(
            `${label} has mode ${octal(stats.mode)}, accessible by group or others (want 0${kind === 'directory' ? '700' : '600'})`,
        );
    }
    return findings;
}

async function registeredEngine(
    ctx: PlatformCheckContext,
): Promise<{ linked: LinkedEngine; publicKey: string } | string> {
    const linked = await startLinkedEngine(ctx);
    // Up means its first accepted beat: by then it has stored what registering gave it.
    const up = await attemptWait(
        ctx,
        linked,
        'register and send an accepted heartbeat',
        () => linked.dashboard.heartbeats.find((beat) => beat.answer.status < 300),
        ctx.expectations.startTimeoutMs + ctx.expectations.heartbeatIntervalMs,
    );
    if (!up.ok) return up.reason;
    const registration = linked.dashboard.registrations.find((entry) => entry.answer.status === 200);
    return { linked, publicKey: registration?.request?.enginePublicKey ?? '' };
}

export const dataDirPrivate: PlatformCheck = {
    id: 'registration.data-dir.private',
    suite: SUITE,
    title: 'The engine creates PTBK_DATA_DIR itself as a directory owned by its user with mode 0700',
    timeoutMs: (expectations) => expectations.startTimeoutMs * 2 + expectations.heartbeatIntervalMs,
    async run(ctx) {
        const started = await registeredEngine(ctx);
        if (typeof started === 'string') return { kind: 'fail', detail: started };
        const findings = new Findings();
        for (const finding of await privacyFindings(started.linked.engine.dataDir, 'directory', 'PTBK_DATA_DIR')) {
            findings.add(finding);
        }
        return findings.outcome();
    },
};

export const keyFilePrivate: PlatformCheck = {
    id: 'registration.key-file.private',
    suite: SUITE,
    title: 'The file holding the engine key is a regular file under PTBK_DATA_DIR, owned by the engine user, mode 0600',
    timeoutMs: (expectations) => expectations.startTimeoutMs * 2 + expectations.heartbeatIntervalMs,
    async run(ctx) {
        const started = await registeredEngine(ctx);
        if (typeof started === 'string') return { kind: 'fail', detail: started };
        const key = await findEngineKey(started.linked.engine.dataDir, started.publicKey);
        if (key === null) {
            return {
                kind: 'fail',
                detail: 'no file under PTBK_DATA_DIR holds the registered key (as PKCS#8 PEM or DER, a JWK or a raw 32-byte seed)',
            };
        }
        const findings = new Findings();
        for (const finding of await privacyFindings(key.path, 'file', `the key file ${basename(key.path)}`)) {
            findings.add(finding);
        }
        return findings.outcome();
    },
};

interface Loosening {
    readonly name: string;
    /** The path the engine's error must name. */
    readonly path: (dataDir: string, keyPath: string) => string;
    apply(dataDir: string, keyPath: string, spare: string): Promise<void>;
    undo(dataDir: string, keyPath: string, spare: string): Promise<void>;
}

const LOOSENINGS: readonly Loosening[] = [
    {
        name: 'PTBK_DATA_DIR at mode 0755',
        path: (dataDir) => dataDir,
        apply: (dataDir) => chmod(dataDir, 0o755),
        undo: (dataDir) => chmod(dataDir, 0o700),
    },
    {
        name: 'the key file at mode 0640',
        path: (_dataDir, keyPath) => keyPath,
        apply: (_dataDir, keyPath) => chmod(keyPath, 0o640),
        undo: (_dataDir, keyPath) => chmod(keyPath, 0o600),
    },
    {
        name: 'the key file replaced by a symbolic link',
        path: (_dataDir, keyPath) => keyPath,
        async apply(_dataDir, keyPath, spare) {
            await rename(keyPath, spare);
            await symlink(spare, keyPath);
        },
        async undo(_dataDir, keyPath, spare) {
            await unlink(keyPath);
            await rename(spare, keyPath);
        },
    },
];

export const looseModesRefused: PlatformCheck = {
    id: 'registration.key-file.loose-modes-refused',
    suite: SUITE,
    title: 'With PTBK_DATA_DIR or the key file accessible by others, or the key a symbolic link, the engine refuses to start',
    timeoutMs: (expectations) =>
        expectations.startTimeoutMs * (2 + LOOSENINGS.length) + expectations.heartbeatIntervalMs,
    async run(ctx) {
        const started = await registeredEngine(ctx);
        if (typeof started === 'string') return { kind: 'fail', detail: started };
        const { engine, dashboard } = started.linked;
        await engine.stop();
        const key = await findEngineKey(engine.dataDir, started.publicKey);
        if (key === null) return { kind: 'fail', detail: 'no file under PTBK_DATA_DIR holds the registered key' };
        const spare = join(await ctx.tempDir('key'), 'moved-key');
        const findings = new Findings();
        for (const loosening of LOOSENINGS) {
            await loosening.apply(engine.dataDir, key.path, spare);
            const offset = engine.logs().length;
            const startedAt = Date.now();
            try {
                await engine.start();
                const exit = await engine.waitForExit(ctx.expectations.startTimeoutMs, ctx.signal);
                if (exit === null) {
                    findings.add(`${loosening.name}: the engine kept running`);
                    await engine.stop();
                } else if (exit.code === 0 || exit.code === null) {
                    findings.add(
                        `${loosening.name}: the engine exited with ${exit.signal ?? 'status 0'}, not a failure status`,
                    );
                }
                const contacted =
                    dashboard.registrations.some((entry) => entry.at >= startedAt) ||
                    dashboard.heartbeats.some((beat) => beat.at >= startedAt);
                if (contacted) findings.add(`${loosening.name}: the engine contacted the dashboard`);
                const path = loosening.path(engine.dataDir, key.path);
                if (!outputSince(engine, offset).includes(path)) {
                    findings.add(`${loosening.name}: the engine's output does not name ${basename(path)} by its path`);
                }
            } finally {
                await loosening.undo(engine.dataDir, key.path, spare);
            }
        }
        return findings.outcome();
    },
};
