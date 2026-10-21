// Plain TCP reachability for the network scenarios: `listen` gives a namespace open ports to aim at, `connect` reports
// how an attempt ended. The same code runs in the playwright container (imported) and, through `docker exec`, inside
// the engine's network namespace and on the gateway. Only node: imports: the helper images carry no node_modules.
import { connect, createServer } from 'node:net';
import type { Server } from 'node:net';
import { parseArgs } from 'node:util';

/**
 * `refused`: something answered with a reset (a host without a listener). `timeout`: nothing answered at all (dropped,
 * or no route). `unreachable`: the network said so (ICMP, or no route on this side).
 */
export type TcpOutcome = 'connected' | 'refused' | 'timeout' | 'unreachable' | 'error';

export interface TcpAttempt {
    readonly outcome: TcpOutcome;
    /** What the far side wrote first, if it wrote within the timeout (the listener below writes a banner). */
    readonly banner: string;
    readonly elapsedMs: number;
}

export const LISTENER_BANNER = 'ptbk-e2e-listener';

const UNREACHABLE_CODES: ReadonlySet<string> = new Set(['EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN']);

export function tcpAttempt(host: string, port: number, timeoutMs: number): Promise<TcpAttempt> {
    const started = Date.now();
    return new Promise((resolve) => {
        const socket = connect({ host, port });
        let connected = false;
        let banner = '';
        const finish = (outcome: TcpOutcome): void => {
            clearTimeout(timer);
            socket.destroy();
            resolve({ outcome, banner, elapsedMs: Date.now() - started });
        };
        const timer = setTimeout(() => {
            finish(connected ? 'connected' : 'timeout');
        }, timeoutMs);
        socket.setEncoding('utf8');
        socket.once('connect', () => {
            connected = true;
        });
        socket.on('data', (chunk: string) => {
            banner += chunk;
            if (banner.includes('\n')) finish('connected');
        });
        socket.once('end', () => {
            finish('connected');
        });
        socket.once('error', (error: NodeJS.ErrnoException) => {
            if (connected) finish('connected');
            else if (error.code === 'ECONNREFUSED') finish('refused');
            else if (error.code !== undefined && UNREACHABLE_CODES.has(error.code)) finish('unreachable');
            else finish('error');
        });
    });
}

/** Accepts on every port, writes one banner line and closes: proof that a connection really got through. */
export function listen(ports: readonly number[], name: string): Promise<readonly Server[]> {
    return Promise.all(
        ports.map(
            (port) =>
                new Promise<Server>((resolve, reject) => {
                    const server = createServer((socket) => {
                        socket.on('error', () => undefined);
                        socket.end(`${LISTENER_BANNER} ${name}:${String(port)}\n`);
                    });
                    server.once('error', reject);
                    server.listen(port, () => {
                        resolve(server);
                    });
                }),
        ),
    );
}

function port(text: string): number {
    const value = Number(text);
    if (!Number.isInteger(value) || value < 1 || value > 65_535) throw new Error(`${text} is not a TCP port`);
    return value;
}

async function main(args: readonly string[]): Promise<void> {
    const [mode, ...rest] = args;
    const { values, positionals } = parseArgs({
        args: rest,
        strict: true,
        allowPositionals: true,
        options: { 'timeout-ms': { type: 'string', default: '3000' }, name: { type: 'string', default: 'listener' } },
    });
    switch (mode ?? '') {
        case 'listen':
            await listen(positionals.map(port), values.name);
            process.stdout.write(`listening on ${positionals.join(', ')}\n`);
            return;
        case 'connect': {
            const [host, target] = positionals;
            if (host === undefined || target === undefined) throw new Error('connect needs <host> <port>');
            const attempt = await tcpAttempt(host, port(target), Number(values['timeout-ms']));
            process.stdout.write(`${JSON.stringify(attempt)}\n`);
            return;
        }
        default:
            throw new Error('usage: tcp-check.ts listen <port>... | connect <host> <port> [--timeout-ms N]');
    }
}

if (import.meta.main) {
    try {
        await main(process.argv.slice(2));
    } catch (error) {
        process.stderr.write(`tcp-check: ${error instanceof Error ? error.message : 'failed'}\n`);
        process.exitCode = 1;
    }
}
