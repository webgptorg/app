import { parseLinkUrl } from '@ptbk/protocol';

import type { EngineInstallRelease, InstallationOption } from '../../shared/engine-installation';

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

/** Stable public paths of the scripts behind the one-line commands, served by the dashboard Worker. */
export const INSTALL_SCRIPT_PATHS = {
    desktop: '/install.sh',
    server: '/install-server.sh',
    windows: '/install.ps1',
} as const;

export type InstallScript = keyof typeof INSTALL_SCRIPT_PATHS;

/** One line per platform; the code travels in the environment, never in argv, and the script carries the release. */
function oneLineCommands(origin: string, code: string) {
    return {
        posix: `curl -fsSL ${origin}${INSTALL_SCRIPT_PATHS.desktop} | PTBK_LINK=${code} bash`,
        powershell: `$env:PTBK_LINK='${code}'; irm ${origin}${INSTALL_SCRIPT_PATHS.windows} | iex`,
        ubuntu: `curl -fsSL ${origin}${INSTALL_SCRIPT_PATHS.server} | PTBK_LINK=${code} bash`,
    };
}

/** Based on the public installation guide, with project creation deliberately deferred to engine-owned UI. */
function aiPrompt(locale: 'cs' | 'en', target: 'local' | 'server', command: string): string {
    const server = target === 'server';
    if (locale === 'cs') {
        return `Nainstaluj Promptbook ${server ? 'na můj existující Ubuntu 24.04 x86-64 VPS přes SSH' : 'na tento počítač'} a připoj nový engine k propojení z App uvedenému v příkazu níže.
Základní návod: https://www.ptbk.io/cs/open-source
Pravidla a předem zadané odpovědi:
- Instalátor připne jednu přesnou publikovanou verzi; nepoužívej nepřipnutý dist-tag. Zkontroluj verzi a skutečnou cestu ptbk. Po chybě instalace ani při nesprávné verzi nepokračuj starým CLI.
- Zjisti systém, shell a dostupné závislosti. Zachovej kompatibilní Node.js, npm, Git, prohlížeč, profily, data a přihlášení. Potřebné závislosti doplň z oficiálních zdrojů v rámci oprávnění nástroje. Neobcházej povinná schválení, sandbox, ověření SSH hostitele ani přihlášení; tajné údaje nechtěj v chatu.
- ${server ? 'Chybí-li jednoznačný cíl SSH, vyžádej si jej. Ověř Ubuntu 24.04 x86-64 se systemd. Pro systém použij root/sudo; engine a AI přihlášení patří běžnému účtu promptbook. Použij níže uvedený příkaz; jeho skript ověří checksum připnutého bootstrapu. Nekupuj VPS.' : 'Spusť níže uvedený příkaz pro tento systém pod běžným uživatelským účtem. Instalátor doplní potřebné nástroje. Na Windows dokonči oficiální instalační průvodce.'}
- Spusť pouze init --prepare-only se zde uvedeným propojením. Nevol samostatnou agendu, složku ani verification-only projekt podle obecného webového promptu. O umístění rozhodne engine ve svém standardním kořeni projektů. Existující projekty a jejich stav běhu zachovej.
- Stejný odkaz navazuje na rozpracované nastavení. Při opakování nevytvářej jinou identitu ani nepřepojuj cizí engine.
- Otevři nebo bezpečně předej owner setup link z enginu. Tento jiný odkaz dává přístup vlastníkovi: neodesílej jej Dashboardu, do chatu ani do logů. Uživatel na originu enginu vytvoří passkey, zadá agendu/přílohy a vybere a přihlásí AI nástroje. Nativní terminálový fallback zůstává dostupný.
- Ověř připojení a stav podepsaného UI; relay sám nepotvrzuje dostupnost schváleného UI bundle. Neobcházej podpisy. Chybějící konfiguraci nebo neověřený krok výslovně uveď. Ukaž, jak pokračovat příkazem ptbk onboarding --id <engine-id>; dříve pozastavenou agendu ponech pozastavenou.
Párovací kód v příkazu níže je citlivý. Nezapisuj ji do souborů projektu ani do reportu; vložený příkaz může zůstat v historii shellu.
Příkaz ${server ? 'pro Bash na VPS' : 'pro Bash/zsh (na Windows použij odpovídající PowerShell variantu z App)'}:
${command}`;
    }
    return `Install Promptbook ${server ? 'on my existing Ubuntu 24.04 x86-64 VPS over SSH' : 'on this computer'} and pair the new engine using the App link in the command below.
Base guide: https://www.ptbk.io/en/open-source
Rules and supplied defaults:
- The installer pins one exact published version; never use an unpinned dist-tag. Verify the actual ptbk path and version. Stop after an installation failure or a version mismatch instead of using an old CLI.
- Detect the system, shell and dependencies. Preserve compatible Node.js, npm, Git, browsers, profiles, data and sign-ins. Install necessary dependencies from official sources within the tool's permissions. Do not bypass mandatory approvals, the sandbox, SSH host verification or sign-in; never request secrets in chat.
- ${server ? 'Ask for an unambiguous SSH target if missing. Check Ubuntu 24.04 x86-64 with systemd. Use root/sudo for system preparation only; the engine and AI sign-ins belong to the ordinary promptbook user. Use the command below; its script verifies the checksum of the pinned bootstrap. Do not buy a VPS.' : 'Use the supplied command for this operating system as the ordinary user. The installer prepares the required tools. On Windows complete the official setup wizard.'}
- Run only init --prepare-only with this pairing context. Do not choose an agenda, folder or verification-only project from the generic website prompt. The engine chooses its standard projects home. Preserve existing projects and their running or paused state.
- Repeating the same link resumes saved work. Never create a different identity or silently re-pair another engine.
- Open or privately hand over the engine-generated owner setup link. This separate link grants ownership: never send it to the Dashboard, chat or logs. On the engine's origin the user creates a passkey, supplies the brief/files, selects AI tools and signs in. Preserve the native terminal fallback.
- Verify connectivity and the signed UI status: a working relay does not prove an approved UI bundle is available. Never bypass signatures. Report missing configuration and unverified steps. Explain ptbk onboarding --id <engine-id> for continuation; do not resume a previously paused agenda.
The pairing code in the command below is sensitive. Do not write it to project files or reports; pasted commands may remain in shell history.
Command ${server ? 'for Bash on the VPS' : 'for Bash/zsh (on Windows use the corresponding PowerShell variant from App)'}:
${command}`;
}

/** Issuance-only presentation. Neither project content nor an owner setup secret enters these options. */
export function installationOptions(release: EngineInstallRelease, link: string): InstallationOption[] {
    const parsed = parseLinkUrl(link);
    if (parsed.kind !== 'ok') throw new TypeError('installationOptions needs a link URL');
    const commands = oneLineCommands(parsed.dashboardOrigin, parsed.linkCode);
    const local = `${commands.posix}\n\nWindows PowerShell:\n${commands.powershell}`;
    const windowsUrl = `https://github.com/webgptorg/promptbook/releases/download/v${release.version}/Promptbook-Setup-${release.version}-windows-x64.exe`;
    return [
        { kind: 'command', id: 'new-project', commands },
        {
            kind: 'ai',
            id: 'ai',
            prompts: {
                cs: { local: aiPrompt('cs', 'local', local), server: aiPrompt('cs', 'server', commands.ubuntu) },
                en: { local: aiPrompt('en', 'local', local), server: aiPrompt('en', 'server', commands.ubuntu) },
            },
        },
        {
            kind: 'download',
            id: 'windows',
            version: release.version,
            url: windowsUrl,
            sha256: release.windowsSha256,
            afterInstall: windowsPairing(release.version, link),
        },
    ];
}
