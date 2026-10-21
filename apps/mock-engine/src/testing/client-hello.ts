import { duplexPair } from 'node:stream';
import { connect } from 'node:tls';

import { createClientHelloBuffer } from '@ptbk/protocol';

export interface HelloOptions {
    /** SNI; `null` sends none. */
    readonly servername: string | null;
    readonly ALPNProtocols?: string[];
}

/** The ClientHello Node's TLS client sends with these options, as raw bytes; no server ever answers it. */
export async function captureClientHello(options: HelloOptions): Promise<Buffer> {
    const [client, server] = duplexPair();
    const socket = connect({
        socket: client,
        ...(options.servername === null ? {} : { servername: options.servername }),
        ...(options.ALPNProtocols === undefined ? {} : { ALPNProtocols: options.ALPNProtocols }),
    });
    socket.on('error', () => undefined);
    const buffer = createClientHelloBuffer({ maxBytes: 16_384 });
    try {
        return await new Promise((resolve, reject) => {
            server.on('data', (chunk: Buffer) => {
                const parse = buffer.push(chunk);
                if (parse.kind === 'need-more') return;
                if (parse.kind === 'sni' || parse.kind === 'no-sni') resolve(Buffer.from(buffer.bytes()));
                else reject(new Error(`Node sent an unparseable ClientHello (${parse.kind})`));
            });
        });
    } finally {
        socket.destroy();
        server.destroy();
    }
}
