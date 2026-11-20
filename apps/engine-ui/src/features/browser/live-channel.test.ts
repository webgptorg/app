import { LiveSessionId } from '@ptbk/engine-api';
import { describe, expect, it, vi } from 'vitest';

import { createWebSocketLiveChannels, liveChannelUrl } from './live-channel';

const SESSION = LiveSessionId.parse('live-1');

class FakeSocket extends EventTarget {
    static readonly OPEN = 1;
    static last: FakeSocket | null = null;
    readyState = 0;
    binaryType = 'blob';
    readonly sent: string[] = [];
    readonly close = vi.fn();
    readonly url: URL;
    readonly protocol: string;
    constructor(url: URL, protocol: string) {
        super();
        this.url = url;
        this.protocol = protocol;
        FakeSocket.last = this;
    }
    send(text: string) {
        this.sent.push(text);
    }
}

describe('the live channel over a WebSocket', () => {
    it('attaches on the engine origin with the ptbk-live subprotocol and nothing secret in the URL', () => {
        expect(liveChannelUrl('https://engine.example', SESSION).href).toBe(
            'wss://engine.example/api/v1/live-sessions/live-1/channel',
        );
        expect(liveChannelUrl('http://127.0.0.1:4173', SESSION).href).toBe(
            'ws://127.0.0.1:4173/api/v1/live-sessions/live-1/channel',
        );
    });

    it('passes text and media through, sends only while open and closes cleanly', () => {
        const open = createWebSocketLiveChannels('https://engine.example', FakeSocket as unknown as typeof WebSocket);
        const handlers = { onOpen: vi.fn(), onMessage: vi.fn(), onClose: vi.fn() };
        const channel = open(SESSION, handlers);
        const socket = FakeSocket.last;
        if (socket === null) throw new Error('no socket');
        expect(socket.protocol).toBe('ptbk-live');
        expect(socket.binaryType).toBe('arraybuffer');
        channel.send('early');
        expect(socket.sent).toEqual([]);

        socket.readyState = FakeSocket.OPEN;
        socket.dispatchEvent(new Event('open'));
        expect(handlers.onOpen).toHaveBeenCalledOnce();
        channel.send('{"type":"end"}');
        expect(socket.sent).toEqual(['{"type":"end"}']);

        socket.dispatchEvent(new MessageEvent('message', { data: '{"type":"hello","version":1}' }));
        socket.dispatchEvent(new MessageEvent('message', { data: new Uint8Array([1, 2]).buffer }));
        socket.dispatchEvent(new MessageEvent('message', { data: 42 }));
        expect(handlers.onMessage.mock.calls).toEqual([['{"type":"hello","version":1}'], [new Uint8Array([1, 2])]]);

        channel.close();
        expect(socket.close).toHaveBeenCalledWith(1000);
        socket.dispatchEvent(new Event('close'));
        expect(handlers.onClose).toHaveBeenCalledOnce();
    });
});
