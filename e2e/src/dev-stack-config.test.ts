import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import {
    DEV_CA_DOMAINS,
    DEV_DASHBOARD_ORIGIN,
    DEV_PORTS,
    DEV_PROJECT,
    chromiumArgs,
    chromiumLaunchLine,
    devLinkUrl,
    devTarget,
    engineCheckoutProblem,
    engineDir,
    engineNetworkMismatch,
    nonLoopbackPorts,
    parseDevEngine,
    parseDevStackArgs,
    parseLinkCode,
    parseRealEngineStatus,
} from './dev-stack-config.ts';
import { projectName } from './cli.ts';

const E2E_DIR = join(import.meta.dirname, '..');
const devOverlay = readFileSync(join(E2E_DIR, 'compose.dev.yaml'), 'utf8');
const hostCorefile = readFileSync(join(E2E_DIR, 'coredns', 'Corefile.host'), 'utf8');

describe('the dev stack target', () => {
    it('is its own project over the dashboard scenario, apart from every checkout’s e2e project', () => {
        const target = devTarget('/repo/e2e');
        expect(target).toMatchObject({
            project: 'ptbk-dev',
            overlays: ['dashboard', 'dev'],
            onDemand: ['mock-engine'],
        });
        expect(projectName('/work/app', {})).not.toBe(DEV_PROJECT);
    });
});

describe('compose.dev.yaml and Corefile.host', () => {
    it('publish exactly the ports dev-stack-config.ts names, on 127.0.0.1', () => {
        expect(devOverlay).toContain(`127.0.0.1:\${PTBK_DEV_RELAY_PORT:-${String(DEV_PORTS.relay)}}:443`);
        expect(devOverlay).toContain(`127.0.0.1:${String(DEV_PORTS.dashboard)}:${String(DEV_PORTS.dashboard)}`);
        expect(devOverlay).toContain(`127.0.0.1:${String(DEV_PORTS.dns)}:53/udp`);
        expect(devOverlay).toContain(`127.0.0.1:${String(DEV_PORTS.dns)}:53/tcp`);
        expect(devOverlay).toContain(`DASHBOARD_ORIGIN: ${DEV_DASHBOARD_ORIGIN}`);
        expect(devOverlay.match(/https:\/\/app\.ptbk\.test[:\d]*/g)?.every((url) => url === DEV_DASHBOARD_ORIGIN)).toBe(
            true,
        );
    });

    it('keep the dashboard’s production heartbeat timing, so an engine beating every 60 s stays online', () => {
        const vars = /DASHBOARD_VARS: >-\n((?:\s{8}.+\n)+)/.exec(devOverlay)?.[1];
        expect(vars).toBeDefined();
        expect(Object.keys(JSON.parse(vars ?? '') as object)).not.toContain('HEARTBEAT');
    });

    it('answer 127.0.0.1 to the host for the dashboard and every engine, nothing else', () => {
        expect(hostCorefile).toContain('127.0.0.1 app.ptbk.test');
        expect(hostCorefile).toContain('answer "{{ .Name }} 5 IN A 127.0.0.1"');
        for (const domain of DEV_CA_DOMAINS) expect(hostCorefile).toContain(`${domain}:53 {`);
        expect(hostCorefile).toContain('rcode REFUSED');
    });

    it('never publish a port beyond loopback, in any compose file', () => {
        const files = readdirSync(E2E_DIR).filter((name) => /^compose(\..+)?\.yaml$/.test(name));
        expect(files).toContain('compose.dev.yaml');
        for (const file of files) {
            const lines = readFileSync(join(E2E_DIR, file), 'utf8').split('\n');
            lines.forEach((line, index) => {
                if (!/^\s+ports:\s*$/.test(line)) return;
                for (const entry of lines.slice(index + 1)) {
                    if (!/^\s+- /.test(entry)) break;
                    expect(entry.trim(), file).toMatch(/^- 127\.0\.0\.1:/);
                }
            });
        }
    });
});

