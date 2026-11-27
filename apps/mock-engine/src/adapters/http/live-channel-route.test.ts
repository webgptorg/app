import { MAX_LIVE_SEND_BUFFER_BYTES } from '@ptbk/engine-api';
import type { InMemoryEngineCore, LiveChannelSink } from '@ptbk/engine-api/in-memory';
import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';

import { createLiveChannelRoute } from './live-channel-route';

function openWithSocket(bufferedAmount: () => number) {
    let sink: LiveChannelSink | undefined;
    const peer = { opened: vi.fn(), receive: vi.fn(), closed: vi.fn() };
    const core = {
        attachLiveChannel: (_actor: unknown, _sessionId: string, given: LiveChannelSink) => {
            sink = given;
            return { kind: 'attached', peer };
        },
    } as unknown as InMemoryEngineCore;
    const route = createLiveChannelRoute({ core: () => core });
    const admission = route.handle({ params: { sessionId: 'live-1' }, actor: {} } as unknown as Parameters<
        typeof route.handle
    >[0]);
    if (admission.kind !== 'accept') throw new Error('refused');
    expect(peer.opened).not.toHaveBeenCalled();
    const socket = {
        OPEN: 1,
        readyState: 1,
        get bufferedAmount() {
            return bufferedAmount();
        },
        send: vi.fn<(data: unknown, options: { readonly binary: boolean }) => void>(),
        close: vi.fn(),
        on: vi.fn(),
        once: vi.fn(),
    };
    admission.open(socket as unknown as WebSocket);
    // The core audits the attach only once the handshake completed.
    expect(peer.opened).toHaveBeenCalledOnce();
    if (sink === undefined) throw new Error('no sink');
    return { sink, socket };
}

describe('the live channel’s send buffer', () => {
    it('sends text and frames while the buffer stays under the limit', () => {
        const { sink, socket } = openWithSocket(() => MAX_LIVE_SEND_BUFFER_BYTES);
        sink.send('{"type":"state"}');
        sink.send(new Uint8Array(16));
        expect(socket.send.mock.calls.map(([, options]) => options)).toEqual([{ binary: false }, { binary: true }]);
        expect(socket.close).not.toHaveBeenCalled();
    });

    it('closes with 1008 instead of queueing past the limit, for text as for frames', () => {
        for (const data of ['{"type":"state"}', new Uint8Array(16)]) {
            const { sink, socket } = openWithSocket(() => MAX_LIVE_SEND_BUFFER_BYTES + 1);
            sink.send(data);
            expect(socket.send).not.toHaveBeenCalled();
            expect(socket.close).toHaveBeenCalledWith(1008);
        }
    });
});
