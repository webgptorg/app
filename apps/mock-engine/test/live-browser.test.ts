import type { IncomingMessage } from 'node:http';

import {
    BrowserTabId,
    ENGINE_API_PREFIX,
    KNOWN_CAPABILITIES,
    LIVE_CHANNEL_SUBPROTOCOL,
    LiveEngineMessage,
    decodeLiveMedia,
} from '@ptbk/engine-api';
import { afterEach, describe, expect, it } from 'vitest';
import { WebSocket } from 'ws';

import { LIVE_CHANNEL_MAX_PAYLOAD_BYTES } from '../src/adapters/http/live-channel-route';
import type { ApiHarness } from '../src/testing/api-harness';
import { HARNESS_ORIGIN, createApiHarness } from '../src/testing/api-harness';
import { HARNESS_HOSTNAME } from '../src/testing/engine-harness';

const signal = () => AbortSignal.timeout(10_000);
const harnesses: ApiHarness[] = [];

afterEach(async () => {
    for (const harness of harnesses.splice(0)) {
        await harness.recorder.settled();
        expect(harness.recorder.violations).toEqual([]);
        await harness.close();
    }
});

async function start(liveBrowser = true) {
    const harness = await createApiHarness({ liveBrowser });
    harnesses.push(harness);
    const cookie = harness.signIn({ memberId: harness.ownerId() });
    return { harness, cookie, owner: harness.client(cookie) };
}

type Event =
    | { readonly kind: 'text'; readonly message: LiveEngineMessage }
    | { readonly kind: 'frame'; readonly seq: number }
    | { readonly kind: 'closed'; readonly code: number };

interface Channel {
    readonly ws: WebSocket;
    next(): Promise<Event>;
    /** Events until one matches, which is returned. */
    until(match: (event: Event) => boolean): Promise<Event>;
    send(message: unknown): void;
}

type Opened =
    | { readonly kind: 'open'; readonly channel: Channel }
    | { readonly kind: 'refused'; readonly status: number; readonly body: Record<string, unknown> };

interface OpenOptions {
    readonly cookie?: string | null;
    readonly origin?: string | null;
    readonly protocols?: readonly string[];
    readonly suffix?: string;
}

function channelPath(sessionId: string): string {
    return `${ENGINE_API_PREFIX}/live-sessions/${sessionId}/channel`;
}

function open(harness: ApiHarness, sessionId: string, options: OpenOptions = {}): Promise<Opened> {
    const headers: Record<string, string> = {};
    if (options.cookie != null) headers['Cookie'] = options.cookie;
    const origin = options.origin === undefined ? HARNESS_ORIGIN : options.origin;
    if (origin !== null) headers['Origin'] = origin;
    const ws = new WebSocket(
        `wss://${HARNESS_HOSTNAME}${channelPath(sessionId)}${options.suffix ?? ''}`,
        [...(options.protocols ?? [LIVE_CHANNEL_SUBPROTOCOL])],
        { createConnection: () => harness.openSocket(), headers, perMessageDeflate: false },
    );
    const queue: Event[] = [];
    const waiting: ((event: Event) => void)[] = [];
    const push = (event: Event): void => {
        const resolve = waiting.shift();
        if (resolve === undefined) queue.push(event);
        else resolve(event);
    };
    ws.on('message', (data, isBinary) => {
        const bytes = new Uint8Array(data as Buffer);
        if (!isBinary) {
            push({ kind: 'text', message: LiveEngineMessage.parse(JSON.parse(new TextDecoder().decode(bytes))) });
            return;
        }
        const decoded = decodeLiveMedia(bytes);
        if (decoded.kind !== 'ok') throw new Error('bad media from the engine');
        push({ kind: 'frame', seq: decoded.media.seq });
    });
    ws.on('close', (code) => {
        push({ kind: 'closed', code });
    });
    const next = (): Promise<Event> => {
        const queued = queue.shift();
        return queued === undefined ? new Promise((resolve) => waiting.push(resolve)) : Promise.resolve(queued);
    };
    const channel: Channel = {
        ws,
        next,
        async until(match) {
            for (;;) {
                const event = await next();
                if (match(event)) return event;
            }
        },
        send: (message) => {
            ws.send(JSON.stringify(message));
        },
    };
    return new Promise((resolve, reject) => {
        ws.once('open', () => {
            resolve({ kind: 'open', channel });
        });
        ws.once('unexpected-response', (_request, response: IncomingMessage) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
                resolve({
                    kind: 'refused',
                    status: response.statusCode ?? 0,
                    body: JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>,
                });
            });
        });
        ws.once('error', (error) => {
            if (ws.readyState === ws.CONNECTING) reject(error);
        });
    });
}

