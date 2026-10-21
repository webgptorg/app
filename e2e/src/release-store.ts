// The e2e stack's UI release store (M-05): the files init published, read-only over HTTPS, as R2 or a mirror would
// serve them. GET and HEAD of exact file paths only; no listings, redirects or encoded paths. Only node: imports: it
// runs from a bare Node image.
import { readFileSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createServer } from 'node:https';
import { join } from 'node:path';
import { parseArgs } from 'node:util';

const SEGMENT = /^[A-Za-z0-9_-][A-Za-z0-9._+-]*$/;
const MAX_PATH_LENGTH = 512;
const CONTENT_TYPES: Readonly<Record<string, string>> = { json: 'application/json', zst: 'application/zstd' };

/** The file a request path names under `root`, or `null`: every segment plain, nothing to decode or resolve. */
export function storePath(root: string, url: string | undefined): string | null {
    if (url === undefined || url.length > MAX_PATH_LENGTH || !url.startsWith('/') || /[?#%\\]/.test(url)) return null;
    const segments = url.slice(1).split('/');
    if (!segments.every((segment) => SEGMENT.test(segment))) return null;
    return join(root, ...segments);
}

export function contentTypeOf(path: string): string {
    return CONTENT_TYPES[path.slice(path.lastIndexOf('.') + 1)] ?? 'application/octet-stream';
}

async function answer(root: string, request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.method !== 'GET' && request.method !== 'HEAD') {
        response.writeHead(405, { Allow: 'GET, HEAD' }).end();
        return;
    }
    const path = storePath(root, request.url);
    const stats = path === null ? null : await lstat(path).catch(() => null);
    if (path === null || stats?.isFile() !== true) {
        response.writeHead(404).end();
        return;
    }
    const body = await readFile(path);
    response.writeHead(200, {
        'Content-Type': contentTypeOf(path),
        'Content-Length': String(body.length),
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
    });
    response.end(request.method === 'HEAD' ? undefined : body);
}

if (import.meta.main) {
    const { values } = parseArgs({
        strict: true,
        options: {
            root: { type: 'string' },
            cert: { type: 'string' },
            key: { type: 'string' },
            port: { type: 'string', default: '443' },
        },
    });
    const { root, cert, key } = values;
    if (root === undefined || cert === undefined || key === undefined) {
        throw new Error('usage: release-store.ts --root <dir> --cert <pem> --key <pem> [--port <n>]');
    }
    const server = createServer(
        { cert: readFileSync(cert), key: readFileSync(key), minVersion: 'TLSv1.2' },
        (request, response) => {
            answer(root, request, response).catch(() => {
                response.destroy();
            });
        },
    );
    server.listen(Number(values.port), () => {
        process.stdout.write(`release-store: serving ${root} on ${values.port}\n`);
    });
}
