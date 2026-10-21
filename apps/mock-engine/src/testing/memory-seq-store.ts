import type { Clock } from '../domain/clock';
import type { SeqStore } from '../domain/heartbeat/seq-store';
import { nextSeq } from '../domain/heartbeat/seq-store';

export interface MemorySeqStore extends SeqStore {
    /** The last value handed out, as a file would hold it after a crash. */
    last(): number | null;
}

export function createMemorySeqStore(clock: Clock, initial: number | null = null): MemorySeqStore {
    let last = initial;
    return {
        next() {
            last = nextSeq(last, clock.nowMs());
            return Promise.resolve(last);
        },
        last: () => last,
    };
}