async function opened(harness: ApiHarness, sessionId: string, options: OpenOptions = {}): Promise<Channel> {
    const result = await open(harness, sessionId, options);
    if (result.kind !== 'open') throw new Error(`refused with ${String(result.status)}`);
    return result.channel;
}

async function refused(harness: ApiHarness, sessionId: string, options: OpenOptions = {}) {
    const result = await open(harness, sessionId, options);
    if (result.kind !== 'refused') {
        result.channel.ws.close();
        throw new Error('the channel opened');
    }
    return { status: result.status, code: result.body['code'] };
}

async function watchStartupTab(harness: ApiHarness, cookie: string) {
    const tabId = BrowserTabId.parse(harness.runtime?.liveBrowserTab() ?? '');
    const watched = await harness.client(cookie).browser.watch(tabId, signal());
    if (watched.kind !== 'ok') throw new Error(watched.problem.code);
    return watched.data;
}

describe('the live browser without MOCK_LIVE_BROWSER', () => {
    it('is not advertised, and its routes and channel answer 404 capability-not-supported', async () => {
        const { harness, cookie, owner } = await start(false);
        const engine = await owner.engine.get(signal());
        expect(engine.kind === 'ok' && engine.data.capabilities).not.toContainEqual(KNOWN_CAPABILITIES.browserTab);
        const tabs = await owner.browser.listTabs({}, signal());
        expect(tabs.kind === 'problem' && tabs.problem.code).toBe('capability-not-supported');
        expect(await refused(harness, 'session-1', { cookie })).toEqual({
            status: 404,
            code: 'capability-not-supported',
        });
    });
});