describe('the dev CA key', () => {
    it('stays out of every image the stacks build', () => {
        const dashboardIgnore = readFileSync(
            join(E2E_DIR, '..', 'apps', 'dashboard', 'Dockerfile.dev.dockerignore'),
            'utf8',
        );
        expect(dashboardIgnore.split('\n')).toContain('.dev');
        const stackIgnore = readFileSync(join(E2E_DIR, 'docker', 'stack.Dockerfile.dockerignore'), 'utf8').split('\n');
        expect(stackIgnore.find((line) => !line.startsWith('#'))).toBe('*');
        expect(stackIgnore.filter((line) => line.startsWith('!.dev'))).toEqual([]);
    });
});

describe('nonLoopbackPorts', () => {
    it('names every published port of a merged config that is not on 127.0.0.1', () => {
        const config = {
            services: {
                dashboard: { ports: [{ host_ip: '127.0.0.1', target: 8444, published: '8444' }] },
                leaky: {
                    ports: [
                        { target: 443, published: '443' },
                        { host_ip: '0.0.0.0', target: 80 },
                    ],
                },
                quiet: {},
            },
        };
        expect(nonLoopbackPorts(config)).toEqual(['leaky:443', 'leaky:80']);
        expect(nonLoopbackPorts({ services: { dashboard: config.services.dashboard } })).toEqual([]);
        expect(() => nonLoopbackPorts({})).toThrow('not a compose config');
    });
});

describe('parseDevStackArgs', () => {
    it('reads the four commands', () => {
        expect(parseDevStackArgs(['up'])).toEqual({ kind: 'up', noSystem: false, engine: 'mock' });
        expect(parseDevStackArgs(['up', '--no-system'])).toEqual({ kind: 'up', noSystem: true, engine: 'mock' });
        expect(parseDevStackArgs(['down'])).toEqual({ kind: 'down' });
        expect(parseDevStackArgs(['reset'])).toEqual({ kind: 'reset' });
        expect(parseDevStackArgs(['logs', 'dashboard', 'relay-a'])).toEqual({
            kind: 'logs',
            services: ['dashboard', 'relay-a'],
        });
    });

    it('refuses anything else', () => {
        expect(parseDevStackArgs([])).toBeNull();
        expect(parseDevStackArgs(['start'])).toBeNull();
        expect(parseDevStackArgs(['up', '--yes'])).toBeNull();
        expect(parseDevStackArgs(['down', '--volumes'])).toBeNull();
        expect(parseDevStackArgs(['logs', '--follow;rm'])).toBeNull();
    });

    it('picks the engine with --engine, the mock unless told otherwise', () => {
        const real = { kind: 'up', noSystem: true, engine: 'real' };
        expect(parseDevStackArgs(['up', '--no-system', '--engine', 'real'])).toEqual(real);
        expect(parseDevStackArgs(['up', '--engine=real', '--no-system'])).toEqual(real);
        expect(parseDevStackArgs(['up', '--engine', 'mock'])).toEqual({ kind: 'up', noSystem: false, engine: 'mock' });
    });

    it('refuses an unknown or repeated engine, and the real one without --no-system', () => {
        expect(parseDevStackArgs(['up', '--no-system', '--engine'])).toBeNull();
        expect(parseDevStackArgs(['up', '--no-system', '--engine', 'other'])).toBeNull();
        expect(parseDevStackArgs(['up', '--no-system', '--engine', 'real', '--engine', 'mock'])).toBeNull();
        expect(parseDevStackArgs(['up', '--no-system', '--no-system'])).toBeNull();
        expect(parseDevStackArgs(['up', '--engine', 'real'])).toMatchObject({
            kind: 'refused',
            reason: expect.stringContaining('--engine real needs --no-system') as unknown,
        });
    });
});

