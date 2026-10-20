// Docker healthcheck: an HTTPS GET with the given SNI to each address, verified against the dev CA. For a relay it
// asks its own hostname for /healthz; for the mock engine it asks the engine hostname through every relay, so the
// engine is healthy only once each relay has a ready tunnel and routes it. Only node: imports: it runs from the
// relay and mock engine images, which carry no node_modules.
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { parseArgs } from 'node:util';

export interface ProbeTarget {
    readonly address: string;
    readonly port: number;
    readonly servername: string;
    readonly path: string;
    readonly ca: string;
    readonly timeoutMs: number;
}

export interface ProbeOptions {
    readonly addresses: readonly string[];
    readonly port: number;
    readonly servername: string;
    readonly path: string;
    readonly caFile: string;
    readonly timeoutMs: number;
}

/** `--servername-from <file>` reads the `hostname` field of a JSON file, such as init's engine.json. */
export function parseProbeArgs(args: readonly string[], readText: (path: string) => string): ProbeOptions {
    const { values } = parseArgs({
        args: [...args],
        strict: true,
        options: {
            address: { type: 'string', multiple: true },
            port: { type: 'string', default: '443' },
            servername: { type: 'string' },
            'servername-from': { type: 'string' },
            path: { type: 'string', default: '/' },
            ca: { type: 'string' },
            'timeout-ms': { type: 'string', default: '2000' },
        },
    });
    const addresses = values.address ?? [];
    if (addresses.length === 0) throw new Error('--address is required');
    if (values.ca === undefined) throw new Error('--ca is required');
    if ((values.servername === undefined) === (values['servername-from'] === undefined)) {
        throw new Error('give exactly one of --servername and --servername-from');
    }
    const servername = values.servername ?? hostnameFrom(readText(values['servername-from'] ?? ''));
    const port = Number(values.port);
    const timeoutMs = Number(values['timeout-ms']);
    if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error('--port must be a TCP port');
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1) throw new Error('--timeout-ms must be a positive integer');
    return { addresses, port, servername, path: values.path, caFile: values.ca, timeoutMs };
}

function hostnameFrom(json: string): string {
    const hostname = (JSON.parse(json) as { hostname?: unknown } | null)?.hostname;
    if (typeof hostname !== 'string' || hostname === '') throw new Error('no hostname field in --servername-from');
    return hostname;
}

/** Resolves with the HTTP status; rejects on any TLS, certificate or socket failure. */
export function probe(target: ProbeTarget): Promise<number> {
    return new Promise((resolve, reject) => {
        const req = request(
            {
                host: target.address,
                port: target.port,
                servername: target.servername,
                path: target.path,
                headers: { host: target.servername },
                ca: target.ca,
                agent: false,
                timeout: target.timeoutMs,
            },
            (response) => {
                response.resume();
                response.on('end', () => {
                    resolve(response.statusCode ?? 0);
                });
            },
        );
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
        req.end();
    });
}

async function main(): Promise<void> {
    const options = parseProbeArgs(process.argv.slice(2), (path) => readFileSync(path, 'utf8'));
    const ca = readFileSync(options.caFile, 'utf8');
    const statuses = await Promise.all(options.addresses.map((address) => probe({ ...options, address, ca })));
    const failed = statuses.flatMap((status, index) =>
        status === 200 ? [] : [`${options.addresses[index] ?? ''}: ${String(status)}`],
    );
    if (failed.length > 0) throw new Error(`unexpected status from ${failed.join(', ')}`);
}

if (import.meta.main) {
    try {
        await main();
    } catch (error) {
        process.stderr.write(`probe failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
        process.exitCode = 1;
    }
}