describe('the live channel', () => {
    it('streams the fake tab to its own gateway session: hello, state, PNG frames on ack, the end', async () => {
        const { harness, cookie } = await start();
        const session = await watchStartupTab(harness, cookie);
        const channel = await opened(harness, session.id, { cookie });
        expect(channel.ws.protocol).toBe(LIVE_CHANNEL_SUBPROTOCOL);
        channel.send({ type: 'hello', versions: [1] });
        expect(await channel.next()).toEqual({ kind: 'text', message: { type: 'hello', version: 1 } });
        expect(await channel.next()).toMatchObject({ kind: 'text', message: { type: 'state', mode: 'watching' } });
        const frame = await channel.until((event) => event.kind === 'frame');
        if (frame.kind !== 'frame') throw new Error('no frame');
        channel.send({ type: 'frame-ack', seq: frame.seq });
        expect(await channel.until((event) => event.kind === 'frame')).toMatchObject({ kind: 'frame' });

        // One channel per session at a time.
        expect(await refused(harness, session.id, { cookie })).toEqual({ status: 409, code: 'live-channel-attached' });

        expect(harness.runtime?.controller().elapseBrowserSession(session.id, 'expired')).toBe(true);
        expect(await channel.until((event) => event.kind === 'text' && event.message.type === 'end')).toEqual({
            kind: 'text',
            message: { type: 'end', reason: 'expired' },
        });
        expect(await channel.until((event) => event.kind === 'closed')).toEqual({ kind: 'closed', code: 1000 });
        expect(await refused(harness, session.id, { cookie })).toEqual({ status: 409, code: 'browser-session-ended' });
    });

    it('lets the same gateway session attach again after its channel dropped', async () => {
        const { harness, cookie } = await start();
        const session = await watchStartupTab(harness, cookie);
        const first = await opened(harness, session.id, { cookie });
        first.ws.terminate();
        await first.until((event) => event.kind === 'closed');
        await expect.poll(async () => (await open(harness, session.id, { cookie })).kind).toBe('open');
    });

    it('frees the session when the handshake fails after the engine accepted it', async () => {
        const { harness, cookie } = await start();
        const session = await watchStartupTab(harness, cookie);
        const socket = harness.openSocket();
        const answer = await new Promise<string>((resolve) => {
            let text = '';
            socket.on('data', (chunk: Buffer) => (text += chunk.toString('utf8')));
            socket.once('close', () => {
                resolve(text);
            });
            socket.write(
                `GET ${channelPath(session.id)} HTTP/1.1\r\nHost: ${HARNESS_HOSTNAME}\r\nOrigin: ${HARNESS_ORIGIN}\r\n` +
                    `Cookie: ${cookie}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n` +
                    `Sec-WebSocket-Protocol: ${LIVE_CHANNEL_SUBPROTOCOL}\r\nSec-WebSocket-Version: 13\r\n` +
                    'Sec-WebSocket-Key: not-a-key\r\n\r\n',
            );
        });
        expect(answer).toMatch(/^HTTP\/1\.1 400 /);
        const channel = await opened(harness, session.id, { cookie });
        channel.ws.close();
        const audit = await harness.client(cookie).audit.list({ limit: 100 }, signal());
        if (audit.kind !== 'ok') throw new Error(audit.problem.code);
        expect(
            audit.data.items
                .filter((entry) => entry.action === 'browser.channel.attach')
                .map(({ outcome }) => outcome)
                .sort(),
        ).toEqual(['failed', 'success']);
    });

    it('refuses a member without browser.watch with 403 before it looks at the session', async () => {
        const { harness, cookie } = await start();
        const session = await watchStartupTab(harness, cookie);
        const blind = harness.signIn({ memberId: harness.ownerId(), permissions: ['agents.read', 'browser.control'] });
        expect(await refused(harness, session.id, { cookie: blind })).toEqual({ status: 403, code: 'forbidden' });
        expect(await refused(harness, 'session-nowhere', { cookie: blind })).toEqual({
            status: 403,
            code: 'forbidden',
        });
        // The upgrade checks the permission itself, before the subprotocol and before asking the core.
        expect(await refused(harness, session.id, { cookie: blind, protocols: [] })).toEqual({
            status: 403,
            code: 'forbidden',
        });
    });

    it('ends a controller’s session as revoked once a role change takes browser.control', async () => {
        const { harness, owner } = await start();
        const admin = harness
            .core()
            .controller.inspect()
            .members.find(({ role }) => role === 'admin');
        if (admin === undefined) throw new Error('no admin in the scenario');
        const promoted = await owner.members.update(admin.id, { role: 'owner' }, signal());
        expect(promoted.kind).toBe('ok');
        const cookie = harness.signIn({ memberId: admin.id });
        const tabId = BrowserTabId.parse(harness.runtime?.liveBrowserTab() ?? '');
        const controlled = await harness.client(cookie).browser.control(tabId, signal());
        if (controlled.kind !== 'ok') throw new Error(controlled.problem.code);
        const channel = await opened(harness, controlled.data.id, { cookie });
        channel.send({ type: 'hello', versions: [1] });
        await channel.until((event) => event.kind === 'frame');
        expect((await owner.members.update(admin.id, { role: 'admin' }, signal())).kind).toBe('ok');
        expect(await channel.until((event) => event.kind === 'text' && event.message.type === 'end')).toEqual({
            kind: 'text',
            message: { type: 'end', reason: 'revoked' },
        });
        const tabs = await owner.browser.listTabs({}, signal());
        expect(tabs.kind === 'ok' && tabs.data.items.find(({ id }) => id === tabId)?.agentState).toBe('working');
    });

    it('lets a viewer watch, since watching shows only work they can see', async () => {
        const { harness } = await start();
        const viewer = harness
            .core()
            .controller.inspect()
            .members.find(({ role }) => role === 'viewer');
        const cookie = harness.signIn({ memberId: viewer?.id ?? '' });
        const session = await watchStartupTab(harness, cookie);
        const channel = await opened(harness, session.id, { cookie });
        channel.ws.close();
    });

    it('refuses a missing, malformed or another gateway session’s session with 404', async () => {
        const { harness, cookie } = await start();
        const session = await watchStartupTab(harness, cookie);
        for (const id of ['session-nowhere', 'bad%20id', 'x'.repeat(200), '..']) {
            expect(await refused(harness, id, { cookie }), id).toMatchObject({ status: 404, code: 'not-found' });
        }
        const sameOwnerElsewhere = harness.signIn({ memberId: harness.ownerId() });
        expect(await refused(harness, session.id, { cookie: sameOwnerElsewhere })).toEqual({
            status: 404,
            code: 'not-found',
        });
        const extraSegment = await open(harness, `${session.id}/more`, { cookie });
        expect(extraSegment).toMatchObject({ kind: 'refused', status: 404 });
    });

    it('needs the gateway cookie: 401 without one, or with one that names no session', async () => {
        const { harness, cookie } = await start();
        const session = await watchStartupTab(harness, cookie);
        expect(await refused(harness, session.id, { cookie: null })).toEqual({ status: 401, code: 'unauthenticated' });
        expect(
            await refused(harness, session.id, { cookie: `${cookie.split('=')[0] ?? ''}=AAAAAAAAAAAAAAAAAAAAAA` }),
        ).toEqual({
            status: 401,
            code: 'unauthenticated',
        });
    });

    it('refuses any Origin but the engine’s own with 403, cookie or not', async () => {
        const { harness, cookie } = await start();
        const session = await watchStartupTab(harness, cookie);
        for (const origin of ['https://evil.example', `http://${HARNESS_HOSTNAME}`, `${HARNESS_ORIGIN}:8443`, null]) {
            expect(await refused(harness, session.id, { cookie, origin }), String(origin)).toEqual({
                status: 403,
                code: 'forbidden',
            });
        }
        expect(await refused(harness, session.id, { cookie: null, origin: 'https://evil.example' })).toEqual({
            status: 403,
            code: 'forbidden',
        });
    });

    it('needs the ptbk-live subprotocol, and takes nothing in the query', async () => {
        const { harness, cookie } = await start();
        const session = await watchStartupTab(harness, cookie);
        for (const protocols of [[], ['other'], ['ptbk-live-2']]) {
            expect(await refused(harness, session.id, { cookie, protocols }), protocols.join()).toEqual({
                status: 400,
                code: 'validation-failed',
            });
        }
        const listed = await opened(harness, session.id, { cookie, protocols: ['other', LIVE_CHANNEL_SUBPROTOCOL] });
        expect(listed.ws.protocol).toBe(LIVE_CHANNEL_SUBPROTOCOL);
        listed.ws.close();
        await listed.until((event) => event.kind === 'closed');
        expect(await refused(harness, session.id, { cookie, suffix: `?token=${cookie}` })).toEqual({
            status: 400,
            code: 'validation-failed',
        });
    });

    it('closes the channel on a message above the control limit, and logs no cookie or content', async () => {
        const { harness, cookie } = await start();
        const session = await watchStartupTab(harness, cookie);
        const channel = await opened(harness, session.id, { cookie });
        channel.send({ type: 'hello', versions: [1] });
        await channel.until((event) => event.kind === 'frame');
        channel.ws.send('x'.repeat(LIVE_CHANNEL_MAX_PAYLOAD_BYTES + 1));
        expect(await channel.until((event) => event.kind === 'closed')).toEqual({ kind: 'closed', code: 1009 });
        const logs = harness.logger.text();
        expect(logs).not.toContain(cookie.split('=')[1]);
        expect(logs).not.toContain('frame-ack');
    });
});
