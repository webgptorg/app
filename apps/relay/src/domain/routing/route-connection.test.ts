import type { Hostname, TunnelCloseCode } from '@ptbk/protocol';
import { Hostname as HostnameSchema, RelayId, expectedCnameTarget } from '@ptbk/protocol';
import { beforeEach, describe, expect, it } from 'vitest';

import type { TestEngine } from '../../testing/engines';
import { ENGINE_DOMAIN, createTestEngine } from '../../testing/engines';
import type { TestDeps } from '../../testing/test-deps';
import { createTestDeps } from '../../testing/test-deps';
import { routableHostnames } from '../hostname-policy';
import type { SessionTable, TableSession } from '../tunnel/session-table';
import { createSessionTable } from '../tunnel/session-table';
import type { ClientHelloVerdict, RouteContext } from './route-connection';
import { routeConnection } from './route-connection';

const relayHostname = RelayId.parse('relay-a.ptbk.test');
const agents = HostnameSchema.parse('agents.customer.test');
const portal = HostnameSchema.parse('portal.customer.test');
const signal = new AbortController().signal;

const sni = (hostname: string): ClientHelloVerdict => ({ kind: 'sni', hostname, alpn: [] });

interface FakeSession extends TableSession {
    readonly closes: TunnelCloseCode[];
}

describe('routeConnection', () => {
    let deps: TestDeps;
    let table: SessionTable<FakeSession>;
    let ctx: RouteContext<FakeSession>;

    beforeEach(() => {
        deps = createTestDeps();
        table = createSessionTable<FakeSession>({ logger: deps.logger });
        ctx = { relayHostname, engineDomain: ENGINE_DOMAIN, sessions: table };
    });

    /** Connects `engine` the way R-03 does: with the hostnames that pass the claim and CNAME checks. */
    async function connect(engine: TestEngine): Promise<FakeSession> {
        const closes: TunnelCloseCode[] = [];
        const session: FakeSession = {
            engineId: engine.engineId,
            remoteIp: '198.51.100.1',
            closes,
            close: (code) => closes.push(code),
        };
        const hostnames = await routableHostnames({
            engineId: engine.engineId,
            entry: engine.entry,
            engineDomain: ENGINE_DOMAIN,
            dns: deps.dns,
            logger: deps.logger,
            signal,
        });
        table.register(session, hostnames);
        return session;
    }

    const cnameTo = (hostname: Hostname, engine: TestEngine): void => {
        deps.dns.setAnswer(hostname, { kind: 'cname', target: expectedCnameTarget(engine.engineId, ENGINE_DOMAIN) });
    };

    it("routes the relay's own hostname to its TLS server, in any case", () => {
        expect(routeConnection(sni('relay-a.ptbk.test'), ctx)).toEqual({ kind: 'own' });
        expect(routeConnection(sni('RELAY-A.ptbk.TEST'), ctx)).toEqual({ kind: 'own' });
    });

    it("routes a connected engine's default hostname to its session", async () => {
        const engine = await createTestEngine(40);
        const session = await connect(engine);
        expect(routeConnection(sni(engine.defaultHostname), ctx)).toEqual({
            kind: 'engine',
            session,
            hostname: engine.defaultHostname,
        });
    });

    it('routes an uppercase SNI like the lowercase one', async () => {
        const engine = await createTestEngine(41);
        const session = await connect(engine);
        expect(routeConnection(sni(engine.defaultHostname.toUpperCase()), ctx)).toEqual({
            kind: 'engine',
            session,
            hostname: engine.defaultHostname,
        });
    });

    it('routes a custom hostname whose claim and CNAME both check out', async () => {
        const engine = await createTestEngine(42, [agents]);
        cnameTo(agents, engine);
        const session = await connect(engine);
        expect(routeConnection(sni(agents), ctx)).toEqual({ kind: 'engine', session, hostname: agents });
    });

    it('refuses a custom hostname with a valid claim whose CNAME check failed as unknown-host', async () => {
        const engine = await createTestEngine(43, [agents, portal]);
        const elsewhere = await createTestEngine(44);
        cnameTo(agents, elsewhere);
        await connect(engine);
        expect(routeConnection(sni(agents), ctx)).toEqual({ kind: 'reject', reason: 'unknown-host' });
        expect(routeConnection(sni(portal), ctx)).toEqual({ kind: 'reject', reason: 'unknown-host' });
    });

    it('refuses a hostname two connected engines claim as unknown-host', async () => {
        const first = await createTestEngine(45, [agents]);
        const second = await createTestEngine(46, [agents]);
        // Each engine's own CNAME check passes in turn, as when the customer moves the record between them.
        cnameTo(agents, first);
        await connect(first);
        cnameTo(agents, second);
        await connect(second);
        expect(table.hostnamesOf(table.byEngine(second.engineId) as FakeSession)).toContain(agents);
        expect(routeConnection(sni(agents), ctx)).toEqual({ kind: 'reject', reason: 'unknown-host' });
    });

    it('refuses a well-formed engine hostname with no tunnel here as engine-offline', async () => {
        const engine = await createTestEngine(47);
        expect(routeConnection(sni(engine.defaultHostname), ctx)).toEqual({
            kind: 'reject',
            reason: 'engine-offline',
        });
    });

    it.each([
        'unrelated.example.test',
        `not-an-engine-id.${ENGINE_DOMAIN}`,
        ENGINE_DOMAIN,
        `a.b.${'a'.repeat(26)}.${ENGINE_DOMAIN}`,
    ])('refuses %j as unknown-host', (hostname) => {
        expect(routeConnection(sni(hostname), ctx)).toEqual({ kind: 'reject', reason: 'unknown-host' });
    });

    it.each(['under_score.example.test', 'single-label', '-dash.example.test', '192.0.2.1', 'trailing.dot.test.'])(
        'refuses an SNI that is no hostname (%j) as malformed',
        (hostname) => {
            expect(routeConnection(sni(hostname), ctx)).toEqual({ kind: 'reject', reason: 'malformed' });
        },
    );

    it.each([
        [{ kind: 'no-sni', alpn: [] }, 'no-sni'],
        [{ kind: 'malformed', reason: 'not-handshake' }, 'malformed'],
        [{ kind: 'too-large' }, 'too-large'],
    ] as const)('passes the parser verdict %j through as a reject', (parse, reason) => {
        expect(routeConnection(parse, ctx)).toEqual({ kind: 'reject', reason });
    });

    it('never looks at ALPN: an ACME acme-tls/1 validation routes like a browser', async () => {
        const engine = await createTestEngine(48);
        const session = await connect(engine);
        const acme: ClientHelloVerdict = { kind: 'sni', hostname: engine.defaultHostname, alpn: ['acme-tls/1'] };
        expect(routeConnection(acme, ctx)).toMatchObject({ kind: 'engine', session });
    });
});
