// `bun run dev:stack`, `dev:link`, `dev:trust` and `dev:untrust` (X-06): the e2e stack as a person runs it on their
// own machine. Same images and service definitions as the e2e dashboard scenario, plus compose.dev.yaml; state lives
// in the project's named volumes and the dev CA in .dev/pki/, both kept across `down`. Only node: imports.
import { mkdir, readFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join } from 'node:path';

import type { DevCaFacts } from './dev-trust.ts';
import {
    inspectDevCa,
    isTrusted,
    leftovers,
    readTrustState,
    runSteps,
    trustPlan,
    trustPlatform,
    untrustPlan,
} from './dev-trust.ts';
import type { ComposeTarget } from './docker.ts';
import { composeArgs, docker, dockerCapture, must } from './docker.ts';
import {
    DEV_CA_CERT_FILE,
    DEV_CA_DOMAINS,
    DEV_CHROMIUM_PROFILE,
    DEV_DASHBOARD_ORIGIN,
    DEV_ENGINE_SERVICE,
    DEV_ON_DEMAND_PROFILE,
    DEV_PKI_DIR,
    DEV_PORTS,
    DEV_STACK_USAGE,
    chromiumLaunchLine,
    devTarget,
    nonLoopbackPorts,
    parseDevStackArgs,
    parseLinkCode,
} from './dev-stack-config.ts';

const WAIT_TIMEOUT_S = 300;
const ENGINE_COMMAND = ['node', '--enable-source-maps', '/app/main.mjs'] as const;
/** Inside the init container, which mounts the engine's volume and the public one and has no network. */
const REGISTERED_ENGINE_SCRIPT = 'test -f /engine/registration.json && cat /pki/engine.json';

function say(line: string): void {
    process.stdout.write(`dev:stack: ${line}\n`);
}

interface DevContext {
    readonly repoRoot: string;
    readonly target: ComposeTarget;
}

function withOnDemand(target: ComposeTarget, ...args: readonly string[]): readonly string[] {
    return composeArgs(target, '--profile', DEV_ON_DEMAND_PROFILE, ...args);
}

function readCaFacts(repoRoot: string): Promise<DevCaFacts | null> {
    const certFile = join(repoRoot, DEV_CA_CERT_FILE);
    return readFile(certFile, 'utf8').then(
        (pem) => inspectDevCa(certFile, pem),
        () => null,
    );
}

/**
 * The persistent dev CA: the mock engine's own `dev-ca` in a one-off init container, as the host user, so the files in
 * .dev/pki/ are the user's and the key never leaves this checkout. It reuses the CA until it nears expiry or its
 * domains change, as the engine itself would; a new one has to be trusted again.
 */
async function ensureDevCa(context: DevContext): Promise<DevCaFacts> {
    const before = await readCaFacts(context.repoRoot);
    const pkiDir = join(context.repoRoot, DEV_PKI_DIR);
    // Created here, 0700 and the user's own, before compose would create init's bind mount source as anything else.
    await mkdir(join(pkiDir, 'dev-ca'), { recursive: true, mode: 0o700 });
    const user = `${String(process.getuid?.() ?? 1000)}:${String(process.getgid?.() ?? 1000)}`;
    await must(
        composeArgs(
            context.target,
            'run',
            '--rm',
            '--no-deps',
            '--user',
            user,
            '--workdir',
            '/repo/apps/mock-engine',
            '--volume',
            `${pkiDir}:/dev-pki`,
            '--env',
            'HOME=/tmp',
            '--env',
            'PTBK_DATA_DIR=/dev-pki',
            '--env',
            `PTBK_ENGINE_DOMAIN=${DEV_CA_DOMAINS[0] ?? ''}`,
            '--env',
            `MOCK_DEV_CA_DOMAINS=${DEV_CA_DOMAINS.slice(1).join(',')}`,
            'init',
            'bun',
            'run',
            '--silent',
            'dev-ca',
        ),
    );
    const after = await readCaFacts(context.repoRoot);
    if (after === null) throw new Error(`no dev CA at ${DEV_CA_CERT_FILE}`);
    if (before !== null && before.sha256 !== after.sha256) {
        say('the dev CA was replaced (it neared expiry); run `bun run dev:trust` again');
    }
    return after;
}

async function composeConfig(target: ComposeTarget): Promise<unknown> {
    const { code, stdout } = await dockerCapture(withOnDemand(target, 'config', '--format', 'json'));
    if (code !== 0) throw new Error('docker compose config failed');
    return JSON.parse(stdout) as unknown;
}

