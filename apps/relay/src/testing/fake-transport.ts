import type { Frame } from '@ptbk/protocol';
import { decodeFrame } from '@ptbk/protocol';

import type { TunnelTransport } from '../domain/tunnel/tunnel-session';

export interface FakeTransport extends TunnelTransport {
    /** Every frame sent while open, decoded. */
    readonly frames: Frame[];
    readonly closes: { readonly code: number; readonly reason: string }[];
    /** Sets the buffer and, as a flush would, wakes the `whenBufferedBelow` waiters it now satisfies. */
    setBufferedBytes(bytes: number): void;
}

/** Records what the session sends; `send` drops frames once `close` was called. */
export function createFakeTransport(): FakeTransport {
    const frames: Frame[] = [];
    const closes: { code: number; reason: string }[] = [];
    let buffered = 0;
    const waiters = new Set<{ readonly below: number; readonly callback: () => void }>();
    return {
        frames,
        closes,
        send(frame) {
            if (closes.length > 0) return false;
            const decoded = decodeFrame(frame);
            if (decoded.kind !== 'frame') throw new Error(`session sent an undecodable frame (${decoded.kind})`);
            frames.push(decoded.frame);
            return true;
        },
        close(code, reason) {
            closes.push({ code, reason });
        },
        bufferedBytes: () => buffered,
        whenBufferedBelow(below, callback) {
            const waiter = { below, callback };
            waiters.add(waiter);
            return () => {
                waiters.delete(waiter);
            };
        },
        setBufferedBytes(bytes) {
            buffered = bytes;
            for (const waiter of [...waiters]) {
                if (buffered < waiter.below) {
                    waiters.delete(waiter);
                    waiter.callback();
                }
            }
        },
    };
}
