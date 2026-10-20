import type { Frame } from '@ptbk/protocol';
import { decodeFrame } from '@ptbk/protocol';

import type { TunnelTransport } from '../domain/tunnel/tunnel-session';

export interface FakeTransport extends TunnelTransport {
    /** Every frame sent while open, decoded. */
    readonly frames: Frame[];
    readonly closes: { readonly code: number; readonly reason: string }[];
    setBufferedBytes(bytes: number): void;
}

/** Records what the session sends; `send` drops frames once `close` was called. */
export function createFakeTransport(): FakeTransport {
    const frames: Frame[] = [];
    const closes: { code: number; reason: string }[] = [];
    let buffered = 0;
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
        setBufferedBytes(bytes) {
            buffered = bytes;
        },
    };
}