function portInUse(port: number): Promise<boolean> {
    return new Promise((resolve) => {
        const socket = connect({ host: '127.0.0.1', port });
        socket.setTimeout(1_000);
        socket.once('connect', () => {
            socket.destroy();
            resolve(true);
        });
        socket.once('timeout', () => {
            socket.destroy();
            resolve(false);
        });
        socket.once('error', () => {
            resolve(false);
        });
    });
}

async function stackRunning(target: ComposeTarget, service: string): Promise<boolean> {
    const { stdout } = await dockerCapture(composeArgs(target, 'ps', '--status', 'running', '--quiet', service));
    return stdout.trim() !== '';
}

/** The engine's hostname once it holds a registration, else null. */
async function linkedEngineHost(target: ComposeTarget): Promise<string | null> {
    const { code, stdout } = await dockerCapture(
        composeArgs(target, 'run', '--rm', '--no-deps', '--entrypoint', 'sh', 'init', '-c', REGISTERED_ENGINE_SCRIPT),
    );
    if (code !== 0) return null;
    const hostname = (JSON.parse(stdout) as { hostname?: unknown } | null)?.hostname;
    return typeof hostname === 'string' ? hostname : null;
}

function startEngine(target: ComposeTarget): Promise<void> {
    return must(
        composeArgs(target, 'up', '--detach', '--no-deps', '--no-build', '--force-recreate', DEV_ENGINE_SERVICE),
    );
}

async function printAccess(context: DevContext, ca: DevCaFacts, noSystem: boolean): Promise<void> {
    say(`dashboard    ${DEV_DASHBOARD_ORIGIN}/`);
    say(`dev mailbox  ${DEV_DASHBOARD_ORIGIN}/__dev/mailbox`);
    say(`dev CA       ${DEV_CA_CERT_FILE} (SHA-256 ${ca.sha256})`);
    if (noSystem) {
        say('--no-system: nothing on this machine changed. Open the stack in its own Chrome profile:');
        process.stdout.write(
            `\n  ${chromiumLaunchLine(process.platform, join(context.repoRoot, DEV_CHROMIUM_PROFILE), DEV_PORTS.noSystemRelay)}\n\n`,
        );
        return;
    }
    const platform = trustPlatform(process.platform);
    if (!isTrusted(await readTrustState(platform, homedir()), ca, platform)) {
        say('this machine does not trust the dev CA or resolve the stack yet; once, run `bun run dev:trust`');
        say('(or `bun run dev:stack up --no-system`, which changes nothing on this machine)');
    }
}

async function up(context: DevContext, noSystem: boolean): Promise<void> {
    const { target } = context;
    const relayPort = noSystem ? DEV_PORTS.noSystemRelay : DEV_PORTS.relay;
    process.env['PTBK_DEV_RELAY_PORT'] = String(relayPort);
    const exposed = nonLoopbackPorts(await composeConfig(target));
    if (exposed.length > 0) throw new Error(`refusing to publish beyond 127.0.0.1: ${exposed.join(', ')}`);
    if (!(await stackRunning(target, 'relay-a-net')) && (await portInUse(relayPort))) {
        throw new Error(
            `127.0.0.1:${String(relayPort)} is taken by another program; stop it${noSystem ? '' : ', or use `bun run dev:stack up --no-system`'}`,
        );
    }
    await must(withOnDemand(target, 'build'));
    const ca = await ensureDevCa(context);
    const code = await docker(
        composeArgs(target, 'up', '--detach', '--no-build', '--wait', '--wait-timeout', String(WAIT_TIMEOUT_S)),
    );
    if (code !== 0) {
        if (!noSystem) {
            say(
                `the stack did not start. If Docker could not bind 127.0.0.1:${String(DEV_PORTS.relay)} (Docker Desktop ` +
                    'needs its privileged port helper; OrbStack binds it as is), use `bun run dev:stack up --no-system`.',
            );
        }
        throw new Error('docker compose up failed; `bun run dev:stack logs` shows why');
    }
    const engineHost = await linkedEngineHost(target);
    if (engineHost === null) {
        say('no engine linked yet: sign up, create a link code on /engines/new and run the command it shows');
    } else {
        await startEngine(target);
        say(`engine       https://${engineHost}/`);
    }
    await printAccess(context, ca, noSystem);
}