describe('the engine the dev stack runs', () => {
    it('adds the real-engine overlay and service only for the real engine', () => {
        expect(devTarget('/repo/e2e', 'mock')).toEqual(devTarget('/repo/e2e'));
        expect(devTarget('/repo/e2e', 'real')).toMatchObject({
            project: 'ptbk-dev',
            overlays: ['dashboard', 'dev', 'real-engine'],
            onDemand: ['real-engine'],
        });
    });

    it('is the mock unless .dev/engine says real', () => {
        expect(parseDevEngine('real\n')).toBe('real');
        expect(parseDevEngine('mock\n')).toBe('mock');
        expect(parseDevEngine(null)).toBe('mock');
        expect(parseDevEngine('Real')).toBe('mock');
    });

    it('needs a stack network made for it: internal for the real engine, not for the mock', () => {
        expect(engineNetworkMismatch('true\n', 'real')).toBeNull();
        expect(engineNetworkMismatch('false\n', 'mock')).toBeNull();
        expect(engineNetworkMismatch('', 'real')).toBeNull();
        expect(engineNetworkMismatch('false', 'real')).toContain('still set up for the mock engine');
        expect(engineNetworkMismatch('true', 'mock')).toContain('still set up for the real engine');
    });

    it('comes from PTBK_ENGINE_DIR, or the sibling ../promptbook checkout', () => {
        expect(engineDir({}, '/work/app')).toBe('/work/promptbook');
        expect(engineDir({ PTBK_ENGINE_DIR: '' }, '/work/app')).toBe('/work/promptbook');
        expect(engineDir({ PTBK_ENGINE_DIR: '../engine' }, '/work/app')).toBe('/work/engine');
        expect(engineDir({ PTBK_ENGINE_DIR: '/src/ptbk' }, '/work/app')).toBe('/src/ptbk');
    });

    it('is built only from a ptbk checkout with a conformance build', () => {
        const ptbk = JSON.stringify({ name: 'ptbk', scripts: { 'build:conformance': 'node scripts/build.mjs' } });
        expect(engineCheckoutProblem('/e', ptbk)).toBeNull();
        expect(engineCheckoutProblem('/e', null)).toContain('/e has no package.json; set PTBK_ENGINE_DIR');
        expect(engineCheckoutProblem('/e', JSON.stringify({ name: 'other' }))).toContain('not the ptbk package');
        expect(engineCheckoutProblem('/e', JSON.stringify({ name: 'ptbk', scripts: {} }))).toContain(
            'no build:conformance script',
        );
        expect(engineCheckoutProblem('/e', '{')).toContain('is not JSON');
    });

    it('reads the engines the real engine’s container reports, and nothing malformed', () => {
        const status = JSON.stringify({
            engines: [
                { engineId: 'abc123', step: 'intent' },
                { engineId: 'def456', step: 'done' },
                { engineId: '../etc', step: 'done' },
                { step: 'done' },
            ],
        });
        expect(parseRealEngineStatus(`noise\n${status}\n`)).toEqual([
            { engineId: 'abc123', setUp: false },
            { engineId: 'def456', setUp: true },
        ]);
        expect(parseRealEngineStatus('')).toEqual([]);
        expect(parseRealEngineStatus('{"engines":{}}')).toEqual([]);
    });

    it('pairs the real engine from the whole link URL, which a bare code becomes', () => {
        const code = 'abcdefghijklmnopqrstuvwxya';
        expect(devLinkUrl(code)).toBe(`${DEV_DASHBOARD_ORIGIN}/link#${code}`);
        expect(devLinkUrl(`${DEV_DASHBOARD_ORIGIN}/link#${code}`)).toBe(`${DEV_DASHBOARD_ORIGIN}/link#${code}`);
    });
});

/** One top-level entry of a compose file's `services:`, as text up to the next one. */
function serviceBlock(compose: string, service: string): string {
    const start = compose.indexOf(`\n  ${service}:\n`);
    if (start < 0) throw new Error(`no service ${service}`);
    const rest = compose.slice(start + 1);
    const end = rest.slice(1).search(/\n {2}[a-z][a-z-]*:\n|\n[a-z]/);
    return end < 0 ? rest : rest.slice(0, end + 1);
}

