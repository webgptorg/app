import { EngineVersion } from '@ptbk/protocol';

/**
 * Dry runs push `ui-v0.0.0-dryrun.<n>` (decided 2026-10-20): the same trigger and identity as a release, so they
 * verify against the staging policy exactly like one, but the upload is skipped. `0.0.0-dryrun.<n>` sorts below every
 * real version, so even a leaked dry-run bundle is never newer than an installed one.
 */
export const DRY_RUN_TAG = /^ui-v(0\.0\.0-dryrun\.[1-9][0-9]{0,8})$/;
export const RELEASE_TAG_PREFIX = 'ui-v';

export type ReleaseTag =
    | { readonly kind: 'release'; readonly tag: string; readonly version: string }
    | { readonly kind: 'dry-run'; readonly tag: string; readonly version: string }
    | { readonly kind: 'invalid'; readonly reason: string };

/** A release tag must be exactly `ui-v<package.json version>`; anything else except a dry-run tag is refused. */
export function parseReleaseTag(tag: string, packageVersion: string): ReleaseTag {
    const dryRun = DRY_RUN_TAG.exec(tag);
    if (dryRun?.[1] !== undefined) return { kind: 'dry-run', tag, version: dryRun[1] };
    if (!EngineVersion.safeParse(packageVersion).success) {
        return { kind: 'invalid', reason: `package.json version ${JSON.stringify(packageVersion)} is not semver` };
    }
    if (packageVersion.startsWith('0.0.0-dryrun.')) {
        return { kind: 'invalid', reason: 'package.json may not use the reserved dry-run version' };
    }
    if (tag !== `${RELEASE_TAG_PREFIX}${packageVersion}`) {
        return {
            kind: 'invalid',
            reason: `tag ${JSON.stringify(tag)} does not match package.json version ${packageVersion}`,
        };
    }
    return { kind: 'release', tag, version: packageVersion };
}
