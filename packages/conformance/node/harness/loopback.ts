import type { AddressInfo, Server } from 'node:net';
import { createServer } from 'node:net';

/** Parent of every name the harness serves; `*.localhost` resolves to loopback (RFC 6761), on both address families. */
export const LOOPBACK_DOMAIN = 'localhost';

const ATTEMPTS = 20;

function listen(server: Server, port: number, host: string): Promise<number> {
    return new Promise((resolve, reject) => {
        const onError = (error: Error): void => {
            server.off('listening', onListening);
            reject(error);
        };
        const onListening = (): void => {
            server.off('error', onError);
            resolve((server.address() as AddressInfo).port);
        };
        server.once('error', onError);
        server.once('listening', onListening);
        server.listen({ port, host, exclusive: true });
    });
}

function close(server: Server): Promise<void> {
    return new Promise((resolve) => {
        if (!server.listening) {
            resolve();
            return;
        }
        server.close(() => {
            resolve();
        });
    });
}

function code(error: unknown): string | undefined {
    return (error as NodeJS.ErrnoException).code;
}

export interface LoopbackListener {
    readonly port: number;
    close(): Promise<void>;
}

/**
 * Listens with one handler on 127.0.0.1 and ::1 on the same port, because a `*.localhost` name may resolve to either
 * first and an engine is free to try them in any order. Hosts without IPv6 get IPv4 only.
 */
export async function listenLoopback(makeServer: () => Server): Promise<LoopbackListener> {
    for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
        const v4 = makeServer();
        const port = await listen(v4, 0, '127.0.0.1');
        const v6 = makeServer();
        try {
            await listen(v6, port, '::1');
        } catch (error) {
            await close(v6);
            if (code(error) === 'EADDRINUSE') {
                await close(v4);
                continue;
            }
            if (code(error) !== 'EADDRNOTAVAIL' && code(error) !== 'EAFNOSUPPORT') {
                await close(v4);
                throw error;
            }
            return { port, close: () => close(v4) };
        }
        return {
            port,
            close: async () => {
                await Promise.all([close(v4), close(v6)]);
            },
        };
    }
    throw new Error('no loopback port was free on both address families');
}

/** A port that was free a moment ago; for engine-specific listeners the harness cannot open itself. */
export async function freeLoopbackPort(): Promise<number> {
    const listener = await listenLoopback(() => createServer());
    await listener.close();
    return listener.port;
}