describe('compose.real-engine.yaml', () => {
    const overlay = readFileSync(join(E2E_DIR, 'compose.real-engine.yaml'), 'utf8');
    const engine = serviceBlock(overlay, 'real-engine');

    it('puts the engine on the stack network alone, made internal, with the stack’s resolver and no port', () => {
        expect(overlay).toMatch(/\nnetworks:\n {2}stack:\n {4}internal: true\n/);
        expect(engine).toMatch(/\n {4}networks:\n {6}- stack\n/);
        expect(engine).not.toContain('host-access');
        expect(engine).not.toContain('ports:');
        expect(engine).not.toContain('network_mode');
        expect(engine).not.toContain('extra_hosts');
        expect(engine).toContain("dns: ['${PTBK_STACK_NET:-10.89.231}.53']");
        expect(engine).toContain('cap_drop: [ALL]');
    });

    it('lets only the services the host reaches join a network with a gateway', () => {
        const joined = ['relay-a-net', 'dashboard', 'host-dns'];
        for (const service of joined) expect(serviceBlock(overlay, service)).toContain('host-access: {}');
        expect(overlay.match(/host-access: \{\}/g)).toHaveLength(joined.length + 1);
    });

    it('runs the conformance build against the stack, never as production', () => {
        expect(engine).toContain('PTBK_DASHBOARD_URL: https://app.ptbk.test:8444');
        expect(engine).toContain('PTBK_ENGINE_DOMAIN: engine.test');
        expect(engine).toContain('PTBK_CONFORMANCE_TRUST_FILE: /trust/conformance-trust.json');
        expect(engine).toContain('PTBK_UI_RELEASE_URL: https://releases.ptbk.test/conformance/');
        expect(engine).toContain('NODE_ENV: development');
        expect(engine).not.toContain('PTBK_RELAYS');
        expect(engine).toContain('profiles: [on-demand]');
    });
});

describe('parseLinkCode', () => {
    it('takes exactly one canonical code in the dashboard’s alphabet', () => {
        const code = 'abcdefghijklmnopqrstuvwxya';
        expect(parseLinkCode([code])).toBe(code);
        expect(parseLinkCode(['abcdefghijklmnopqrstuvwxy2'])).toBeNull();
        expect(parseLinkCode([])).toBeNull();
        expect(parseLinkCode([code, code])).toBeNull();
        expect(parseLinkCode(['ABCDEFGHIJKLMNOPQRSTUVWXY2'])).toBeNull();
        expect(parseLinkCode([`${code}; echo`])).toBeNull();
    });

    it('takes the dev stack’s own link URL, and no other dashboard’s', () => {
        const code = 'abcdefghijklmnopqrstuvwxya';
        expect(parseLinkCode([`${DEV_DASHBOARD_ORIGIN}/link#${code}`])).toBe(`${DEV_DASHBOARD_ORIGIN}/link#${code}`);
        expect(parseLinkCode([`https://app.ptbk.link/link#${code}`])).toBeNull();
        expect(parseLinkCode([`${DEV_DASHBOARD_ORIGIN}/link#${code}'; echo`])).toBeNull();
    });
});

describe('the --no-system Chromium', () => {
    it('maps the stack’s names to loopback and nothing else anywhere, in its own profile', () => {
        const args = chromiumArgs('/repo/.dev/chromium', DEV_PORTS.noSystemRelay);
        expect(args).toContain('--user-data-dir=/repo/.dev/chromium');
        expect(args).toContain(
            '--host-resolver-rules=MAP app.ptbk.test 127.0.0.1:8444, MAP *.engine.test 127.0.0.1:8443, MAP * ~NOTFOUND',
        );
    });

    it('prints a line a shell takes as is', () => {
        const line = chromiumLaunchLine('darwin', "/Users/o'neil/app/.dev/chromium", DEV_PORTS.noSystemRelay);
        expect(line.startsWith("'/Applications/Google Chrome.app/Contents/MacOS/Google Chrome' ")).toBe(true);
        expect(line).toContain(`'--user-data-dir=/Users/o'\\''neil/app/.dev/chromium'`);
        expect(line.endsWith(`'${DEV_DASHBOARD_ORIGIN}/'`)).toBe(true);
        expect(chromiumLaunchLine('linux', '/p', 8443).startsWith("'google-chrome' ")).toBe(true);
    });
});
