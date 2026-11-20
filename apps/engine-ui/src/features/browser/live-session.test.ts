import { createProblem } from '@ptbk/engine-api';
import type { EngineApiResponse, LiveInputEvent } from '@ptbk/engine-api';
import { describe, expect, it, vi } from 'vitest';

import { createLiveBrowserTestEngine, createManualDrawer, flushLive } from '../../testing/live-browser-engine';
import type { LiveBrowserTestEngine } from '../../testing/live-browser-engine';
import { createLiveSession } from './live-session';
import type { LiveSession } from './live-session';

const SITE = 'https://shop.example';
const OTHER = 'https://elsewhere.example';
const SIZE = { width: 640, height: 400 };
const CLICK: LiveInputEvent = { kind: 'pointer', action: 'down', x: 10, y: 10, button: 'left', clicks: 1 };

function ok<T>(response: EngineApiResponse<T>): T {
    if (response.kind !== 'ok') throw new Error(`expected ok, got ${response.problem.code}`);
    return response.data;
}

const signal = () => AbortSignal.timeout(5_000);

interface Harness {
    readonly engine: LiveBrowserTestEngine;
    readonly session: LiveSession;
    readonly tabId: string;
    readonly retries: (() => void)[];
}

async function open(mode: 'watch' | 'control', engine = createLiveBrowserTestEngine()): Promise<Harness> {
    const tab = engine.controller.openAgentTab({ agentId: 'ada', origin: SITE });
    const opened = ok(await engine.client.browser[mode](tab.id, signal()));
    const retries: (() => void)[] = [];
    const session = createLiveSession(
        {
            engineApi: engine.client,
            openChannel: engine.openLiveChannel,
            schedule: (callback) => {
                retries.push(callback);
                return () => undefined;
            },
        },
        opened,
    );
    await flushLive();
    return { engine, session, tabId: tab.id, retries };
}

const inputs = (engine: LiveBrowserTestEngine) => engine.sent.filter((message) => message.type === 'input');
const acks = (engine: LiveBrowserTestEngine) =>
    engine.sent.flatMap((message) => (message.type === 'frame-ack' ? [message.seq] : []));

