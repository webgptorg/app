import { compareEngineVersions, EngineVersion } from '@ptbk/protocol';
import { z } from 'zod';

import type { EngineInstallReleaseSource } from '../../domain/registration/engine-install-release-source';
import { engineInstallReleaseSchema } from '../../shared/engine-installation';
import { readCapped } from '../read-capped';

const METADATA_LIMIT = 512 * 1024;
const npmReleaseSchema = z.object({ name: z.literal('ptbk'), version: engineInstallReleaseSchema.shape.version });
const githubReleaseSchema = z.object({
    tag_name: z.string().max(64),
    draft: z.literal(false),
    published_at: z.iso.datetime(),
    assets: z
        .array(
            z.object({
                name: z.string().max(256),
                state: z.string().max(32),
                digest: z.string().max(128).nullable().optional(),
            }),
        )
        .max(256),
});

/**
 * Resolve afresh at issuance, never from an unpublished source checkout. Both channels must be published before
 * promoting the fallback; the immutable, reviewed Ubuntu bootstrap remains pinned independently of its --version.
 */
export function createFetchEngineInstallReleaseSource(deps: {
    readonly fetch: (url: string, init: RequestInit) => Promise<Response>;
}): EngineInstallReleaseSource {
    return {
        async current(fallback, signal) {
            signal.throwIfAborted();
            const deadline = AbortSignal.any([signal, AbortSignal.timeout(10_000)]);
            const metadata = async (url: string) => {
                deadline.throwIfAborted();
                const response = await deps.fetch(url, {
                    headers: { Accept: 'application/json', 'User-Agent': 'Promptbook-Dashboard' },
                    // Workers reject `redirect: 'error'`; a 3xx under `manual` is simply not ok.
                    redirect: 'manual',
                    signal: deadline,
                });
                if (!response.ok) {
                    await response.body?.cancel();
                    throw new Error('release metadata unavailable');
                }
                const body = await readCapped(response, METADATA_LIMIT);
                deadline.throwIfAborted();
                if (body === null) throw new Error('release metadata too large');
                return JSON.parse(body) as unknown;
            };
            try {
                const candidate = npmReleaseSchema.parse(await metadata('https://registry.npmjs.org/ptbk/latest'));
                if (
                    compareEngineVersions(
                        EngineVersion.parse(candidate.version),
                        EngineVersion.parse(fallback.version),
                    ) <= 0
                ) {
                    return fallback;
                }
                const release = githubReleaseSchema.parse(
                    await metadata(
                        `https://api.github.com/repos/webgptorg/promptbook/releases/tags/v${encodeURIComponent(candidate.version)}`,
                    ),
                );
                const assets = release.assets.filter(
                    (asset) => asset.name === `Promptbook-Setup-${candidate.version}-windows-x64.exe`,
                );
                const asset = assets[0];
                const digest = asset?.digest;
                if (
                    release.tag_name !== `v${candidate.version}` ||
                    assets.length !== 1 ||
                    asset?.state !== 'uploaded' ||
                    typeof digest !== 'string' ||
                    !/^sha256:[a-f0-9]{64}$/.test(digest)
                ) {
                    return fallback;
                }
                return engineInstallReleaseSchema.parse({
                    ...fallback,
                    version: candidate.version,
                    windowsSha256: digest.slice('sha256:'.length),
                });
            } catch {
                // An upstream outage must not prevent pairing. Cancellation still belongs to the caller.
                signal.throwIfAborted();
                return fallback;
            }
        },
    };
}
