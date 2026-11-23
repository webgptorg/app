import type { EngineInstallRelease, InstallationOption } from '../../shared/engine-installation';

/** Quote a literal argument for Bash/zsh, including a configured origin containing an apostrophe. */
function posix(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershell(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

/** Always use the installed executable and stop before pairing on a failed or stale installation. */
function windowsPairing(version: string, link: string): string {
    return `$cli = (Get-Command ptbk.cmd -CommandType Application -ErrorAction Stop).Source
$installed = & $cli --version
if ($LASTEXITCODE -ne 0 -or $installed -ne '${version}') { throw 'Promptbook version mismatch.' }
$link = ${powershell(link)}
if ([Environment]::UserInteractive -and -not [Console]::IsInputRedirected -and -not [Console]::IsOutputRedirected) {
    & $cli init --prepare-only --link $link
} else { $link | & $cli init --prepare-only --link-stdin }
if ($LASTEXITCODE -ne 0) { throw 'Promptbook pairing failed.' }`;
}

/**
 * SHA-256 of public/assets/install-project-v1.sh. The copied command runs only these bytes, so a stale cache, the SPA
 * fallback page or a later edit of the asset can never reach Bash. A test keeps it in step with the file.
 */
export const INSTALL_SCRIPT_SHA256 = '947f53ba55e20a72f3ffd2576cafdddf9ce381dab8c76718710f84d9f5499062';

function posixInstaller(url: string, version: string, link: string): string {
    return `( set -euo pipefail
installer=$(mktemp)
trap 'rm -f "$installer"' EXIT
curl -fsSL ${posix(url)} -o "$installer"
digest=$(if command -v sha256sum >/dev/null; then sha256sum < "$installer"; else shasum -a 256 < "$installer"; fi)
[ "\${digest%% *}" = '${INSTALL_SCRIPT_SHA256}' ] || { echo 'Installer checksum mismatch.' >&2; exit 1; }
bash "$installer" '${version}' 3<<<${posix(link)}
)`;
}

/** Progress is silenced because Windows PowerShell 5.1 downloads the large EXE many times slower while drawing it. */
function windowsInstaller(url: string, digest: string, pairing: string): string {
    return `& {
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$file = Join-Path ([IO.Path]::GetTempPath()) ("ptbk-" + [guid]::NewGuid() + ".exe")
try {
    Invoke-WebRequest -UseBasicParsing -Uri '${url}' -OutFile $file
    if ((Get-FileHash -LiteralPath $file -Algorithm SHA256).Hash -ne '${digest}') { throw 'Installer checksum mismatch.' }
    $setup = Start-Process -FilePath $file -ArgumentList '/PrepareOnly=yes','/NORESTART' -Wait -PassThru
    if ($setup.ExitCode -ne 0) { throw 'Promptbook installation did not finish.' }
} finally { Remove-Item -LiteralPath $file -Force -ErrorAction SilentlyContinue }
$env:Path = (@([Environment]::GetEnvironmentVariable('Path', 'User'), [Environment]::GetEnvironmentVariable('Path', 'Machine'), $env:Path) | Where-Object { $_ }) -join [IO.Path]::PathSeparator
${pairing}
}`;
}

/** Pinned Ubuntu bootstrap: verify before sudo, pass the link only on stdin, run the engine as promptbook. */
function ubuntuCommand(release: EngineInstallRelease, link: string): string {
    const url = `https://raw.githubusercontent.com/webgptorg/promptbook/${release.bootstrapRevision}/deploy/ubuntu/install.sh`;
    return `( set -eu\ninstaller=$(mktemp)\ntrap 'rm -f "$installer"' EXIT\ncurl -fsSL ${posix(url)} -o "$installer"\nprintf '%s  %s\\n' '${release.bootstrapSha256}' "$installer" | sha256sum -c -\nelevate=()\nif [ "$(id -u)" -ne 0 ]; then sudo -v; elevate=(sudo); fi\nprintf '%s\\n' ${posix(link)} | "\${elevate[@]}" bash "$installer" --version '${release.version}' --prepare-only --link-stdin\n)`;
}

/** Based on the public installation guide, with project creation deliberately deferred to engine-owned UI. */
function aiPrompt(
    locale: 'cs' | 'en',
    target: 'local' | 'server',
    release: EngineInstallRelease,
    command: string,
): string {
    const server = target === 'server';
    if (locale === 'cs') {
        return `Nainstaluj Promptbook ${release.version} ${server ? 'na můj existující Ubuntu 24.04 x86-64 VPS přes SSH' : 'na tento počítač'} a připoj nový engine k propojení z App uvedenému v příkazu níže.
Základní návod: https://www.ptbk.io/cs/open-source
Pravidla a předem zadané odpovědi:
- Použij tuto publikovanou verzi stejné produktové řady; žádný nepřipnutý dist-tag. Zkontroluj verzi a skutečnou cestu ptbk. Po chybě instalace ani při nesprávné verzi nepokračuj starým CLI.
- Zjisti systém, shell a dostupné závislosti. Zachovej kompatibilní Node.js, npm, Git, prohlížeč, profily, data a přihlášení. Potřebné závislosti doplň z oficiálních zdrojů v rámci oprávnění nástroje. Neobcházej povinná schválení, sandbox, ověření SSH hostitele ani přihlášení; tajné údaje nechtěj v chatu.
- ${server ? 'Chybí-li jednoznačný cíl SSH, vyžádej si jej. Ověř Ubuntu 24.04 x86-64 se systemd. Pro systém použij root/sudo; engine a AI přihlášení patří běžnému účtu promptbook. Použij níže připnutý bootstrap a ověř jeho checksum. Nekupuj VPS.' : 'Spusť níže uvedený příkaz pro tento systém pod běžným uživatelským účtem. Instalátor doplní potřebné nástroje. Na Windows dokonči oficiální instalační průvodce.'}
- Spusť pouze init --prepare-only se zde uvedeným propojením. Nevol samostatnou agendu, složku ani verification-only projekt podle obecného webového promptu. O umístění rozhodne engine ve svém standardním kořeni projektů. Existující projekty a jejich stav běhu zachovej.
- Stejný odkaz navazuje na rozpracované nastavení. Při opakování nevytvářej jinou identitu ani nepřepojuj cizí engine.
- Otevři nebo bezpečně předej owner setup link z enginu. Tento jiný odkaz dává přístup vlastníkovi: neodesílej jej Dashboardu, do chatu ani do logů. Uživatel na originu enginu vytvoří passkey, zadá agendu/přílohy a vybere a přihlásí AI nástroje. Nativní terminálový fallback zůstává dostupný.
- Ověř připojení a stav podepsaného UI; relay sám nepotvrzuje dostupnost schváleného UI bundle. Neobcházej podpisy. Chybějící konfiguraci nebo neověřený krok výslovně uveď. Ukaž, jak pokračovat příkazem ptbk onboarding --id <engine-id>; dříve pozastavenou agendu ponech pozastavenou.
Párovací URL níže je citlivá. Nezapisuj ji do souborů projektu ani do reportu; vložený příkaz může zůstat v historii shellu.
Příkaz ${server ? 'pro Bash na VPS' : 'pro Bash/zsh (na Windows použij odpovídající PowerShell variantu z App)'}:
${command}`;
    }
    return `Install Promptbook ${release.version} ${server ? 'on my existing Ubuntu 24.04 x86-64 VPS over SSH' : 'on this computer'} and pair the new engine using the App link in the command below.
Base guide: https://www.ptbk.io/en/open-source
Rules and supplied defaults:
- Use this published version in the same product line, never an unpinned dist-tag. Verify the actual ptbk path and version. Stop after an installation failure or a version mismatch instead of using an old CLI.
- Detect the system, shell and dependencies. Preserve compatible Node.js, npm, Git, browsers, profiles, data and sign-ins. Install necessary dependencies from official sources within the tool's permissions. Do not bypass mandatory approvals, the sandbox, SSH host verification or sign-in; never request secrets in chat.
- ${server ? 'Ask for an unambiguous SSH target if missing. Check Ubuntu 24.04 x86-64 with systemd. Use root/sudo for system preparation only; the engine and AI sign-ins belong to the ordinary promptbook user. Use the pinned bootstrap below and verify its checksum. Do not buy a VPS.' : 'Use the supplied command for this operating system as the ordinary user. The installer prepares the required tools. On Windows complete the official setup wizard.'}
- Run only init --prepare-only with this pairing context. Do not choose an agenda, folder or verification-only project from the generic website prompt. The engine chooses its standard projects home. Preserve existing projects and their running or paused state.
- Repeating the same link resumes saved work. Never create a different identity or silently re-pair another engine.
- Open or privately hand over the engine-generated owner setup link. This separate link grants ownership: never send it to the Dashboard, chat or logs. On the engine's origin the user creates a passkey, supplies the brief/files, selects AI tools and signs in. Preserve the native terminal fallback.
- Verify connectivity and the signed UI status: a working relay does not prove an approved UI bundle is available. Never bypass signatures. Report missing configuration and unverified steps. Explain ptbk onboarding --id <engine-id> for continuation; do not resume a previously paused agenda.
The pairing URL below is sensitive. Do not write it to project files or reports; pasted commands may remain in shell history.
Command ${server ? 'for Bash on the VPS' : 'for Bash/zsh (on Windows use the corresponding PowerShell variant from App)'}:
${command}`;
}

/** Issuance-only presentation. Neither project content nor an owner setup secret enters these options. */
export function installationOptions(release: EngineInstallRelease, link: string): InstallationOption[] {
    const script = new URL('/assets/install-project-v1.sh', link).href;
    const windowsUrl = `https://github.com/webgptorg/promptbook/releases/download/v${release.version}/Promptbook-Setup-${release.version}-windows-x64.exe`;
    const afterInstall = windowsPairing(release.version, link);
    const local = {
        posix: posixInstaller(script, release.version, link),
        powershell: windowsInstaller(windowsUrl, release.windowsSha256, afterInstall),
    };
    const ubuntu = ubuntuCommand(release, link);
    return [
        { kind: 'command', id: 'new-project', commands: { ...local, ubuntu } },
        {
            kind: 'ai',
            id: 'ai',
            prompts: {
                cs: {
                    local: aiPrompt(
                        'cs',
                        'local',
                        release,
                        `${local.posix}\n\nWindows PowerShell:\n${local.powershell}`,
                    ),
                    server: aiPrompt('cs', 'server', release, ubuntu),
                },
                en: {
                    local: aiPrompt(
                        'en',
                        'local',
                        release,
                        `${local.posix}\n\nWindows PowerShell:\n${local.powershell}`,
                    ),
                    server: aiPrompt('en', 'server', release, ubuntu),
                },
            },
        },
        {
            kind: 'download',
            id: 'windows',
            version: release.version,
            url: windowsUrl,
            sha256: release.windowsSha256,
            afterInstall,
        },
    ];
}
