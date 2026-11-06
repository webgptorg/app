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
    devTarget,
    nonLoopbackPorts,
    parseDevStackArgs,
    parseLinkCode,
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
        expect(parseDevStackArgs(['up'])).toEqual({ kind: 'up', noSystem: false });
        expect(parseDevStackArgs(['up', '--no-system'])).toEqual({ kind: 'up', noSystem: true });
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
