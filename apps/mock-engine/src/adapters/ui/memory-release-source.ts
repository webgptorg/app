import type { EngineVersion } from '@ptbk/protocol';

import type { ReleaseSource } from '../../domain/ui/release-source';

export interface MemoryRelease {
    readonly record: unknown;
    /** Artifact bytes by name. */
    readonly artifacts: ReadonlyMap<string, Uint8Array>;
}

/** A release store in memory: tests publish into it and break it (`fail`) on purpose. */
export interface MemoryReleaseSource extends ReleaseSource {
    publish(version: EngineVersion, release: MemoryRelease, options?: { readonly latest?: boolean }): void;
    setRevocations(envelope: unknown): void;
    /** Makes the next calls of `step` throw, as a network failure would; `artifact-mid-stream` fails after one chunk. */
    fail(step: 'latest' | 'release' | 'revocations' | 'artifact' | 'artifact-mid-stream' | null): void;
}

export function createMemoryReleaseSource(): MemoryReleaseSource {
    const releases = new Map<EngineVersion, MemoryRelease>();
    let latest: EngineVersion | null = null;
    let revocations: unknown = null;
    let failing: Parameters<MemoryReleaseSource['fail']>[0] = null;

    function guard(step: NonNullable<typeof failing>): void {
        if (failing === step) throw new TypeError('fetch failed');
    }

    function released(version: EngineVersion): MemoryRelease {
        const release = releases.get(version);
        if (release === undefined) throw new Error('404');
        return release;
    }

    return {
        latest() {
            guard('latest');
            if (latest === null) return Promise.reject(new Error('404'));
            return Promise.resolve(latest);
        },
        release(version) {
            guard('release');
            return Promise.resolve(released(version).record);
        },
        revocations() {
            guard('revocations');
            return Promise.resolve(revocations);
        },
        artifact(version, name) {
            guard('artifact');
            const bytes = released(version).artifacts.get(name);
            if (bytes === undefined) return Promise.reject(new Error('404'));
            const midStream = failing === 'artifact-mid-stream';
            const half = Math.floor(bytes.length / 2);
            return Promise.resolve(
                new ReadableStream<Uint8Array>({
                    start(controller) {
                        controller.enqueue(bytes.slice(0, half));
                        if (midStream) {
                            controller.error(new TypeError('connection reset'));
                            return;
                        }
                        controller.enqueue(bytes.slice(half));
                        controller.close();
                    },
                }),
            );
        },
        publish(version, release, options) {
            releases.set(version, release);
            if (options?.latest !== false) latest = version;
        },
        setRevocations(envelope) {
            revocations = envelope;
        },
        fail(step) {
            failing = step;
        },
    };
}
