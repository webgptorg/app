// `bun run dev:stack`, `dev:link`, `dev:trust` and `dev:untrust` (X-06): the e2e stack as a person runs it on their
// own machine. Same images and service definitions as the e2e dashboard scenario, plus compose.dev.yaml; state lives
// in the project's named volumes and the dev CA in .dev/pki/, both kept across `down`. `up --engine real` (E-03)
// runs the real engine instead of the mock, from compose.real-engine.yaml, on a stack with no way out. Only node:
// imports.
import { mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { connect } from 'node:net';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';

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
    DEV_COREDNS_DIR,
    DEV_DASHBOARD_ORIGIN,
    DEV_ENGINE_DOMAIN,
    DEV_ENGINE_FILE,
    DEV_ENGINE_SERVICE,
    DEV_ON_DEMAND_PROFILE,
    DEV_PKI_DIR,
    DEV_PORTS,
    DEV_REAL_ENGINE_SERVICE,
    DEV_STACK_NET,
    DEV_STACK_USAGE,
    DEV_SUBNET,
    ENGINE_DIR_VARIABLE,
    STACK_NET_VARIABLE,
    chromiumLaunchLine,
    devLinkUrl,
    devTarget,
    engineCheckoutProblem,
    engineDir,
    engineNetworkMismatch,
    moveStackAddresses,
    nonLoopbackPorts,
    parseDevEngine,
    parseDevStackArgs,
    parseLinkCode,
    parseRealEngineStatus,
    parseReport,
    staleNetwork,
} from './dev-stack-config.ts';
import type { DevEngine, RealEngine } from './dev-stack-config.ts';

const WAIT_TIMEOUT_S = 300;
const ENGINE_COMMAND = ['node', '--enable-source-maps', '/app/main.mjs'] as const;
/** In the real engine's container (compose.real-engine.yaml mounts e2e/real-engine/ there). */
const REAL_ENGINE_SCRIPTS = '/e2e/real-engine';
/** Inside the init container, which mounts the engine's volume and the public one and has no network. */
const REGISTERED_ENGINE_SCRIPT = 'test -f /engine/registration.json && cat /pki/engine.json';

function say(line: string): void {
    process.stdout.write(`dev:stack: ${line}\n`);
}

interface DevContext {
    readonly repoRoot: string;
    readonly e2eDir: string;
    readonly engine: DevEngine;
    readonly target: ComposeTarget;
}

