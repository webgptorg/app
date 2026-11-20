import type { EngineInstallRelease, InstallationOption } from '../../shared/engine-installation';

/** Quote a literal argument for Bash/zsh, including a configured origin containing an apostrophe. */
function posix(value: string): string {
    return `'${value.replaceAll("'", "'\\''")}'`;
}

function powershell(value: string): string {
    return `'${value.replaceAll("'", "''")}'`;
}

/** Check the executable actually on PATH; a failed install never falls through to an older global CLI. */
function localCommands(version: string, link: string) {
    return {
        posix: `npm install --global ptbk@${version} &&\n{ ptbk_installed_version=$(ptbk --version) && [ "$ptbk_installed_version" = '${version}' ] || { echo 'Open a new terminal: ptbk version mismatch.' >&2; false; }; } &&\nptbk init --prepare-only --link ${posix(link)}`,
        powershell: `npm install --global ptbk@${version}\nif (-not $? -or $LASTEXITCODE -ne 0) { throw 'Promptbook installation failed.' }\n$ptbkInstalledVersion = ptbk --version\nif (-not $? -or $LASTEXITCODE -ne 0 -or $ptbkInstalledVersion -ne '${version}') { throw 'Open a new terminal: ptbk version mismatch.' }\nptbk init --prepare-only --link ${powershell(link)}`,
    };
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
- ${server ? 'Chybí-li jednoznačný cíl SSH, vyžádej si jej. Ověř Ubuntu 24.04 x86-64 se systemd. Pro systém použij root/sudo; engine a AI přihlášení patří běžnému účtu promptbook. Použij níže připnutý bootstrap a ověř jeho checksum. Nekupuj VPS.' : 'Použij běžný účet tohoto počítače. Při chybě oprávnění globálního npm použij podporovaný uživatelský prefix nebo správce verzí a oprav PATH. Pro PowerShell přepiš návaznost příkazů na kontrolu $LASTEXITCODE; Bash syntaxi do něj nevkládej.'}
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
- ${server ? 'Ask for an unambiguous SSH target if missing. Check Ubuntu 24.04 x86-64 with systemd. Use root/sudo for system preparation only; the engine and AI sign-ins belong to the ordinary promptbook user. Use the pinned bootstrap below and verify its checksum. Do not buy a VPS.' : 'Use the ordinary user of this computer. Resolve global npm permission failures with a supported user prefix or version manager and PATH. In PowerShell use explicit $LASTEXITCODE checks instead of pasting Bash chaining.'}
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
    const local = localCommands(release.version, link);
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
            url: `https://github.com/webgptorg/promptbook/releases/download/v${release.version}/Promptbook-Setup-${release.version}-windows-x64.exe`,
            sha256: release.windowsSha256,
            afterInstall: local.powershell,
        },
    ];
}
