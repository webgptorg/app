import type { UiRefusalReason } from '@ptbk/engine-api';

import { Findings } from '../../../check';
import type { ArchiveEntry } from '../archive';
import { describeCheck } from '../bench';
import { ARCHIVE_NAME } from '../releases';
import { MIRROR_LAYOUT_V1 } from '../store-layout';
import type { UiLoaderCheck } from './common';
import { expectRefusal, expectStillActive, refusals } from './common';

const text = (value: string): Uint8Array<ArrayBuffer> => new TextEncoder().encode(value);
const MANIFEST = ['manifest', 'unpack'] as const satisfies readonly UiRefusalReason[];

export const hashMismatch: UiLoaderCheck = {
    id: 'ui-loader.artifact.hash-mismatch',
    title: "An archive that differs from the release entry's SHA-256 is refused",
    run: (bench, ctx) =>
        refusals(bench, ctx, [
            {
                label: 'one archive byte flipped',
                reasons: ['hash-mismatch'],
                publish: {
                    served: (archive) => {
                        const changed = archive.slice();
                        const at = changed.length >> 1;
                        changed[at] = (changed[at] ?? 0) ^ 0x01;
                        return changed;
                    },
                },
            },
        ]),
};

const withEntries = (edit: (entries: ArchiveEntry[]) => ArchiveEntry[]) => ({ bundle: { editEntries: edit } });

function replaceFile(entries: ArchiveEntry[], path: string, bytes: Uint8Array): ArchiveEntry[] {
    return entries.map((entry) => (entry.path === path && entry.kind === 'file' ? { ...entry, bytes } : entry));
}

export const filesEnforced: UiLoaderCheck = {
    id: 'ui-loader.manifest.files-enforced',
    title: 'An unlisted, missing or changed file, or a manifest that does not match the release entry, is refused',
    run: (bench, ctx) =>
        refusals(bench, ctx, [
            {
                label: 'an unlisted file',
                reasons: MANIFEST,
                publish: withEntries((entries) => [
                    ...entries,
                    { kind: 'file', path: 'assets/unlisted.js', bytes: text('alert(1)\n') },
                ]),
            },
            {
                label: 'a listed file missing',
                reasons: MANIFEST,
                publish: withEntries((entries) => entries.filter((entry) => entry.path !== 'favicon.svg')),
            },
            {
                label: 'a file whose bytes differ, same size',
                reasons: MANIFEST,
                publish: withEntries((entries) =>
                    replaceFile(entries, 'favicon.svg', text('<svg xmlns="http://www.w3.org/2000/svh"/>')),
                ),
            },
            {
                label: 'a size that differs from the manifest',
                reasons: MANIFEST,
                publish: {
                    bundle: {
                        editManifest: (manifest) => ({
                            ...manifest,
                            files: manifest.files.map((file) =>
                                file.path === 'favicon.svg' ? { ...file, size: file.size + 1 } : file,
                            ),
                        }),
                    },
                },
            },
            {
                label: 'a manifest for another version',
                reasons: MANIFEST,
                publish: { bundle: { editManifest: (manifest) => ({ ...manifest, version: '0.0.1' }) } },
            },
            {
                label: 'a manifest for another commit',
                reasons: MANIFEST,
                publish: { bundle: { editManifest: (manifest) => ({ ...manifest, commit: 'e'.repeat(40) }) } },
            },
            {
                label: 'a manifest with an unknown field',
                reasons: MANIFEST,
                publish: { bundle: { editManifest: (manifest) => ({ ...manifest, scripts: ['eval.js'] }) } },
            },
        ]),
};

export const unsafeEntries: UiLoaderCheck = {
    id: 'ui-loader.archive.unsafe-entries',
    title: 'Archives with a ../ path, an absolute path, a symbolic link or a hard link are refused',
    run: (bench, ctx) =>
        refusals(
            bench,
            ctx,
            (
                [
                    ['a ../ path', { kind: 'file', path: '../conformance-escape.txt', bytes: text('escaped\n') }],
                    [
                        'an absolute path',
                        { kind: 'file', path: '/tmp/conformance-absolute.txt', bytes: text('absolute\n') },
                    ],
                    [
                        'a symbolic link',
                        { kind: 'symlink', path: 'assets/link.js', target: '../../../../etc/hostname' },
                    ],
                    ['a hard link', { kind: 'hardlink', path: 'assets/hard.js', target: 'index.html' }],
                ] as const
            ).map(([label, entry]) => ({
                label,
                reasons: MANIFEST,
                publish: withEntries((entries) => [...entries, entry]),
            })),
        ),
};

export const engineApiRange: UiLoaderCheck = {
    id: 'ui-loader.manifest.engine-api-range',
    title: "A bundle whose engineApi range excludes the engine's API version is refused",
    run: (bench, ctx) =>
        refusals(bench, ctx, [
            {
                label: 'a bundle for engine API 99',
                reasons: ['engine-api'],
                publish: { bundle: { engineApi: '>=99.0.0 <100.0.0' } },
            },
        ]),
};

export const rollbackNotNewer: UiLoaderCheck = {
    id: 'ui-loader.rollback.not-newer',
    title: 'Pinning an older version, or the active version with other bytes, does not replace the active bundle',
    async run(bench, ctx) {
        const findings = new Findings();
        while (bench.installed.length < 2) await bench.install(ctx);
        const older = bench.installed.at(-2);
        const active = bench.active;
        if (older === undefined || active === null) throw new Error('two installs were expected');
        await bench.revocations();
        const seen = await bench.pinned(ctx, older.version);
        if (seen.check.outcome === 'installed' || seen.ui.version !== active.version) {
            findings.add(`pinning the older ${older.version}: ${describeCheck(seen.check)}, ${seen.ui.version} active`);
        }
        if (seen.check.outcome === 'refused' && seen.check.reason !== 'not-newer') {
            findings.add(`pinning the older ${older.version}: expected not-newer, got ${describeCheck(seen.check)}`);
        }
        await expectStillActive(bench, ctx, findings, 'older version', active, seen);
        await expectRefusal(bench, ctx, findings, {
            label: 'the active version with other bytes',
            reasons: ['not-newer'],
            version: () => active.version,
            prepare: async (lab) => {
                await lab.publish(active.version, { bundle: { csp: "default-src 'none'" } });
            },
        });
        // Puts the genuine record back, so the store again describes what is installed.
        bench.lab.store.put(MIRROR_LAYOUT_V1.release(active.version), active.record);
        bench.lab.store.put(MIRROR_LAYOUT_V1.artifact(active.version, ARCHIVE_NAME), active.bundle.archive);
        return findings.outcome();
    },
};
