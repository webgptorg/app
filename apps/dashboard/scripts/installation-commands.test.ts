import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
    existsSync,
    mkdirSync,
    mkdtempSync,
    readFileSync,
    readdirSync,
    rmSync,
    symlinkSync,
    writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';

import { installationOptions } from '../src/domain/registration/installation-options';
import { TEST_ENGINE_INSTALLATION } from '../src/testing/install-fixtures';
import type { EngineInstallRelease } from '../src/shared/engine-installation';

const directories: string[] = [];
const VERSION = TEST_ENGINE_INSTALLATION.version;
const LINK = `https://app.ptbk.io/link#${'a'.repeat(26)}`;

afterEach(() => {
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporary() {
    const path = mkdtempSync(join(tmpdir(), 'ptbk-install-command-'));
    directories.push(path);
    return path;
}

function commands(link = LINK, release: EngineInstallRelease = TEST_ENGINE_INSTALLATION) {
    const option = installationOptions(release, link).find((option) => option.kind === 'command');
    if (option?.kind !== 'command') throw new Error('missing commands');
    return option.commands;
}

const SCRIPT_PATH = new URL('../public/assets/install-project-v1.sh', import.meta.url);
const SCRIPT_URL = 'https://app.ptbk.io/assets/install-project-v1.sh';
const trickyLink = LINK + "'$(touch injected)";
const fakeCli = `if [ "$1" = --version ]; then echo "$REPORTED_VERSION"; exit "$VERSION_STATUS"; fi
printf '%s\\n' "$@" > "$RECORD"
if [ "$3" = --link-stdin ]; then cat >> "$RECORD"; fi
exit "$PAIR_STATUS"`;

function executable(dir: string, name: string, body: string) {
    writeFileSync(join(dir, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
}

/** Inert download, OS package manager and npm. The actual copied command runs the shipped Bash script. */
function localFixture(platform = 'Linux') {
    const home = temporary();
    const bin = temporary();
    const archiveDir = temporary();
    const runtime = join(archiveDir, 'node-v24.1.0');
    mkdirSync(join(runtime, 'bin'), { recursive: true });
    symlinkSync(process.execPath, join(runtime, 'bin/node'));
    executable(
        join(runtime, 'bin'),
        'npm',
        `if [ "$1" = --version ]; then echo 10.0.0; exit; fi
[ "$1 $2 $3 $5 $6" = "install --global --prefix --registry=https://registry.npmjs.org/ ptbk@$EXPECTED_VERSION" ] || exit 80
[ "$INSTALL_STATUS" = 0 ] || exit "$INSTALL_STATUS"
cp "$TEST_CLI" "$4/bin/ptbk"`,
    );
    const archive = join(temporary(), 'node.tar.gz');
    const tar = spawnSync('tar', ['-czf', archive, '-C', archiveDir, 'node-v24.1.0']);
    expect(tar.status).toBe(0);
    const digest = createHash('sha256').update(readFileSync(archive)).digest('hex');
    const stem = platform === 'Darwin' ? 'darwin-arm64' : 'linux-x64';
    const record = join(temporary(), 'pair');
    const downloads = join(temporary(), 'requests');
    executable(
        bin,
        'uname',
        `if [ "$1" = -s ]; then echo ${platform}; else echo ${platform === 'Darwin' ? 'arm64' : 'x86_64'}; fi`,
    );
    executable(bin, 'git', 'test -f "$HOME/git-ready"');
    executable(bin, 'sudo', 'exec "$@"');
    executable(bin, 'id', 'echo 1000');
    executable(bin, 'apt-get', '[ "$1" = update ] || { [ "$*" = "install -y git" ] && touch "$HOME/git-ready"; }');
    executable(bin, 'brew', '[ "$*" = "install git" ] && touch "$HOME/git-ready"');
    for (const tool of ['node', 'npm', 'ptbk']) executable(bin, tool, 'exit 127');
    executable(bin, 'fixture-cli', fakeCli);
    executable(
        bin,
        'curl',
        `printf '%s\\n' "$@" >> "$DOWNLOADS"
if [ "$2" = "${SCRIPT_URL}" ]; then
    [ "$DOWNLOAD_STATUS" = 0 ] || exit "$DOWNLOAD_STATUS"
    cat "$TEST_SCRIPT"
elif [ "$4" = https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt ]; then
    echo "$DIGEST  node-v24.1.0-${stem}.tar.gz" > "$6"
elif [ "$4" = https://nodejs.org/dist/v24.1.0/node-v24.1.0-${stem}.tar.gz ]; then
    cp "$ARCHIVE" "$6"
else exit 81; fi`,
    );
    const env = {
        ...process.env,
        HOME: home,
        SHELL: '/bin/bash',
        PATH: bin + ':' + (process.env['PATH'] ?? ''),
        EXPECTED_VERSION: VERSION,
        REPORTED_VERSION: VERSION,
        VERSION_STATUS: '0',
        INSTALL_STATUS: '0',
        DOWNLOAD_STATUS: '0',
        PAIR_STATUS: '0',
        RECORD: record,
        DOWNLOADS: downloads,
        DIGEST: digest,
        ARCHIVE: archive,
        TEST_SCRIPT: fileURLToPath(SCRIPT_PATH),
        TEST_CLI: join(bin, 'fixture-cli'),
    };
    return { env, record, downloads, home };
}

describe('the copied Bash/zsh installation on a computer without usable Git, Node.js or npm', () => {
    for (const [shell, platform] of [
        ['bash', 'Linux'],
        ['zsh', 'Darwin'],
    ] as const) {
        const available = spawnSync(shell, ['--version']).status === 0;
        it.skipIf(!available)(`installs and reuses the exact CLI on ${platform} through ${shell}`, () => {
            const { env, record, downloads, home } = localFixture(platform);
            const cwd = temporary();
            for (let run = 0; run < 2; run++) {
                const result = spawnSync(shell, ['-c', commands(trickyLink).posix], { cwd, env, encoding: 'utf8' });
                expect(result.status, result.stderr).toBe(0);
                expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual([
                    'init',
                    '--prepare-only',
                    '--link-stdin',
                    trickyLink,
                ]);
                expect(readdirSync(cwd)).toEqual([]);
            }
            const requests = readFileSync(downloads, 'utf8');
            expect(requests).not.toContain(LINK);
            expect(requests.match(/https:\/\/nodejs\.org\/dist\/latest-v24\.x\/SHASUMS256/g)).toHaveLength(1);
            expect(readdirSync(join(home, '.local/share/promptbook'))).toEqual(['bin', 'cli']);
        });
    }

    it.skipIf(process.platform !== 'linux' || spawnSync('script', ['--version']).status !== 0)(
        'preserves the native first-access flow when the copied command is pasted into a terminal',
        () => {
            const { env, record } = localFixture();
            const result = spawnSync('script', ['-qec', commands(LINK).posix, '/dev/null'], {
                cwd: temporary(),
                env,
                encoding: 'utf8',
                timeout: 10_000,
            });
            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual(['init', '--prepare-only', '--link', LINK]);
        },
    );

    it.each([
        { DOWNLOAD_STATUS: '22' },
        { DIGEST: '0'.repeat(64) },
        { INSTALL_STATUS: '1' },
        { REPORTED_VERSION: '0.114.0-42' },
        { VERSION_STATUS: '1' },
    ])('stops before pairing when installation or verification fails: %o', (overrides) => {
        const { env, record } = localFixture();
        const result = spawnSync('bash', ['-c', commands().posix], { cwd: temporary(), env: { ...env, ...overrides } });
        expect(result.status).not.toBe(0);
        expect(existsSync(record)).toBe(false);
    });
});

describe('the copied Ubuntu bootstrap, with an inert downloaded script', () => {
    it.each([
        { valid: true, uid: 0 },
        { valid: false, uid: 0 },
        { valid: true, uid: 1000 },
        { valid: false, uid: 1000 },
    ])('checks downloaded bytes before sudo and passes the link on stdin (case: %o)', ({ valid, uid }) => {
        const cwd = temporary();
        const bootstrap = join(cwd, 'bootstrap');
        const args = join(cwd, 'arguments');
        const body = '#!/usr/bin/env bash\nIFS= read -r link\nprintf "%s\\n" "$link" "$@" > "$PTBK_TEST_ARGS"\n';
        writeFileSync(bootstrap, body);
        const checksum = createHash('sha256').update(body).digest('hex');
        const release = { ...TEST_ENGINE_INSTALLATION, bootstrapSha256: valid ? checksum : '0'.repeat(64) };
        const fixture =
            `id() { printf '%s\\n' '${String(uid)}'; }\n` +
            'curl() { cp "$PTBK_TEST_BOOTSTRAP" "$4"; }\n' +
            (uid === 0 ? 'sudo() { return 97; }\n' : 'sudo() { if [ "$1" = -v ]; then return 0; fi; "$@"; }\n');
        const result = spawnSync('bash', ['-c', fixture + commands(LINK, release).ubuntu], {
            cwd,
            env: { ...process.env, PTBK_TEST_BOOTSTRAP: bootstrap, PTBK_TEST_ARGS: args, TMPDIR: cwd },
            encoding: 'utf8',
            timeout: 10_000,
        });
        expect(result.status === 0, result.stderr).toBe(valid);
        expect(existsSync(args)).toBe(valid);
        if (valid)
            expect(readFileSync(args, 'utf8').split('\n')).toEqual([
                LINK,
                '--version',
                VERSION,
                '--prepare-only',
                '--link-stdin',
                '',
            ]);
        expect(readdirSync(cwd).filter((file) => file.startsWith('tmp.'))).toEqual([]);
    });
});

describe('the copied PowerShell installer', () => {
    const executable = process.env['PTBK_TEST_PWSH'] ?? 'pwsh';
    const available =
        spawnSync(executable, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0;
    const digest = createHash('sha256').update('fixture setup').digest('hex');
    const fixture = `
function Invoke-WebRequest { param([switch]$UseBasicParsing, $Uri, $OutFile)
    if ($Uri -ne $env:EXPECTED_URL) { throw 'unexpected download' }
    [IO.File]::WriteAllText($OutFile, 'fixture setup')
}
function Start-Process { param($FilePath, $ArgumentList, [switch]$Wait, [switch]$PassThru)
    if (-not $Wait -or -not $PassThru -or ($ArgumentList -join ' ') -ne '/PrepareOnly=yes /NORESTART') { throw 'unexpected setup arguments' }
    [IO.File]::WriteAllText($env:SETUP, $FilePath)
    @{ ExitCode = [int]$env:SETUP_STATUS }
}
function Get-Command { param($Name, $CommandType, $ErrorAction)
    if ($Name -ne 'ptbk.cmd' -or $CommandType -ne 'Application') { throw 'unexpected executable' }
    @{ Source = 'Invoke-FixtureCli' }
}
function Invoke-FixtureCli {
    if ($args[0] -eq '--version') { $global:LASTEXITCODE = [int]$env:VERSION_STATUS; $env:REPORTED_VERSION; return }
    [IO.File]::WriteAllLines($env:RECORD, [string[]](@($args) + @($input)))
    $global:LASTEXITCODE = 0
}
`;
    it.skipIf(!available).each([
        { valid: true, setup: 0, version: VERSION, status: 0, pairs: true },
        { valid: false, setup: 0, version: VERSION, status: 0, pairs: false },
        { valid: true, setup: 1, version: VERSION, status: 0, pairs: false },
        { valid: true, setup: 0, version: '0.114.0-42', status: 0, pairs: false },
        { valid: true, setup: 0, version: VERSION, status: 1, pairs: false },
    ])('checks the exact EXE before running it and its CLI before using the private link: %o', (scenario) => {
        const cwd = temporary();
        const record = join(temporary(), 'pair');
        const setup = join(temporary(), 'setup');
        const release = { ...TEST_ENGINE_INSTALLATION, windowsSha256: scenario.valid ? digest : '0'.repeat(64) };
        const result = spawnSync(
            executable,
            [
                '-NoLogo',
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                fixture + commands(trickyLink, release).powershell,
            ],
            {
                cwd,
                encoding: 'utf8',
                timeout: 10_000,
                env: {
                    ...process.env,
                    EXPECTED_URL: `https://github.com/webgptorg/promptbook/releases/download/v${VERSION}/Promptbook-Setup-${VERSION}-windows-x64.exe`,
                    RECORD: record,
                    SETUP: setup,
                    SETUP_STATUS: String(scenario.setup),
                    REPORTED_VERSION: scenario.version,
                    VERSION_STATUS: String(scenario.status),
                },
            },
        );
        expect(result.status === 0, result.stderr).toBe(scenario.pairs);
        expect(existsSync(setup)).toBe(scenario.valid);
        if (scenario.valid) expect(existsSync(readFileSync(setup, 'utf8'))).toBe(false);
        expect(existsSync(record)).toBe(scenario.pairs);
        if (scenario.pairs)
            expect(readFileSync(record, 'utf8').trim().split(/\r?\n/)).toEqual([
                'init',
                '--prepare-only',
                '--link-stdin',
                trickyLink,
            ]);
        expect(readdirSync(cwd)).toEqual([]);
    });
});
