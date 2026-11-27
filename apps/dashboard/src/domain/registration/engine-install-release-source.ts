import type { EngineInstallRelease } from '../../shared/engine-installation';

/** Published installation metadata only; pairing codes and project content never enter the source. */
export interface EngineInstallReleaseSource {
    current(fallback: EngineInstallRelease, signal: AbortSignal): Promise<EngineInstallRelease>;
}
