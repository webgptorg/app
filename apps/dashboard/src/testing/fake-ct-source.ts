import type { CtIssuance, CtLogSource, CtSourceName } from '../domain/abuse/ct-log-source';

export interface FakeCtSource extends CtLogSource {
    /** What the next reads answer: issuances newer than the cursor (by index), or a failure. */
    issuances: CtIssuance[];
    fail: Error | 'hang' | null;
    readonly cursors: (string | null)[];
}

/** A CT source over a list: the cursor is the number of issuances read so far. */
export function createFakeCtSource(name: CtSourceName, issuances: CtIssuance[] = []): FakeCtSource {
    const fake: FakeCtSource = {
        name,
        issuances,
        fail: null,
        cursors: [],
        read(_domain, cursor, signal) {
            fake.cursors.push(cursor);
            if (fake.fail === 'hang') {
                return new Promise((_, reject) => {
                    signal.addEventListener('abort', () => {
                        reject(signal.reason as Error);
                    });
                });
            }
            if (fake.fail !== null) return Promise.reject(fake.fail);
            const from = cursor === null ? 0 : Number(cursor);
            const fresh = fake.issuances.slice(from);
            // Like the real sources: nothing seen yet, nothing to remember.
            const next = fake.issuances.length === 0 ? cursor : String(fake.issuances.length);
            return Promise.resolve({ issuances: fresh, cursor: next });
        },
    };
    return fake;
}
