import type { ChildProcess } from 'node:child_process';
import { spawn } from 'node:child_process';

export interface EngineExit {
    /** The exit status, or null when a signal ended the process. */
    readonly code: number | null;
    readonly signal: string | null;
    /** Wall-clock milliseconds, as `Date.now()`. */
    readonly at: number;
}

export interface EngineCommand {
    /** Run by `/bin/sh -c`, in its own process group so the whole tree can be stopped. */
    readonly command: string;
    readonly cwd: string;
}

/** The engine under test as a process. Every method is safe to call in any state. */
export interface EngineProcess {
    readonly dataDir: string;
    /** The environment of the current (or next) start. */
    readonly env: Readonly<Record<string, string>>;
    readonly running: boolean;
    /** How often it was started; a restart counts. */
    readonly starts: number;
    /** When the current or last start happened (`Date.now()`), or null before the first. */
    readonly startedAt: number | null;
    /** Every exit so far, oldest first, whether the engine stopped itself or was stopped. */
    readonly exits: readonly EngineExit[];
    start(): Promise<void>;
    /** SIGTERM to the process group, SIGKILL after the grace period; resolves with the exit. */
    stop(): Promise<EngineExit | null>;
    /** Stops, applies `patch` to the environment (`null` removes a variable) and starts again; same data directory. */
    restart(patch?: Readonly<Record<string, string | null>>): Promise<void>;
    /** Resolves with the exit if the process ends on its own within `timeoutMs`, else null. */
    waitForExit(timeoutMs: number, signal?: AbortSignal): Promise<EngineExit | null>;
    /** Everything the engine wrote to stdout and stderr, across starts, capped at the start of the oldest output. */
    logs(): string;
}

export interface EngineProcessOptions {
    readonly command: EngineCommand;
    readonly dataDir: string;
    readonly env: Readonly<Record<string, string>>;
    readonly stopGraceMs?: number;
}

/** The launch contract: an engine exits within 10 s of SIGTERM. */
export const STOP_GRACE_MS = 10_000;
const MAX_LOG_CHARS = 4 * 1024 * 1024;

/** Process groups that are still alive, so an exiting harness can kill them all. */
const liveGroups = new Set<number>();
let exitHookInstalled = false;

function killGroup(pid: number, signal: NodeJS.Signals | 0): boolean {
    try {
        process.kill(-pid, signal);
        return true;
    } catch {
        return false;
    }
}

function groupAlive(pid: number): boolean {
    return killGroup(pid, 0);
}

function installExitHook(): void {
    if (exitHookInstalled) return;
    exitHookInstalled = true;
    // Synchronous on purpose: on `exit` nothing asynchronous runs any more, and a leaked engine would keep a port.
    process.on('exit', () => {
        for (const pid of liveGroups) killGroup(pid, 'SIGKILL');
    });
}

/** Engines this process started whose process group still exists; for tests that assert nothing leaked. */
export function liveEngineGroups(): readonly number[] {
    return [...liveGroups].filter(groupAlive);
}

export function createEngineProcess(options: EngineProcessOptions): EngineProcess {
    installExitHook();
    const grace = options.stopGraceMs ?? STOP_GRACE_MS;
    let env: Record<string, string> = { ...options.env };
    let child: ChildProcess | null = null;
    let lastPid: number | null = null;
    let exited: Promise<EngineExit> | null = null;
    let starts = 0;
    let startedAt: number | null = null;
    const exits: EngineExit[] = [];
    let log = '';

    function append(chunk: Buffer): void {
        log += chunk.toString('utf8');
        if (log.length > MAX_LOG_CHARS) log = log.slice(log.length - MAX_LOG_CHARS);
    }

    async function stop(): Promise<EngineExit | null> {
        const pid = lastPid;
        if (pid === null) return exits.at(-1) ?? null;
        const done = child === null ? null : exited;
        // The shell may be gone while something it started still runs in the group.
        if (done !== null || groupAlive(pid)) {
            killGroup(pid, 'SIGTERM');
            const deadline = Date.now() + grace;
            const timer = setTimeout(() => killGroup(pid, 'SIGKILL'), grace);
            if (done !== null) await done;
            clearTimeout(timer);
            while (groupAlive(pid) && Date.now() < deadline) await delay(25);
            killGroup(pid, 'SIGKILL');
            // Killed members linger until they are reaped; wait so a caller sees the group gone.
            const reaped = Date.now() + 2000;
            while (groupAlive(pid) && Date.now() < reaped) await delay(25);
        }
        liveGroups.delete(pid);
        return exits.at(-1) ?? null;
    }

    const engine: EngineProcess = {
        dataDir: options.dataDir,
        get env() {
            return env;
        },
        get running() {
            return child !== null;
        },
        get starts() {
            return starts;
        },
        get startedAt() {
            return startedAt;
        },
        exits,
        async start() {
            if (child !== null) return;
            const spawned = spawn('/bin/sh', ['-c', options.command.command], {
                cwd: options.command.cwd,
                env,
                detached: true,
                stdio: ['ignore', 'pipe', 'pipe'],
            });
            child = spawned;
            spawned.stdout.on('data', append);
            spawned.stderr.on('data', append);
            exited = new Promise<EngineExit>((resolve) => {
                spawned.once('exit', (code, signal) => {
                    const exit = { code, signal, at: Date.now() };
                    exits.push(exit);
                    if (child === spawned) child = null;
                    resolve(exit);
                });
            });
            await new Promise<void>((resolve, reject) => {
                spawned.once('spawn', resolve);
                spawned.once('error', (error) => {
                    if (child === spawned) child = null;
                    reject(error);
                });
            });
            starts++;
            startedAt = Date.now();
            if (spawned.pid !== undefined) {
                lastPid = spawned.pid;
                liveGroups.add(spawned.pid);
            }
        },
        stop,
        async restart(patch = {}) {
            await stop();
            const removed = new Set(Object.keys(patch).filter((name) => patch[name] === null));
            env = Object.fromEntries([
                ...Object.entries(env).filter(([name]) => !removed.has(name)),
                ...Object.entries(patch).filter((entry): entry is [string, string] => entry[1] !== null),
            ]);
            await engine.start();
        },
        async waitForExit(timeoutMs, signal) {
            const done = exited;
            if (child === null) return exits.at(-1) ?? null;
            if (done === null) return null;
            return Promise.race([done, delay(timeoutMs, signal).then(() => null)]);
        },
        logs: () => log,
    };
    return engine;
}

function delay(ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise((resolve) => {
        const timer = setTimeout(resolve, ms);
        signal?.addEventListener(
            'abort',
            () => {
                clearTimeout(timer);
                resolve();
            },
            { once: true },
        );
    });
}
