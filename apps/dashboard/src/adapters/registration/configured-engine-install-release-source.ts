import type { EngineInstallReleaseSource } from '../../domain/registration/engine-install-release-source';

/** Development and in-memory tests use their configured fixtures without public network access. */
export function createConfiguredEngineInstallReleaseSource(): EngineInstallReleaseSource {
    return { current: (release) => Promise.resolve(release) };
}