function withEngine(context: DevContext, engine: DevEngine): DevContext {
    return { ...context, engine, target: devTarget(context.e2eDir, engine) };
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
 * .dev/pki/ are the user's; besides this checkout, the key exists only in the stack's engine volume. It reuses the CA until it nears expiry or its
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

/**
 * coredns/ onto the dev stack's addresses, in .dev/coredns/. Files are rewritten in place and only when they changed,
 * so a running resolver's bind mount never points at a removed directory.
 */
async function renderStackDns(context: DevContext): Promise<void> {
    const source = join(context.e2eDir, 'coredns');
    const target = join(context.repoRoot, DEV_COREDNS_DIR);
    const wanted = new Set<string>();
    for (const entry of await readdir(source, { recursive: true, withFileTypes: true })) {
        if (!entry.isFile()) continue;
        const name = relative(source, join(entry.parentPath, entry.name));
        wanted.add(name);
        const text = moveStackAddresses(await readFile(join(source, name), 'utf8'), DEV_STACK_NET);
        const current = await readFile(join(target, name), 'utf8').catch(() => null);
        if (current === text) continue;
        await mkdir(dirname(join(target, name)), { recursive: true });
        await writeFile(join(target, name), text, 'utf8');
    }
    for (const entry of await readdir(target, { recursive: true, withFileTypes: true })) {
        const name = relative(target, join(entry.parentPath, entry.name));
        if (entry.isFile() && !wanted.has(name)) await rm(join(target, name));
    }
}

/** The project's stack network is absent before the first `up` and after `down`: nothing to check then. */
async function assertNetworkCurrent(target: ComposeTarget, engine: DevEngine): Promise<void> {
    const network = `${target.project}_stack`;
    const { code, stdout } = await dockerCapture(
        ['network', 'inspect', network, '--format', '{{range .IPAM.Config}}{{.Subnet}} {{end}}'],
        'ignore',
    );
    const stale = code === 0 ? staleNetwork(stdout, DEV_SUBNET) : null;
    if (stale !== null) throw new Error(stale);
    const internal = await dockerCapture(['network', 'inspect', network, '--format', '{{.Internal}}'], 'ignore');
    const mismatch = internal.code === 0 ? engineNetworkMismatch(internal.stdout, engine) : null;
    if (mismatch !== null) throw new Error(mismatch);
}

async function assertEngineCheckout(): Promise<void> {
    const dir = process.env[ENGINE_DIR_VARIABLE] ?? '';
    const problem = engineCheckoutProblem(dir, await readFile(join(dir, 'package.json'), 'utf8').catch(() => null));
    if (problem !== null) throw new Error(problem);
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

/** The engines the real engine's container holds, from its entrypoint's `status`; empty when it is not running. */
async function realEngines(target: ComposeTarget): Promise<readonly RealEngine[]> {
    const { code, stdout } = await dockerCapture(
        withOnDemand(
            target,
            'exec',
            '-T',
            DEV_REAL_ENGINE_SERVICE,
            'node',
            `${REAL_ENGINE_SCRIPTS}/entrypoint.ts`,
            'status',
        ),
        'ignore',
    );
    return code === 0 ? parseRealEngineStatus(stdout) : [];
}

function sayRealEngine(engine: RealEngine): void {
    say(
        `engine       https://${engine.engineId}.${DEV_ENGINE_DOMAIN}/ (${engine.setUp ? 'set up' : 'setup not finished'})`,
    );
}

/**
 * The isolation check in a one-off copy of the engine's container, with exactly its networks and resolver, before any
 * engine code runs; the engine starts only if it passes.
 */
async function startRealEngine(target: ComposeTarget): Promise<void> {
    say('checking that the engine container reaches the stack and nothing beyond it');
    const isolated = await docker(
        withOnDemand(
            target,
            'run',
            '--rm',
            '--no-deps',
            DEV_REAL_ENGINE_SERVICE,
            'node',
            `${REAL_ENGINE_SCRIPTS}/no-egress.ts`,
        ),
    );
    if (isolated !== 0) throw new Error('the real engine was not started: its container is not isolated (see above)');
    await must(
        withOnDemand(target, 'up', '--detach', '--no-deps', '--no-build', '--force-recreate', DEV_REAL_ENGINE_SERVICE),
    );
    const engines = await realEngines(target);
    if (engines.length === 0) {
        say('no engine linked yet: sign up, create a link code on /engines/new and run the command it shows');
    }
    for (const engine of engines) sayRealEngine(engine);
    say('the real engine has no internet here: model providers and harness installs cannot be reached');
}

async function up(context: DevContext, noSystem: boolean): Promise<void> {
    const { target } = context;
    const relayPort = noSystem ? DEV_PORTS.noSystemRelay : DEV_PORTS.relay;
    process.env['PTBK_DEV_RELAY_PORT'] = String(relayPort);
    if (context.engine === 'real') await assertEngineCheckout();
    await assertNetworkCurrent(target, context.engine);
    const exposed = nonLoopbackPorts(await composeConfig(target));
    if (exposed.length > 0) throw new Error(`refusing to publish beyond 127.0.0.1: ${exposed.join(', ')}`);
    if (!(await stackRunning(target, 'relay-a-net')) && (await portInUse(relayPort))) {
        throw new Error(
            `127.0.0.1:${String(relayPort)} is taken by another program; stop it${noSystem ? '' : ', or use `bun run dev:stack up --no-system`'}`,
        );
    }
    await mkdir(dirname(join(context.repoRoot, DEV_ENGINE_FILE)), { recursive: true });
    await writeFile(join(context.repoRoot, DEV_ENGINE_FILE), `${context.engine}\n`, 'utf8');
    await must(withOnDemand(target, 'build'));
    const ca = await ensureDevCa(context);
    await renderStackDns(context);
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
    if (context.engine === 'real') {
        await startRealEngine(target);
    } else {
        const engineHost = await linkedEngineHost(target);
        if (engineHost === null) {
            say('no engine linked yet: sign up, create a link code on /engines/new and run the command it shows');
        } else {
            await startEngine(target);
            say(`engine       https://${engineHost}/`);
        }
    }
    await printAccess(context, ca, noSystem);
}

interface RegisterReport {
    readonly outcome?: unknown;
    readonly hostname?: unknown;
    readonly reason?: unknown;
}

interface PairingReport {
    readonly outcome?: unknown;
    readonly url?: unknown;
    readonly engineId?: unknown;
    readonly expiresAt?: unknown;
    readonly message?: unknown;
    readonly reason?: unknown;
}

/**
 * The real engine pairs as the dashboard's install command has it, `ptbk init --prepare-only --link`, inside its
 * running container: the link URL goes in on stdin, and `--setup-link --json` brings back the owner's one-time setup
 * link once the engine's address works, which a real install prints in its terminal.
 */
async function linkReal(context: DevContext, code: string): Promise<number> {
    const { target } = context;
    if (!(await stackRunning(target, DEV_REAL_ENGINE_SERVICE))) {
        say(
            "the real engine's container is not running; start it with `bun run dev:stack up --no-system --engine real`",
        );
        return 1;
    }
    const existing = await realEngines(target);
    if (existing.length > 0) {
        say('the engine was already linked, so the code was not used; `bun run dev:stack reset` starts over');
        for (const engine of existing) sayRealEngine(engine);
        return 0;
    }
    const paired = await dockerCapture(
        withOnDemand(
            target,
            'exec',
            '-T',
            DEV_REAL_ENGINE_SERVICE,
            'ptbk',
            'init',
            '--prepare-only',
            '--link-stdin',
            '--setup-link',
            '--json',
            '--no-persist',
            '--raw',
        ),
        'inherit',
        `${devLinkUrl(code)}\n`,
    );
    const report = parseReport(paired.stdout) as PairingReport | null;
    if (paired.code !== 0 || report?.outcome !== 'issued' || typeof report.engineId !== 'string') {
        say(
            `the engine was not linked: ${JSON.stringify(report?.message ?? report?.reason ?? report?.outcome ?? 'no report')}`,
        );
        return 1;
    }
    say(
        `engine linked: https://${report.engineId}.${DEV_ENGINE_DOMAIN}/ (online on the dashboard after its first heartbeat)`,
    );
    say(`setup link   ${String(report.url)}`);
    say(
        `open it once, in the stack's Chrome profile, to become the engine's owner (expires ${String(report.expiresAt)})`,
    );
    return 0;
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
    const report = parseReport(registered.stdout) as RegisterReport | null;
    if (registered.code !== 0 || typeof report?.hostname !== 'string') {
        say(`the engine was not linked: ${JSON.stringify(report?.reason ?? report?.outcome ?? 'no report')}`);
        if ((await linkedEngineHost(target)) !== null) await startEngine(target);
        return 1;
    }
    await startEngine(target);
    if (report.outcome === 'already-registered') {
        say('the engine was already linked, so the code was not used; `bun run dev:stack reset` starts over');
        say(`engine       https://${report.hostname}/`);
    } else {
        say(`engine linked: https://${report.hostname}/ (online on the dashboard after its first heartbeat)`);
        // The dashboard asks for the setup link a real install prints; this engine comes with its owner seeded.
        say('no setup link to open: this engine already has an owner, so sign in there by picking a member');
    }
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
    process.env[STACK_NET_VARIABLE] = DEV_STACK_NET;
    const repoRoot = join(e2eDir, '..');
    process.env[ENGINE_DIR_VARIABLE] = engineDir(process.env, repoRoot);
    try {
        const recorded = parseDevEngine(await readFile(join(repoRoot, DEV_ENGINE_FILE), 'utf8').catch(() => null));
        return await dispatch(
            command,
            args,
            withEngine({ repoRoot, e2eDir, engine: 'mock', target: devTarget(e2eDir) }, recorded),
        );
    } catch (error) {
        process.stderr.write(`dev:stack: ${error instanceof Error ? error.message : 'failed'}\n`);
        return 1;
    }
}

async function dispatch(command: string, args: readonly string[], context: DevContext): Promise<number> {
    switch (command) {
        case 'dev': {
            const parsed = parseDevStackArgs(args);
            if (parsed === null) {
                process.stderr.write(`${DEV_STACK_USAGE}\n`);
                return 2;
            }
            switch (parsed.kind) {
                case 'refused':
                    process.stderr.write(`dev:stack: ${parsed.reason}\n`);
                    return 2;
                case 'up':
                    await up(withEngine(context, parsed.engine), parsed.noSystem);
                    return 0;
                case 'down':
                    await must(withOnDemand(context.target, 'down', '--remove-orphans', '--timeout', '10'));
                    say('stopped; the account, passkeys and linked engine stay for the next `up`');
                    return 0;
                case 'reset':
                    // Every service and volume of either engine, whichever one ran last.
                    await must(
                        withOnDemand(
                            withEngine(context, 'real').target,
                            'down',
                            '--volumes',
                            '--remove-orphans',
                            '--timeout',
                            '10',
                        ),
                    );
                    await rm(join(context.repoRoot, DEV_ENGINE_FILE), { force: true });
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
                process.stderr.write('usage: bun run dev:link <link code or link URL from the dashboard>\n');
                return 2;
            }
            return context.engine === 'real' ? linkReal(context, code) : link(context, code);
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
