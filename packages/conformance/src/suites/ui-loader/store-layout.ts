/**
 * The release mirror layout v1, below the engine's `PTBK_UI_RELEASE_URL` (proposed 2026-10-26, pending the engine
 * team's review before the E-02 freeze): what X-03 publishes and the mock engine reads. Only `latest.json` is
 * unsigned, and it is a hint: whatever it names still has to verify.
 */
export const MIRROR_LAYOUT_V1 = Object.freeze({
    /** `{ "version": "<semver>" }`, the version `auto` and `manual` check. */
    latest: 'ui/latest.json',
    /** The `SignedRelease` JSON of one version. */
    release: (version: string): string => `release-log/ui-${version}.json`,
    /** The current revocation list's DSSE envelope; absent (404) means no list. */
    revocations: 'release-log/revocations.json',
    /** An artifact the release entry names; the engine finds the UI one by `kind: 'ui'`, never by name. */
    artifact: (version: string, name: string): string => `ui/${version}/${encodeURIComponent(name)}`,
});

/** The UI archive is a ustar `tar.zst` whose first entry is the `UiBundleManifest` under this name. */
export const ARCHIVE_MANIFEST_PATH = 'manifest.json';
