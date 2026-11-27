// PID 1 of the real engine's container in the dev stack (compose.real-engine.yaml), under compose's `init`. ptbk runs
// its engines as background services, as on a person's machine: `dev:link` runs `ptbk init --prepare-only` in this
// container, which pairs a pending engine and starts its service. This process restarts those services when the
// container starts, copies their logs to its own output (so `dev:stack logs real-engine` shows them) and stops them
// gracefully on SIGTERM. `entrypoint.ts status` prints the engines it knows as JSON for the dev-stack CLI. Only node:
// imports: the engine's image carries none of ours, compose mounts this file.
import { spawnSync } from 'node:child_process';
import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, rmSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** ptbk's shared projects home and its pending initializations (`sharedProjectsRoot`, `onboardingRoot`). */
const PROJECTS = join(homedir(), 'ptbk', 'project');
const PENDING = join(PROJECTS, '.ptbk-onboarding');
const POLL_MS = 1_000;
const MAX_CHUNK = 64 * 1024;

export interface KnownEngine {
    readonly engineId: string;
    /** The onboarding step; `done` once setup created the project. */
    readonly step: string;
    /** The pending initialization's own directory, which keeps its App state. */
    readonly pendingRoot: string;
    /** The project setup created, once `step` is `done`. */
    readonly projectRoot: string | null;
}

/** An onboarding record (`onboarding.json`) as ptbk writes it; null when it is not one. */
export function parseOnboardingRecord(
    text: string,
    directoryName: string,
): { readonly step: string; readonly folder: string | null } | null {
    try {
        const record = JSON.parse(text) as { engineId?: unknown; step?: unknown; folder?: unknown } | null;
        if (record?.engineId !== directoryName || typeof record.step !== 'string') return null;
        return { step: record.step, folder: typeof record.folder === 'string' ? record.folder : null };
    } catch {
        return null;
    }
}

export function knownEngines(): readonly KnownEngine[] {
    if (!existsSync(PENDING)) return [];
    return readdirSync(PENDING, { withFileTypes: true }).flatMap((entry) => {
        if (!entry.isDirectory()) return [];
        const pendingRoot = join(PENDING, entry.name);
        const recordFile = join(pendingRoot, 'onboarding.json');
        if (!existsSync(recordFile)) return [];
        const record = parseOnboardingRecord(readFileSync(recordFile, 'utf8'), entry.name);
        if (record === null) return [];
        const projectRoot = record.step === 'done' && record.folder !== null ? join(PROJECTS, record.folder) : null;
        return [{ engineId: entry.name, step: record.step, pendingRoot, projectRoot }];
    });
}

function serviceRoot(engine: KnownEngine): string {
    return engine.projectRoot ?? engine.pendingRoot;
}

function ptbk(args: readonly string[]): number {
    const result = spawnSync('ptbk', [...args], { stdio: ['ignore', 'inherit', 'inherit'] });
    return result.status ?? 1;
}

/**
 * The container is new, so no engine process from an earlier one is alive: its process records and locks are stale,
 * and a recorded PID could now belong to an unrelated process here, which ptbk would take for a hung engine.
 */
function dropStaleRecords(engine: KnownEngine): void {
    const runtime = join(serviceRoot(engine), '.ptbk');
    for (const file of [join(runtime, 'service', 'process.json'), join(runtime, 'service', 'launch.lock')]) {
        rmSync(file, { force: true, recursive: true });
    }
    rmSync(join(runtime, 'lock.json'), { force: true });
}

function resume(engine: KnownEngine): void {
    dropStaleRecords(engine);
    const code =
        engine.projectRoot === null
            ? ptbk(['onboarding', '--id', engine.engineId, '--resume-service', '--raw'])
            : ptbk(['start', '--path', engine.projectRoot, '--raw', '--no-persist', '--no-dashboard']);
    process.stdout.write(`real-engine: ${engine.engineId} ${engine.step}: resumed with exit code ${String(code)}\n`);
}

function stopAll(): void {
    for (const engine of knownEngines()) {
        if (engine.projectRoot === null) ptbk(['onboarding', '--id', engine.engineId, '--stop', '--raw']);
        else ptbk(['stop', '--path', engine.projectRoot, '--timeout', '20s', '--raw']);
    }
}

/** Copies what the engines' service logs gained since the last look; a rotated (shorter) log starts over. */
class LogFollower {
    readonly #offsets = new Map<string, number>();

    constructor(startAtEnd: boolean) {
        if (startAtEnd) for (const file of this.#files()) this.#offsets.set(file.path, statSync(file.path).size);
    }

    *#files(): Generator<{ readonly path: string; readonly label: string }> {
        for (const engine of knownEngines()) {
            for (const root of [engine.pendingRoot, engine.projectRoot]) {
                if (root === null) continue;
                for (const name of ['supervisor', 'worker']) {
                    const path = join(root, '.ptbk', 'service', `${name}.log`);
                    if (existsSync(path)) yield { path, label: `${engine.engineId.slice(0, 8)} ${name}` };
                }
            }
        }
    }

    poll(): void {
        for (const file of this.#files()) {
            const size = statSync(file.path).size;
            let offset = this.#offsets.get(file.path) ?? 0;
            if (size < offset) offset = 0;
            if (size === offset) continue;
            const length = Math.min(size - offset, MAX_CHUNK);
            const buffer = Buffer.alloc(length);
            const descriptor = openSync(file.path, 'r');
            try {
                readSync(descriptor, buffer, 0, length, offset);
            } finally {
                closeSync(descriptor);
            }
            this.#offsets.set(file.path, offset + length);
            for (const line of buffer.toString('utf8').split('\n')) {
                if (line !== '') process.stdout.write(`[${file.label}] ${line}\n`);
            }
        }
    }
}

function run(): void {
    const engines = knownEngines();
    if (engines.length === 0) process.stdout.write('real-engine: no engine yet; `bun run dev:link <code>` pairs one\n');
    const follower = new LogFollower(true);
    for (const engine of engines) resume(engine);
    const timer = setInterval(() => {
        follower.poll();
    }, POLL_MS);
    const shutdown = (): void => {
        clearInterval(timer);
        stopAll();
        process.exit(0);
    };
    process.once('SIGTERM', shutdown);
    process.once('SIGINT', shutdown);
}

if (import.meta.main) {
    if (process.argv[2] === 'status') {
        process.stdout.write(
            `${JSON.stringify({ engines: knownEngines().map(({ engineId, step }) => ({ engineId, step })) })}\n`,
        );
    } else {
        run();
    }
}