/** `register --link` in a one-off engine container with the stack's key, then the engine service from that registration. */
async function link(context: DevContext, code: string): Promise<number> {
    const { target } = context;
    if (!(await stackRunning(target, 'dashboard'))) {
        say('the stack is not running; start it with `bun run dev:stack up`');
        return 1;
    }
    // Its fixed address is the service's; a one-off copy beside the running engine could not take it.
    await must(withOnDemand(target, 'stop', DEV_ENGINE_SERVICE));
    const registered = await dockerCapture(
        composeArgs(
            target,
            'run',
            '--rm',
            '--no-deps',
            DEV_ENGINE_SERVICE,
            ...ENGINE_COMMAND,
            'register',
            '--link',
            code,
        ),
    );
    const report = JSON.parse(registered.stdout.trim().split('\n').at(-1) ?? 'null') as {
        outcome?: unknown;
        hostname?: unknown;
        reason?: unknown;
    } | null;
    if (registered.code !== 0 || typeof report?.hostname !== 'string') {
        say(`the engine was not linked: ${JSON.stringify(report?.reason ?? report?.outcome ?? 'no report')}`);
        if ((await linkedEngineHost(target)) !== null) await startEngine(target);
        return 1;
    }
    if (report.outcome === 'already-registered') {
        say('the engine was already linked, so the code was not used; `bun run dev:stack reset` starts over');
    }
    await startEngine(target);
    say(`engine linked: https://${report.hostname}/ (online on the dashboard after its first heartbeat)`);
    return 0;
}

async function trust(context: DevContext, dryRun: boolean): Promise<number> {
    const ca = await readCaFacts(context.repoRoot);
    if (ca === null) {
        process.stderr.write(`dev:trust: no dev CA at ${DEV_CA_CERT_FILE} yet; \`bun run dev:stack up\` creates it\n`);
        return 1;
    }
    const platform = trustPlatform(process.platform);
    const plan = trustPlan(platform, await readTrustState(platform, homedir()), ca, homedir());
    if (plan.kind === 'refused') {
        process.stderr.write(`dev:trust: ${plan.reason}\n`);
        return 1;
    }
    if (plan.steps.length === 0) {
        process.stdout.write('dev:trust: already trusted and resolving; nothing to do\n');
        return 0;
    }
    return (await runSteps(plan.steps, dryRun)) ? 0 : 1;
}

/** Removes what dev:trust added, then checks that nothing is left (also alone, with `--check`). */
async function untrust(dryRun: boolean, checkOnly: boolean): Promise<number> {
    const platform = trustPlatform(process.platform);
    if (!checkOnly) {
        const steps = untrustPlan(platform, await readTrustState(platform, homedir()), homedir());
        if (!(await runSteps(steps, dryRun))) return 1;
        if (dryRun) return 0;
    }
    const left = leftovers(await readTrustState(platform, homedir()));
    for (const problem of left) process.stderr.write(`dev:untrust: ${problem}\n`);
    if (left.length === 0) process.stdout.write('dev:untrust: no dev CA and no resolver entry left on this machine\n');
    return left.length === 0 ? 0 : 1;
}

function onlyFlags(args: readonly string[], allowed: readonly string[]): boolean {
    return args.every((arg) => allowed.includes(arg));
}

/** Entry from cli.ts: `dev …`, `link <code>`, `trust [--dry-run]`, `untrust [--dry-run | --check]`. */
export async function devMain(command: string, args: readonly string[], e2eDir: string): Promise<number> {
    const context: DevContext = { repoRoot: join(e2eDir, '..'), target: devTarget(e2eDir) };
    switch (command) {
        case 'dev': {
            const parsed = parseDevStackArgs(args);
            if (parsed === null) {
                process.stderr.write(`${DEV_STACK_USAGE}\n`);
                return 2;
            }
            switch (parsed.kind) {
                case 'up':
                    await up(context, parsed.noSystem);
                    return 0;
                case 'down':
                    await must(withOnDemand(context.target, 'down', '--remove-orphans', '--timeout', '10'));
                    say('stopped; the account, passkeys and linked engine stay for the next `up`');
                    return 0;
                case 'reset':
                    await must(
                        withOnDemand(context.target, 'down', '--volumes', '--remove-orphans', '--timeout', '10'),
                    );
                    say(`stopped and every volume dropped; the dev CA in ${DEV_PKI_DIR} stays`);
                    return 0;
                case 'logs':
                    return docker(withOnDemand(context.target, 'logs', '--timestamps', ...parsed.services));
            }
            break;
        }
        case 'link': {
            const code = parseLinkCode(args);
            if (code === null) {
                process.stderr.write('usage: bun run dev:link <link code from the dashboard>\n');
                return 2;
            }
            return link(context, code);
        }
        case 'trust':
            if (!onlyFlags(args, ['--dry-run'])) break;
            return trust(context, args.includes('--dry-run'));
        case 'untrust':
            if (!onlyFlags(args, ['--dry-run', '--check']) || args.length > 1) break;
            return untrust(args.includes('--dry-run'), args.includes('--check'));
    }
    process.stderr.write('usage: dev:trust [--dry-run] | dev:untrust [--dry-run | --check]\n');
    return 2;
}
