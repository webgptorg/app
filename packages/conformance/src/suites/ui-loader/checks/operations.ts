import { ENGINE_RESERVED_PATHS } from '@ptbk/engine-api';

import type { BaseCheckContext } from '../../../check';
import { Findings } from '../../../check';
import type { Bench } from '../bench';
import { SECURITY_HEADERS, describeCheck, sleep } from '../bench';
import type { StoreFault } from '../lab';
import { ARCHIVE_NAME } from '../releases';
import { MIRROR_LAYOUT_V1 } from '../store-layout';
import type { UiLoaderCheck } from './common';
import { expectStillActive } from './common';

export const unavailableKeepsCurrent: UiLoaderCheck = {
    id: 'ui-loader.store.unavailable-keeps-current',
    title: 'A release store that fails during a check keeps the current bundle',
    async run(bench, ctx) {
        const findings = new Findings();
        const cases: readonly { label: string; path: (version: string) => string; fault: StoreFault }[] = [
            { label: 'the release record answers 503', path: MIRROR_LAYOUT_V1.release, fault: 'error' },
            {
                label: 'the archive is cut off halfway',
                path: (version) => MIRROR_LAYOUT_V1.artifact(version, ARCHIVE_NAME),
                fault: 'truncate',
            },
        ];
        for (const { label, path, fault } of cases) {
            const baseline = await bench.baseline(ctx);
            await bench.revocations();
            const published = await bench.publish(bench.nextVersion());
            bench.lab.store.fault(path(published.version), fault);
            try {
                const seen = await bench.pinned(ctx, published.version);
                if (seen.check.outcome === 'installed' || seen.check.outcome === 'up-to-date') {
                    findings.add(`${label}: ${describeCheck(seen.check)}`);
                }
                await expectStillActive(bench, ctx, findings, label, baseline, seen);
            } finally {
                bench.lab.store.fault(path(published.version), null);
            }
        }
        return findings.outcome();
    },
};

async function startUnder(bench: Bench, ctx: BaseCheckContext, policy: 'manual'): Promise<void> {
    await bench.start(ctx, bench.settings({ policy }));
}

export const policyHonoured: UiLoaderCheck = {
    id: 'ui-loader.policy.honoured',
    title: 'pinned installs exactly PTBK_PINNED_VERSION, auto checks latest.json, and manual installs nothing by itself',
    async run(bench, ctx) {
        const findings = new Findings();
        await bench.baseline(ctx);
        await bench.revocations();
        const pinned = await bench.publish(bench.nextVersion());
        const newest = await bench.publish(bench.nextVersion());
        bench.setLatest(newest.version);
        const seen = await bench.pinned(ctx, pinned.version);
        if (seen.check.outcome !== 'installed' || seen.ui.version !== pinned.version) {
            findings.add(
                `pinned ${pinned.version} with ${newest.version} latest: ${describeCheck(seen.check)}, ${seen.ui.version} active`,
            );
        } else {
            bench.active = pinned;
            bench.installed.push(pinned);
        }

        const auto = await bench.auto(ctx);
        if (auto.check.version !== newest.version || auto.check.reason !== 'delay-not-elapsed') {
            findings.add(
                `auto with ${newest.version} latest: expected refused delay-not-elapsed, got ${describeCheck(auto.check)}`,
            );
        }

        const before = bench.active;
        const manual = await bench.publish(bench.nextVersion());
        bench.setLatest(manual.version);
        await startUnder(bench, ctx, 'manual');
        // Nothing announces that a manual engine decided to wait, so give it the time a startup check would take.
        await sleep(3_000, ctx.signal);
        const { ui } = await bench.security(ctx);
        if (before !== null && ui.version !== before.version) findings.add(`manual: ${ui.version} became active`);
        const served = await bench.servedVersion(ctx);
        if (before !== null && served !== before.version)
            findings.add(`manual: the engine serves ${served ?? 'no bundle'}`);
        return findings.outcome();
    },
};

function headerFindings(findings: Findings, label: string, headers: Headers): void {
    for (const [name, value] of Object.entries(SECURITY_HEADERS)) {
        const actual = headers.get(name);
        if (actual !== value)
            findings.add(`${label}: ${name} is ${actual === null ? 'missing' : JSON.stringify(actual)}`);
    }
}

export const listedFilesOnly: UiLoaderCheck = {
    id: 'ui-loader.serve.listed-files-only',
    title: "Only manifest files are served, and the SPA fallback never shadows the engine's reserved paths",
    async run(bench, ctx) {
        const findings = new Findings();
        const active = await bench.baseline(ctx);
        for (const file of active.bundle.files) {
            const served = await bench.get(ctx, `/${file.path}`);
            if (served.status !== 200 || !sameBytes(served.bytes, file.bytes)) {
                findings.add(`/${file.path}: status ${String(served.status)}, ${String(served.bytes.length)} bytes`);
            }
        }
        const missing = await bench.get(ctx, '/assets/conformance-missing-0000.js');
        if (missing.status !== 404) findings.add(`an unlisted asset answered ${String(missing.status)}`);
        const manifest = await bench.get(ctx, '/manifest.json');
        if (manifest.status === 200 && new TextDecoder().decode(manifest.bytes).includes('"files"')) {
            findings.add('the archive manifest is served, though the manifest does not list it');
        }
        const deepLink = await bench.get(ctx, '/agents/conformance-deep-link', 'text/html');
        if (deepLink.status !== 200 || !new TextDecoder().decode(deepLink.bytes).includes(active.version)) {
            findings.add(
                `an HTML navigation to /agents/conformance-deep-link did not get the entry (${String(deepLink.status)})`,
            );
        }
        for (const reserved of ENGINE_RESERVED_PATHS) {
            const path = reserved.endsWith('/') ? `${reserved}conformance-probe` : reserved;
            const served = await bench.get(ctx, path, 'text/html');
            if (new TextDecoder().decode(served.bytes).includes('ptbk-conformance-ui')) {
                findings.add(`${path}: the SPA fallback answers an engine path`);
            }
        }
        return findings.outcome();
    },
};

export const securityHeaders: UiLoaderCheck = {
    id: 'ui-loader.serve.security-headers',
    title: "Every bundle response carries ENGINE_UI_CSP byte for byte and the engine's headers, whatever the manifest says",
    async run(bench, ctx) {
        const findings = new Findings();
        const active = await bench.install(ctx, {
            bundle: { csp: "default-src * 'unsafe-inline' 'unsafe-eval'" },
        });
        const asset = active.bundle.files.find((file) => file.path.endsWith('.js'));
        for (const [label, path, accept] of [
            ['the entry', '/', 'text/html'],
            ['an asset', `/${asset?.path ?? 'index.html'}`, '*/*'],
            ['the SPA fallback', '/agents/conformance-headers', 'text/html'],
            ['a 404', '/assets/conformance-missing-0000.js', '*/*'],
        ] as const) {
            const served = await bench.get(ctx, path, accept);
            headerFindings(findings, label, served.headers);
        }
        return findings.outcome();
    },
};

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
    return a.length === b.length && a.every((byte, index) => byte === b[index]);
}
