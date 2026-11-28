import { spawnSync } from 'node:child_process';
import {
    copyFileSync,
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
import { dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { renderInstallScript } from '../src/domain/registration/install-scripts';
import { installationOptions } from '../src/domain/registration/installation-options';
import { TEST_ENGINE_INSTALLATION } from '../src/testing/install-fixtures';

const origin = 'https://app.ptbk.test:8444';
const code = 'a'.repeat(26);
const link = `${origin}/link#${code}`;
const version = TEST_ENGINE_INSTALLATION.version;
const option = installationOptions(TEST_ENGINE_INSTALLATION, link).find((item) => item.kind === 'command');
if (!option) throw new Error('missing Windows command');
const command = option.commands.powershell;
const shell = process.env['PTBK_TEST_PWSH'] ?? (process.platform === 'win32' ? 'powershell.exe' : 'pwsh');
const available = spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0;
const directories: string[] = [];

afterEach(() => {
    for (const dir of directories.splice(0)) rmSync(dir, { recursive: true, force: true });
});

// npm and the CLI record just the handed-off arguments. No real registry, Windows settings or dashboard are needed.
const npmFixture = `
const fs = require('node:fs'), path = require('node:path');
if (process.env.PTBK_LINK) process.exit(81);
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(process.env.NPM_VERSION); process.exit(0); }
fs.appendFileSync(process.env.INSTALLS, JSON.stringify(args) + '\\n');
const prefix = args[args.indexOf('--prefix') + 1];
const entry = path.join(prefix, 'node_modules', 'ptbk', 'bin', 'ptbk.js');
fs.mkdirSync(path.dirname(entry), { recursive: true });
fs.copyFileSync(process.env.TEST_CLI, entry);
process.exit(Number(process.env.INSTALL_STATUS));
`;
const cliFixture = `
const fs = require('node:fs');
if (process.env.PTBK_LINK) process.exit(82);
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(process.env.REPORTED_VERSION); process.exit(Number(process.env.VERSION_STATUS)); }
const stdin = args.includes('--link-stdin') ? fs.readFileSync(0, 'utf8').trim() : null;
fs.appendFileSync(process.env.PAIRS, JSON.stringify({ args, stdin }) + '\\n');
process.exit(Number(process.env.PAIR_STATUS));
`;

const stubs = `
$ErrorActionPreference = 'Stop'
function Invoke-RestMethod { param($Uri)
    if ($Uri -ne '${origin}/install.ps1') { throw 'unexpected script' }
    [IO.File]::ReadAllText($env:SCRIPT)
}
function Get-Command { param($Name, $CommandType, $ErrorAction)
    if ($CommandType -ne 'Application') { throw 'unexpected command lookup' }
    switch ($Name) {
        'git.exe' { if (-not $env:MISSING_GIT) { Microsoft.PowerShell.Core\\Get-Command git -CommandType Application | Select-Object -First 1 } }
        'node.exe' { if (-not $env:MISSING_NODE) { @{ Source = $env:TEST_NODE } } }
        default { throw "unexpected executable: $Name" }
    }
}
function Invoke-WebRequest { param([switch]$UseBasicParsing, $Uri, $OutFile)
    if ($env:PTBK_LINK) { throw 'link leaked to download' }
    [IO.File]::AppendAllText($env:DOWNLOADS, $Uri + [Environment]::NewLine)
    [IO.File]::WriteAllText($OutFile, 'corrupt archive')
}
function Start-Process { throw 'unexpected installer process' }
`;

function fixture() {
    const dir = mkdtempSync(join(tmpdir(), 'ptbk-win-'));
    directories.push(dir);
    const local = join(dir, 'Local data [01] & Ž');
    const cwd = join(dir, 'cwd');
    const node = join(dir, 'tools', 'node.exe');
    const npm = join(dirname(node), 'node_modules/npm/bin/npm-cli.js');
    mkdirSync(dirname(npm), { recursive: true });
    mkdirSync(cwd);
    if (process.platform === 'win32') copyFileSync(process.execPath, node);
    else symlinkSync(process.execPath, node);
    writeFileSync(npm, npmFixture);
    const cli = join(dir, 'fixture-cli.js');
    writeFileSync(cli, cliFixture);
    const script = join(dir, 'script.ps1');
    writeFileSync(script, renderInstallScript('windows', TEST_ENGINE_INSTALLATION, origin));
    const installs = join(dir, 'installs'),
        pairs = join(dir, 'pairs'),
        downloads = join(dir, 'downloads');
    const root = join(local, 'Promptbook', 'terminal');
    const run = (overrides: NodeJS.ProcessEnv = {}, line: string = command, tty = false) => {
        // Only a disposable Windows runner runs the native smoke. Preserve a developer's user PATH in this fixture.
        const body =
            stubs +
            `
$oldPath = [Environment]::GetEnvironmentVariable('Path', 'User')
try { ${line} } finally {
    if ($env:OS -eq 'Windows_NT') { [Environment]::SetEnvironmentVariable('Path', $oldPath, 'User') }
}`;
        const encoded = Buffer.from(body, 'utf16le').toString('base64');
        return spawnSync(
            tty ? 'script' : shell,
            tty
                ? ['-qec', 'exec "$TEST_PWSH" -NoProfile -EncodedCommand "$TEST_BODY"', '/dev/null']
                : ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded],
            {
                cwd,
                encoding: 'utf8',
                timeout: 30_000,
                env: {
                    ...process.env,
                    LOCALAPPDATA: local,
                    PROCESSOR_ARCHITEW6432: '',
                    PROCESSOR_ARCHITECTURE: 'AMD64',
                    TEST_PWSH: shell,
                    TEST_BODY: encoded,
                    SCRIPT: script,
                    TEST_NODE: node,
                    TEST_CLI: cli,
                    INSTALLS: installs,
                    PAIRS: pairs,
                    DOWNLOADS: downloads,
                    NPM_VERSION: '10.9.0',
                    REPORTED_VERSION: version,
                    INSTALL_STATUS: '0',
                    VERSION_STATUS: '0',
                    PAIR_STATUS: '0',
                    ...overrides,
                },
            },
        );
    };
    return { run, installs, pairs, downloads, root, cwd, script };
}

describe('the copied Windows PowerShell command', { timeout: 60_000 }, () => {
    it('is one short line', () => {
        expect(command).toBe(`$env:PTBK_LINK='${code}'; irm ${origin}/install.ps1 | iex`);
    });

    it.skipIf(!available)('installs the exact private package once and hands each link to the verified CLI', () => {
        const f = fixture();
        for (let i = 0; i < 2; i++) {
            const result = f.run();
            expect(result.status, result.stderr).toBe(0);
        }
        const args: unknown = JSON.parse(readFileSync(f.installs, 'utf8').trim());
        expect(args).toEqual([
            'install',
            '--global=false',
            '--save-exact',
            '--prefix',
            expect.stringContaining(f.root),
            '--registry=https://registry.npmjs.org/',
            '--no-audit',
            '--no-fund',
            `ptbk@${version}`,
        ]);
        expect(
            readFileSync(f.pairs, 'utf8')
                .trim()
                .split('\n')
                .map((line) => JSON.parse(line) as unknown),
        ).toEqual(Array(2).fill({ args: ['init', '--prepare-only', '--link-stdin'], stdin: link }));
        expect(existsSync(f.downloads)).toBe(false);
        expect(existsSync(join(f.root, 'bin', 'ptbk.cmd'))).toBe(true);
        expect(readdirSync(f.cwd)).toEqual([]);
    });

    it.skipIf(!available || process.platform !== 'linux' || spawnSync('script', ['--version']).status !== 0)(
        'hands the interactive CLI the link with its terminal input still attached',
        () => {
            const f = fixture();
            const result = f.run({}, command, true);
            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(JSON.parse(readFileSync(f.pairs, 'utf8')) as unknown).toEqual({
                args: ['init', '--prepare-only', '--link', link],
                stdin: null,
            });
        },
    );

    it.skipIf(!available).each([
        { overrides: { INSTALL_STATUS: '7' }, error: 'npm could not install' },
        { overrides: { REPORTED_VERSION: '0.114.0-42' }, error: 'version mismatch' },
        { overrides: { VERSION_STATUS: '1' }, error: 'version mismatch' },
    ])('stops before pairing and can retry after a failed install or version check: $error', ({ overrides, error }) => {
        const f = fixture();
        const fail = f.run(overrides);
        expect(fail.status).not.toBe(0);
        expect(fail.stderr).toContain(error);
        expect(existsSync(f.pairs)).toBe(false);
        expect(readdirSync(join(f.root, 'cli'))).toEqual([]);
        const retry = f.run();
        expect(retry.status, retry.stderr).toBe(0);
    });

    it.skipIf(!available).each([
        { overrides: { MISSING_GIT: '1' }, archive: 'MinGit-2.56.1-64-bit.zip' },
        { overrides: { MISSING_NODE: '1' }, archive: 'node-v24.22.3-win-x64.zip' },
        {
            overrides: { NPM_VERSION: '9.1.0', PROCESSOR_ARCHITEW6432: 'ARM64' },
            archive: 'node-v24.22.3-win-arm64.zip',
        },
    ])('rejects a corrupt prerequisite before extraction: $archive', ({ overrides, archive }) => {
        const f = fixture();
        const result = f.run(overrides);
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Checksum mismatch');
        expect(readFileSync(f.downloads, 'utf8').trim()).toMatch(
            new RegExp('/' + archive.replaceAll('.', '\\.') + '$'),
        );
        expect(existsSync(f.installs)).toBe(false);
        expect(existsSync(f.pairs)).toBe(false);
        expect(readdirSync(join(f.root, 'tools'))).toEqual([]);
    });

    it.skipIf(!available)('reports a pairing failure and keeps the verified install available for a retry', () => {
        const f = fixture();
        const result = f.run({ PAIR_STATUS: '3' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('pairing failed');
        expect(existsSync(join(f.root, 'bin', 'ptbk.cmd'))).toBe(true);
        expect(f.run().status).toBe(0);
        expect(readFileSync(f.installs, 'utf8').trim().split('\n')).toHaveLength(1);
    });

    it.skipIf(!available)('rejects invalid codes and truncated responses before installing', () => {
        const f = fixture();
        expect(f.run({}, command.replace(code, 'short')).status).not.toBe(0);
        writeFileSync(f.script, readFileSync(f.script, 'utf8').trimEnd().slice(0, -1));
        expect(f.run().status).not.toBe(0);
        expect(existsSync(f.root)).toBe(false);
        expect(existsSync(f.pairs)).toBe(false);
    });
});
