import type { Bytes, TunnelAuth, TunnelChallenge, TunnelReady } from '@ptbk/protocol';
import { CLOSE_CODE, FrameType, decodeFrame, encodeFrame } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { ConnectionClosed, ConnectionEvent, RelayConnection } from './fake-relay';
import { RelayTunnel } from './relay-tunnel';

/** Just enough of a connection to drive a tunnel by hand. */
function stubConnection() {
    const sent: Bytes[] = [];
    let sink: (event: ConnectionEvent) => void = () => undefined;
    let open = true;
    const connection = {
        relayId: 'relay-1.relays.localhost',
        pings: [],
        openedAt: 0,
        closed: new Promise<ConnectionClosed>(() => undefined),
        takeOver: (next: (event: ConnectionEvent) => void) => {
            sink = next;
        },
        isOpen: () => open,
        sendBinary: (bytes: Bytes) => sent.push(bytes),
        close: () => {
            open = false;
        },
        terminate: () => {
            open = false;
        },
    } as unknown as RelayConnection;
    const tunnel = new RelayTunnel(connection, {
        challenge: {} as TunnelChallenge,
        auth: {} as TunnelAuth,
        ready: {} as TunnelReady,
    });
    const receive = (bytes: Uint8Array): void => {
        sink({ kind: 'binary', bytes: new Uint8Array(bytes), at: performance.now() });
    };
    const frames = () =>
        sent.map((bytes) => decodeFrame(bytes)).map((decoded) => (decoded.kind === 'frame' ? decoded.frame : null));
    return {
        tunnel,
        receive,
        frames,
        lose: () => {
            sink({ kind: 'closed', code: 1006, at: 0 });
        },
        text: () => {
            sink({ kind: 'text', text: '{}', at: 0 });
        },
    };
}

describe('RelayStream', () => {
    it('drops what is written after a close and ends cleanly', async () => {
        const { tunnel, frames } = stubConnection();
        const stream = tunnel.openStream({ address: { family: 4, address: Uint8Array.of(203, 0, 113, 1), port: 1 } });
        stream.closeFromRelay();
        stream.closeFromRelay();
        await new Promise<void>((resolve) =>
            stream.write(Buffer.from('late'), () => {
                resolve();
            }),
        );
        stream.end();
        expect(frames().map((frame) => frame?.type)).toEqual([FrameType.OPEN, FrameType.CLOSE]);
    });

    it('closes with RESET when destroyed with an error, NORMAL on end', async () => {
        const { tunnel, frames } = stubConnection();
        const failing = tunnel.openStream();
        failing.on('error', () => undefined);
        failing.destroy(new Error('boom'));
        const ending = tunnel.openStream();
        ending.resume();
        await new Promise<void>((resolve) =>
            ending.end(() => {
                resolve();
            }),
        );
        const codes = frames().flatMap((frame) => (frame?.type === FrameType.CLOSE ? [frame.code] : []));
        expect(codes).toEqual([CLOSE_CODE.RESET, CLOSE_CODE.NORMAL]);
    });

    it('records data past its credit and after a close, and stops with the tunnel', () => {
        const { tunnel, receive, lose, text } = stubConnection();
        const stream = tunnel.openStream({ autoGrant: false });
        stream.resume();
        const data = (size: number) =>
            encodeFrame({ type: FrameType.DATA, streamId: stream.id, payload: new Uint8Array(size) });
        for (let index = 0; index < 4; index++) receive(data(65_536));
        receive(data(10));
        expect(stream.overrunBytes).toBe(10);
        receive(encodeFrame({ type: FrameType.CLOSE, streamId: stream.id, code: CLOSE_CODE.NORMAL }));
        receive(data(1));
        expect(stream.dataLog).toHaveLength(6);
        text();
        expect(tunnel.problems).toEqual(['sent a text message after ready']);
        const other = tunnel.openStream();
        lose();
        expect(other.isOpen()).toBe(false);
    });
});
