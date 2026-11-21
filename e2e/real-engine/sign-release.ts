// One-shot in the real-engine dev stack (compose.real-engine.yaml, before the engine starts): signs the engine-ui
// bundle init's image packed with X-03's `pack` the way C-10's conformance suite signs its releases. Release and
// maintainer keys and a test Sigstore (Fulcio-style certificate, Rekor entry, timestamps) exist only while this runs;
// the engine's real Sigstore verifier checks them against the trusted root in the conformance trust file this writes.
// Only a conformance build of the engine accepts that file. The mock engine's releases next to it stay as they are.
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { parseArgs } from 'node:util';

import type { FakeReleaseStore, UiLoaderLab } from '@ptbk/conformance';
import { Bench } from '@ptbk/conformance';

/** The suite's store interface over a directory the release store serves; only `put` is needed to publish. */
function directoryStore(root: string): FakeReleaseStore {
    return {
        url: new URL('https://releases.ptbk.test/conformance/'),
        put(path, body) {
            mkdirSync(dirname(join(root, path)), { recursive: true });
            writeFileSync(join(root, path), body);
        },
        delete() {
            throw new Error('not used');
        },
        fault() {
            throw new Error('not used');
        },
        requests: () => [],
    };
}

function publishOnly(store: FakeReleaseStore): UiLoaderLab {
    const refuse = (): never => {
        throw new Error('this lab only publishes; the dev stack starts the engine');
    };
    return { store, start: refuse, logTail: () => '', close: () => Promise.resolve() };
}

async function main(): Promise<void> {
    const { values } = parseArgs({
        strict: true,
        options: { bundle: { type: 'string' }, store: { type: 'string' }, trust: { type: 'string' } },
    });
    const { bundle, store, trust } = values;
    if (bundle === undefined || store === undefined || trust === undefined) {
        throw new Error('usage: sign-release --bundle <dir> --store <dir> --trust <file>');
    }
    const archive = new Uint8Array(await readFile(join(bundle, 'engine-ui.tar.zst')));
    const manifest = JSON.parse(await readFile(join(bundle, 'manifest.json'), 'utf8')) as {
        readonly version: string;
        readonly commit: string;
    };
    await rm(store, { recursive: true, force: true });
    const bench = await Bench.open(publishOnly(directoryStore(store)));
    await bench.revocations();
    await bench.publish(manifest.version, {
        release: {
            entry: { archiveSha256: createHash('sha256').update(archive).digest('hex'), commit: manifest.commit },
        },
        served: () => archive,
    });
    bench.setLatest(manifest.version);
    const settings = bench.settings({ policy: 'pinned', version: manifest.version });
    await writeFile(trust, `${JSON.stringify(settings.trust)}\n`, { mode: 0o644 });
    process.stdout.write(`real-engine-release: UI ${manifest.version} signed for the conformance build\n`);
}

try {
    await main();
} catch (error) {
    process.stderr.write(`real-engine-release failed: ${error instanceof Error ? error.message : 'unknown error'}\n`);
    process.exitCode = 1;
}
