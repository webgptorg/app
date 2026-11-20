import type { EngineApiResponse } from '@ptbk/engine-api';
import {
    ClientInfo,
    MemberId,
    OWNER_PERMISSIONS,
    SessionId,
    UiUpdateCheck,
    createEngineApiClient,
} from '@ptbk/engine-api';
import { DEFAULT_CAPABILITIES } from '@ptbk/engine-api/in-memory';
import type { Actor } from '@ptbk/engine-api/in-memory';
import { describe, expect, it } from 'vitest';

import { createFakeClock } from '../../testing/fake-clock';
import { HOSTILE_IMAGE, HOSTILE_SCRIPT } from '../chat/reply-generator';
import { createTestRuntime } from '../../testing/test-runtime';
import { HOSTILE_AGENT_NAME } from './seed';

import { MessageId } from '@ptbk/engine-api';
/** The mock engine numbers messages `<chat>#<position>`, and a reply follows its User message directly. */
const replyIdOf = (sent: { readonly message: { readonly id: string } }) =>
    MessageId.parse(sent.message.id.replace(/#(\d+)$/, (_, position: string) => `#${String(Number(position) + 1)}`));

const IDENTITY = {
    engineId: 'abcdefghijklmnopqrstuvwxyz',
    hostname: 'abcdefghijklmnopqrstuvwxyz.engine.test',
    mode: 'tunnel',
    version: '0.4.2',
} as const;

const signal = () => AbortSignal.timeout(5_000);

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`Expected ok, got ${response.problem.code}`);
    return response.data;
}

async function start(options: { readonly liveBrowser?: boolean } = {}) {
    const clock = createFakeClock(Date.parse('2026-10-20T08:00:00Z'));
    const runtime = await createTestRuntime({
        seed: 42,
        scenario: 'small-team',
        epoch: new Date('2026-10-01T00:00:00Z'),
        identity: IDENTITY,
        clock,
        ...options,
    });
    const actorOf = (): Actor => {
        const owner = runtime
            .controller()
            .inspect()
            .members.find(({ role }) => role === 'owner');
        if (owner === undefined) throw new Error('no owner');
        return {
            memberId: MemberId.parse(owner.id),
            sessionId: SessionId.parse('session-test'),
            client: ClientInfo.parse({ ip: '127.0.0.1', userAgent: 'runtime test' }),
            permissions: new Set(OWNER_PERMISSIONS),
            stepUpFresh: true,
        };
    };
    // The core's own transport, with no HTTP in between: the runtime is domain code.
    const client = () => createEngineApiClient(runtime.core().transport(actorOf()));
    return { clock, runtime, client };
}

describe('engine runtime with the live browser', () => {
    it('advertises browser-tab@1 and starts each core with a fake agent tab in a seeded chat', async () => {
        const { runtime, client } = await start({ liveBrowser: true });
        expect(ok(await client().engine.get(signal())).capabilities).toContainEqual(KNOWN_CAPABILITIES.browserTab);
        const first = runtime.liveBrowserTab();
        const tab = runtime.controller().getBrowserTab(first ?? '');
        expect(tab).toMatchObject({ origin: 'https://shop.example', agentState: 'working' });
        expect(tab?.chatId).not.toBeNull();
        expect(tab?.agentId).not.toBeNull();
        expect(ok(await client().browser.listTabs({}, signal())).items.map(({ id }) => id)).toEqual([first]);

        // A reset that names capabilities still keeps the flag's: the flag, not the list, decides.
        await runtime.reset({ seed: 7, scenario: 'empty', capabilities: [KNOWN_CAPABILITIES.tasks] });
        expect(runtime.current().capabilities).toEqual([KNOWN_CAPABILITIES.tasks, KNOWN_CAPABILITIES.browserTab]);
        expect(ok(await client().engine.get(signal())).capabilities).toEqual([
            KNOWN_CAPABILITIES.tasks,
            KNOWN_CAPABILITIES.browserTab,
        ]);
        const empty = runtime.controller().getBrowserTab(runtime.liveBrowserTab() ?? '');
        expect(empty).toMatchObject({ origin: 'https://shop.example', chatId: null, agentId: null });
        await runtime.reset({ seed: 7, scenario: 'empty' });
        expect(runtime.current().capabilities).toEqual([KNOWN_CAPABILITIES.tasks, KNOWN_CAPABILITIES.browserTab]);
    });

    it('allows the sign-in origins and nothing else', async () => {
        const { client } = await start({ liveBrowser: true });
        const open = (origin: string) => client().browser.openSignIn({ browser: null, origin }, signal());
        expect((await open('https://shop.example')).kind).toBe('problem');
        expect(ok(await open('https://accounts.example'))).toMatchObject({ kind: 'sign-in', status: 'open' });
    });

    it('has no tab and no capability without the flag', async () => {
        const { runtime, client } = await start();
        expect(runtime.liveBrowserTab()).toBeNull();
        const listed = await client().browser.listTabs({}, signal());
        expect(listed.kind === 'problem' && listed.problem.code).toBe('capability-not-supported');
    });
});

