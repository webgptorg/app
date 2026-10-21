import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { Clock } from '../domain/clock';
import type { SeqStore } from '../domain/heartbeat/seq-store';
import { nextSeq } from '../domain/heartbeat/seq-store';
import { currentUid, lstatOrNull, privacyProblem, replacePrivateFile } from './private-files';

export const SEQ_FILE = 'heartbeat-seq';

const SEQ_TEXT = /^(?:0|[1-9]\d{0,15})\n?$/;

/** A `heartbeat-seq` file that cannot be trusted or read. Messages name the path, never its content. */
export class SeqStoreError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'SeqStoreError';
    }
}

/**
 * `<dataDir>/heartbeat-seq`: the last `seq` handed out, as a decimal line. Each value is written durably (temporary
 * file, `fsync`, rename, directory `fsync`) before `next` returns it, so a crash between persisting and sending never
 * reuses one. Calls are serialised; a failed write hands out nothing.
 */
export function createFsSeqStore(
    dataDir: string,
    deps: { readonly clock: Clock; readonly uid?: number | null },
): SeqStore {
    const uid = deps.uid === undefined ? currentUid() : deps.uid;
    const path = join(dataDir, SEQ_FILE);
    let last: number | null | undefined;
    let queue: Promise<unknown> = Promise.resolve();

    async function load(): Promise<number | null> {
        const stats = await lstatOrNull(path);
        if (stats === null) return null;
        const problem = privacyProblem(stats, { label: SEQ_FILE, path, kind: 'file' }, uid);
        if (problem !== null) throw new SeqStoreError(problem);
        const text = stats.size <= 32 ? await readFile(path, 'utf8') : '';
        const value = Number(text.trim());
        if (!SEQ_TEXT.test(text) || !Number.isSafeInteger(value)) {
            throw new SeqStoreError(`${SEQ_FILE} ${path} does not hold a sequence number`);
        }
        return value;
    }

    async function advance(): Promise<number> {
        last ??= await load();
        const seq = nextSeq(last, deps.clock.nowMs());
        if (!Number.isSafeInteger(seq)) throw new SeqStoreError(`${SEQ_FILE} ${path} is exhausted`);
        await replacePrivateFile(path, `${String(seq)}\n`);
        last = seq;
        return seq;
    }

    return {
        next() {
            const result = queue.then(advance);
            queue = result.catch(() => undefined);
            return result;
        },
    };
}
