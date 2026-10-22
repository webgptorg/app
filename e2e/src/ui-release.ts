/*
 * The signed UI release under test, read from the release store the way the engine's loader reads it: the archive's
 * SHA-256 (what the release signs) and the files inside it with the manifest that lists them.
 */
import { createHash } from 'node:crypto';
import { request } from 'node:https';
import { Readable } from 'node:stream';
import { zstdDecompressSync } from 'node:zlib';

import { UiBundleManifest } from '@ptbk/protocol';

import { readTar } from './key-scan/tar-reader.ts';
import { RELEASE_STORE } from './stack.ts';

export interface UiRelease {
    readonly archiveSha256: string;
    readonly manifest: UiBundleManifest;
    /** Each file of the archive but the manifest, by bundle path. */
    readonly files: ReadonlyMap<string, Uint8Array>;
}

const DOWNLOAD_TIMEOUT_MS = 30_000;
const MANIFEST_PATH = 'manifest.json';

export function sha256Hex(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function fetchBytes(url: string, ca: string): Promise<Uint8Array> {
    return new Promise((resolve, reject) => {
        const req = request(url, { ca, agent: false, timeout: DOWNLOAD_TIMEOUT_MS }, (response) => {
            const chunks: Buffer[] = [];
            response.on('data', (chunk: Buffer) => chunks.push(chunk));
            response.on('end', () => {
                if (response.statusCode === 200) resolve(new Uint8Array(Buffer.concat(chunks)));
                else reject(new Error(`${url} answered ${String(response.statusCode)}`));
            });
        });
        req.on('timeout', () => req.destroy(new Error('timed out')));
        req.on('error', reject);
        req.end();
    });
}

export async function downloadUiRelease(version: string, ca: string): Promise<UiRelease> {
    const archive = await fetchBytes(`https://${RELEASE_STORE.hostname}/ui/${version}/engine-ui.tar.zst`, ca);
    let manifest: UiBundleManifest | null = null;
    const files = new Map<string, Uint8Array>();
    for await (const entry of readTar(Readable.from([zstdDecompressSync(archive)]) as AsyncIterable<Uint8Array>)) {
        if (entry.type !== 'file') continue;
        if (entry.path === MANIFEST_PATH)
            manifest = UiBundleManifest.parse(JSON.parse(new TextDecoder().decode(entry.content)));
        else files.set(entry.path, entry.content);
    }
    if (manifest === null) throw new Error(`the UI archive ${version} has no manifest`);
    return { archiveSha256: sha256Hex(archive), manifest, files };
}
