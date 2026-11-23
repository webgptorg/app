import type { EngineInstallRelease } from '../../shared/engine-installation';
import desktop from './install-scripts/install.sh?raw';
import windows from './install-scripts/install.ps1?raw';
import server from './install-scripts/install-server.sh?raw';
import type { InstallScript } from './installation-options';

/**
 * The scripts behind the copied one-line commands.
 *
 * The page that shows a command and the script it fetches come from the same origin over TLS, so a checksum the origin
 * embedded in the command would add nothing against that origin. Its one job was integrity against a stale cache or
 * the SPA fallback page reaching a shell. That is kept instead by serving these only from Worker routes (never static
 * assets, so never the SPA fallback) as `text/plain` with `no-store`, and by each script running nothing before its
 * last line. Everything version-specific lives in the script, which still verifies the downloaded Promptbook
 * bootstrap or EXE by SHA-256 before running it.
 */
const TEMPLATES: Readonly<Record<InstallScript, string>> = { desktop, server, windows };

/** Values land inside single-quoted shell and PowerShell strings, so anything that could end the quote is refused. */
const SAFE_VALUE = /^[A-Za-z0-9.:/-]+$/;

export function renderInstallScript(script: InstallScript, release: EngineInstallRelease, origin: string): string {
    const values = {
        __PTBK_ORIGIN__: origin,
        __PTBK_VERSION__: release.version,
        __PTBK_WINDOWS_SHA256__: release.windowsSha256,
        __PTBK_BOOTSTRAP_REVISION__: release.bootstrapRevision,
        __PTBK_BOOTSTRAP_SHA256__: release.bootstrapSha256,
    };
    let text = TEMPLATES[script];
    for (const [placeholder, value] of Object.entries(values)) {
        if (!SAFE_VALUE.test(value)) throw new Error(`unsafe ${placeholder} for an install script`);
        text = text.replaceAll(placeholder, value);
    }
    return text;
}