describe('a live session over the in-memory engine', () => {
    it('says hello, reports the tab and acknowledges each frame it draws', async () => {
        const { engine, session } = await open('watch');
        expect(engine.sent[0]).toEqual({ type: 'hello', versions: [1] });
        expect(session.getView()).toMatchObject({
            connection: 'open',
            mode: 'watching',
            agent: 'working',
            origin: SITE,
            viewport: { width: 1280, height: 800 },
            blocked: null,
            endReason: null,
            hasFrame: false,
        });
        // Before a canvas is attached the frame is acknowledged unseen and the engine is told nothing is visible.
        expect(acks(engine)).toEqual([1]);
        expect(engine.sent).toContainEqual({ type: 'view', width: 1, height: 1, visible: false });

        const drawer = createManualDrawer();
        const detach = session.attach(drawer, SIZE);
        await flushLive();
        expect(engine.sent.at(-1)).toEqual({ type: 'view', width: 640, height: 400, visible: true });
        expect(drawer.waiting()).toBe(1);
        drawer.release();
        await flushLive();
        expect(drawer.drawn).toEqual([2]);
        expect(acks(engine)).toEqual([1, 2]);
        expect(session.getView().hasFrame).toBe(true);
        // Each acknowledgement frees credit for the next frame, so exactly one more is waiting to be drawn.
        expect(drawer.waiting()).toBe(1);

        detach();
        expect(engine.sent.at(-1)).toEqual({ type: 'view', width: 640, height: 400, visible: false });
        session.dispose();
    });

    it('draws only the newest of frames that arrive while one is drawing', async () => {
        const { engine, session } = await open('watch');
        const drawer = createManualDrawer();
        session.attach(drawer, SIZE);
        await flushLive();
        engine.controller.browserTick();
        engine.controller.browserTick();
        await flushLive();
        drawer.release();
        await flushLive();
        drawer.release();
        await flushLive();
        expect(new Set(acks(engine)).size).toBe(acks(engine).length);
        expect(drawer.drawn.length).toBeLessThan(acks(engine).length);
        session.dispose();
    });

    it('sends no input while watching', async () => {
        const { engine, session } = await open('watch');
        expect(session.input(CLICK, true)).toBe(false);
        expect(session.input({ kind: 'key', action: 'down', key: 'a', shift: false }, true)).toBe(false);
        expect(inputs(engine)).toEqual([]);
        session.dispose();
    });

    it('sends input while controlling and pauses the agent', async () => {
        const { engine, session } = await open('control');
        expect(session.getView()).toMatchObject({ mode: 'controlling', agent: 'paused' });
        expect(session.input(CLICK, true)).toBe(true);
        expect(inputs(engine)).toEqual([{ type: 'input', event: CLICK }]);
        session.dispose();
    });

    it('takes control and hands it back as the engine answers', async () => {
        const { engine, session } = await open('watch');
        session.update(ok(await engine.client.browser.takeControl(session.id, signal())));
        await flushLive();
        expect(session.getView()).toMatchObject({ mode: 'controlling', agent: 'paused' });
        session.update(ok(await engine.client.browser.handBack(session.id, signal())));
        await flushLive();
        expect(session.getView()).toMatchObject({ mode: 'watching', agent: 'working', endReason: null });
        expect(session.input(CLICK, true)).toBe(false);
        session.dispose();
    });

    it('stops frames and input on a blocked origin until the tab is back', async () => {
        const { engine, session, tabId } = await open('control');
        const drawer = createManualDrawer();
        session.attach(drawer, SIZE);
        engine.controller.navigateBrowserTab(tabId, { kind: 'web', origin: OTHER });
        await flushLive();
        expect(session.getView()).toMatchObject({
            blocked: { reason: 'origin-not-allowed', origin: OTHER },
            hasFrame: false,
        });
        expect(drawer.cleared()).toBe(1);
        expect(session.input(CLICK, true)).toBe(false);
        expect(inputs(engine)).toEqual([]);

        engine.controller.navigateBrowserTab(tabId, { kind: 'secret-page' });
        await flushLive();
        expect(session.getView().blocked).toEqual({ reason: 'secret-page', origin: null });

        engine.controller.navigateBrowserTab(tabId, { kind: 'web', origin: SITE });
        await flushLive();
        expect(session.getView()).toMatchObject({ blocked: null, origin: SITE });
        expect(session.input(CLICK, true)).toBe(true);
        session.dispose();
    });

    it.each([
        ['expired', (h: Harness) => h.engine.controller.elapseBrowserSession(h.session.id, 'expired')],
        ['idle', (h: Harness) => h.engine.controller.elapseBrowserSession(h.session.id, 'idle')],
        [
            'tab-closed',
            (h: Harness) => {
                h.engine.controller.closeAgentTab(h.tabId);
            },
        ],
        ['ended', (h: Harness) => h.session.end()],
    ] as const)('ends with the reason the engine gives: %s', async (reason, end) => {
        const harness = await open('control');
        const drawer = createManualDrawer();
        harness.session.attach(drawer, SIZE);
        await end(harness);
        await flushLive();
        expect(harness.session.getView()).toMatchObject({ endReason: reason, connection: 'closed', hasFrame: false });
        expect(harness.session.getView().session.status).toBe('ended');
        expect(harness.session.input(CLICK, true)).toBe(false);
        expect(harness.retries).toEqual([]);
    });

    it('ends a session opened already ended without opening a channel', async () => {
        const engine = createLiveBrowserTestEngine();
        const tab = engine.controller.openAgentTab({ origin: SITE });
        const opened = ok(await engine.client.browser.watch(tab.id, signal()));
        const ended = ok(await engine.client.browser.end(opened.id, signal()));
        const session = createLiveSession({ engineApi: engine.client, openChannel: engine.openLiveChannel }, ended);
        expect(session.getView()).toMatchObject({ endReason: 'ended', connection: 'closed' });
        expect(engine.channels()).toBe(0);
        await session.end();
        expect(engine.channels()).toBe(0);
    });

    it('reconnects within the session after the channel drops', async () => {
        const { engine, session, retries } = await open('watch');
        engine.drop();
        await flushLive();
        expect(session.getView().connection).toBe('reconnecting');
        expect(retries).toHaveLength(1);
        retries[0]?.();
        await flushLive();
        expect(engine.channels()).toBe(2);
        expect(session.getView()).toMatchObject({ connection: 'open', mode: 'watching', endReason: null });
        expect(engine.sent.filter((message) => message.type === 'hello')).toHaveLength(2);
        session.dispose();
    });

    it('learns from the engine why a dropped channel will not come back', async () => {
        const { engine, session, retries } = await open('watch');
        engine.controller.elapseBrowserSession(session.id, 'expired');
        // The channel's own end message is lost; only the close arrives.
        session.dispose();
        const second = createLiveSession(
            {
                engineApi: engine.client,
                openChannel: engine.openLiveChannel,
                schedule: (callback) => {
                    retries.push(callback);
                    return () => undefined;
                },
            },
            { ...session.getView().session, status: 'open', endReason: null },
        );
        await flushLive();
        expect(second.getView()).toMatchObject({ endReason: 'expired', connection: 'closed' });
        expect(retries).toEqual([]);
    });

    it('keeps retrying through network failures and ends quietly on a 404', async () => {
        const { engine, session, retries } = await open('watch');
        const getSession = vi
            .spyOn(engine.client.browser, 'getSession')
            .mockRejectedValueOnce(new Error('offline'))
            .mockResolvedValueOnce({ kind: 'problem', problem: createProblem('not-found') });
        engine.drop();
        await flushLive();
        expect(retries).toHaveLength(1);
        retries[0]?.();
        await flushLive();
        expect(session.getView().connection).toBe('open');
        engine.drop();
        await flushLive();
        expect(getSession).toHaveBeenCalledTimes(2);
        expect(session.getView()).toMatchObject({ endReason: 'unknown', connection: 'closed' });
        expect(retries).toHaveLength(1);
    });

    it('keeps moves under the input rate limit', async () => {
        const { session } = await open('control');
        const move: LiveInputEvent = { kind: 'pointer', action: 'move', x: 1, y: 1, button: 'none', clicks: 0 };
        let sent = 0;
        for (let index = 0; index < 200; index++) if (session.input(move, false)) sent++;
        expect(sent).toBeLessThan(120);
        expect(session.input(CLICK, true)).toBe(true);
        await flushLive();
        expect(session.getView().endReason).toBeNull();
        session.dispose();
    });
});