describe('engine runtime', () => {
    it('reports the identity, version, mode and every capability but file scanning, the live browser and voice', async () => {
        const { client } = await start();
        expect(ok(await client().engine.get(signal()))).toMatchObject({
            engineId: IDENTITY.engineId,
            hostname: IDENTITY.hostname,
            mode: 'tunnel',
            dashboardUrl: null,
            capabilities: DEFAULT_CAPABILITIES,
        });
        expect(ok(await client().security.get(signal()))).toMatchObject({
            engine: { version: '0.4.2' },
            hostnames: [{ hostname: IDENTITY.hostname, kind: 'default' }],
            relays: [],
        });
    });

    it('limits knowledge uploads to documents up to 10 MiB and takes any other upload', async () => {
        const { client } = await start();
        expect(ok(await client().files.uploadPolicy({ purpose: 'knowledge' }, signal()))).toMatchObject({
            maxBytes: 10 * 1024 * 1024,
            accept: expect.arrayContaining(['.pdf', '.md', 'text/*']) as unknown,
        });
        const upload = (name: string, type: string, purpose: 'knowledge' | 'upload') =>
            client().files.upload({ file: new Blob(['x'], { type }), name, purpose }, signal());
        expect(await upload('notes.md', '', 'knowledge')).toMatchObject({ kind: 'ok' });
        expect(await upload('run.exe', 'application/x-msdownload', 'knowledge')).toMatchObject({
            kind: 'problem',
            problem: { code: 'unsupported-media-type' },
        });
        expect(await upload('run.exe', 'application/x-msdownload', 'upload')).toMatchObject({ kind: 'ok' });
    });

    it('applies relay states, hostnames and the dashboard URL, and keeps them across a reset', async () => {
        const { clock, runtime, client } = await start();
        runtime.setRelayStatus('relay-a.ptbk.test', 'connecting');
        clock.advance(1_000);
        runtime.setRelayStatus('relay-a.ptbk.test', 'connected');
        clock.advance(1_000);
        runtime.setRelayStatus('relay-a.ptbk.test', 'connected');
        runtime.setRelayStatus('relay-b.ptbk.test', 'disconnected');
        runtime.setHostnames([IDENTITY.hostname, 'agents.customer.test']);
        runtime.setDashboardUrl('https://app.ptbk.test/engines/abc');
        const heartbeat = { sentAt: '2026-10-20T08:00:02Z', body: '{"v":1}', signature: `ed25519=${'A'.repeat(86)}` };
        const clockSkew = { seconds: -300, measuredAt: '2026-10-20T08:00:02Z' };
        runtime.setHeartbeat({ lastHeartbeat: heartbeat, clockSkew });
        const listened: string[] = [];
        runtime.onReset(() => listened.push('reset'));
        const before = ok(await client().security.get(signal()));
        await runtime.reset({ seed: 7, scenario: 'empty' });
        expect(runtime.current()).toMatchObject({ seed: 7, scenario: 'empty' });
        expect(listened).toEqual(['reset']);
        expect(runtime.controller().inspect().counts).toMatchObject({ members: 1, agents: 7 });
        const after = ok(await client().security.get(signal()));
        expect(after.relays).toEqual(before.relays);
        expect(after.lastHeartbeat).toEqual(heartbeat);
        expect(after.clockSkew).toEqual(clockSkew);
        expect(after.relays).toEqual([
            { hostname: 'relay-a.ptbk.test', status: 'connected', since: '2026-10-20T08:00:01Z', lastPingRttMs: null },
            {
                hostname: 'relay-b.ptbk.test',
                status: 'disconnected',
                since: '2026-10-20T08:00:02Z',
                lastPingRttMs: null,
            },
        ]);
        expect(after.hostnames).toEqual([
            { hostname: IDENTITY.hostname, kind: 'default', certificateStatus: null, claimRegistered: null },
            { hostname: 'agents.customer.test', kind: 'custom', certificateStatus: null, claimRegistered: null },
        ]);
        expect(ok(await client().engine.get(signal())).dashboardUrl).toBe('https://app.ptbk.test/engines/abc');
    });

    it("reports the UI loader's last check, before and after a bundle is active, and keeps it across a reset", async () => {
        const { runtime, client } = await start();
        const refused = {
            at: '2026-10-20T08:00:00Z',
            outcome: 'refused',
            version: '1.1.0',
            reason: 'revocations-unverifiable',
            revocationReason: 'expired',
        } as const;
        runtime.setUiUpdateCheck(UiUpdateCheck.parse(refused));
        expect(ok(await client().security.get(signal())).ui.lastUpdateCheck).toEqual({ ...refused, eligibleAt: null });
        runtime.setUi({ version: '1.0.0', bundleSha256: 'c'.repeat(64), releaseLogIndex: 9 });
        await runtime.reset({ seed: 3, scenario: 'empty' });
        expect(ok(await client().security.get(signal())).ui).toEqual({
            version: '1.0.0',
            bundleSha256: 'c'.repeat(64),
            releaseLogIndex: 9,
            releaseLogEntryUuid: null,
            lastUpdateCheck: { ...refused, eligibleAt: null },
        });
    });

    it('shows the placeholder bundle again once no bundle is active, as before the first install', async () => {
        const { runtime, client } = await start();
        const placeholder = ok(await client().security.get(signal())).ui;
        runtime.setUi({ version: '1.1.0', bundleSha256: 'c'.repeat(64), releaseLogIndex: 9 });
        expect(ok(await client().security.get(signal())).ui.version).toBe('1.1.0');
        runtime.setUi(null);
        expect(ok(await client().security.get(signal())).ui).toEqual(placeholder);
        await runtime.reset({ seed: 3, scenario: 'empty' });
        expect(ok(await client().security.get(signal())).ui).toEqual(placeholder);
    });

    it('reports the served certificate in the security panel, across a reset', async () => {
        const { runtime, client } = await start();
        const certificate = { certificateSha256: 'd'.repeat(64), notAfter: '2026-10-27T08:00:00Z' };
        const defaultHostname = async () => ok(await client().security.get(signal())).hostnames[0];
        expect(await defaultHostname()).toMatchObject({ kind: 'default', certificateStatus: null });
        runtime.setTlsCertificate({ ...certificate, notAfter: '2026-10-01T08:00:00Z' });
        expect(await defaultHostname()).toMatchObject({ certificateStatus: 'expired' });
        runtime.setTlsCertificate(certificate);
        expect(ok(await client().security.get(signal())).tls).toMatchObject(certificate);
        expect(await defaultHostname()).toMatchObject({ kind: 'default', certificateStatus: 'valid' });
        await runtime.reset({ seed: 3, scenario: 'empty' });
        expect(ok(await client().security.get(signal())).tls).toMatchObject(certificate);
    });

    it("answers the injection demo agent with hostile markdown, paced on the runtime's clock", async () => {
        const { clock, client } = await start();
        const agents = ok(await client().agents.list({ limit: 100 }, signal())).items;
        const hostile = agents.find(({ name }) => name === HOSTILE_AGENT_NAME);
        if (hostile === undefined) throw new Error('no hostile agent');
        const chat = ok(await client().chats.create({ agentId: hostile.id }, signal()));
        const sent = ok(await client().chats.sendMessage(chat.id, { content: 'hi' }, signal()));
        for (let step = 0; step < 5_000 && clock.pendingTimers() > 0; step++) {
            clock.advance(100);
            await new Promise((resolve) => setImmediate(resolve));
        }
        const stream = ok(await client().chats.streamReply(chat.id, replyIdOf(sent), {}, signal()));
        let text = '';
        for await (const { event } of stream) {
            if (event.type === 'delta') text += event.text;
            else expect(event.type).toBe('completed');
        }
        expect(text).toContain(HOSTILE_IMAGE);
        expect(text).toContain(HOSTILE_SCRIPT);
    });

    it('stops waiting when a paced sleep is cancelled', async () => {
        const { clock, client } = await start();
        const [agent] = ok(await client().agents.list({}, signal())).items;
        if (agent === undefined) throw new Error('no agent');
        const chat = ok(await client().chats.create({ agentId: agent.id }, signal()));
        const sent = ok(await client().chats.sendMessage(chat.id, { content: 'hi' }, signal()));
        expect(clock.pendingTimers()).toBe(1);
        ok(await client().chats.cancelReply(chat.id, replyIdOf(sent), signal()));
        expect(clock.pendingTimers()).toBe(0);
    });
});
