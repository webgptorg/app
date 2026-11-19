import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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

describe('the copied local block, executed with inert npm/ptbk fixtures', () => {
    for (const shell of ['bash', 'zsh']) {
        const available = spawnSync(shell, ['--version']).status === 0;
        describe.skipIf(!available)(shell, () => {
            it.each([
                { installStatus: 0, version: VERSION, versionStatus: 0, expected: true },
                { installStatus: 42, version: VERSION, versionStatus: 0, expected: false },
                { installStatus: 0, version: '0.114.0-42', versionStatus: 0, expected: false },
                { installStatus: 0, version: VERSION, versionStatus: 1, expected: false },
            ])(
                'guards installation and the CLI actually on PATH: %o',
                ({ installStatus, version, versionStatus, expected }) => {
                    const cwd = temporary();
                    const args = join(temporary(), 'arguments');
                    const fixture = `npm() { return ${String(installStatus)}; }\nptbk() { if [ "$1" = --version ]; then printf '%s\\n' '${version}'; return ${String(versionStatus)}; else printf '%s\\n' "$@" > "$PTBK_TEST_ARGS"; fi; }\n`;
                    const result = spawnSync(shell, ['-c', fixture + commands().posix], {
                        cwd,
                        env: { ...process.env, PTBK_TEST_ARGS: args },
                        encoding: 'utf8',
                        timeout: 10_000,
                    });
                    expect(result.status === 0, result.stderr).toBe(expected);
                    expect(readdirSync(cwd)).toEqual([]);
                    expect(existsSync(args)).toBe(expected);
                    if (expected)
                        expect(readFileSync(args, 'utf8').split('\n')).toEqual([
                            'init',
                            '--prepare-only',
                            '--link',
                            LINK,
                            '',
                        ]);
                },
            );

            it('passes quotes, fragments and shell metacharacters as one literal argument', () => {
                const cwd = temporary();
                const args = join(temporary(), 'arguments');
                const link = `${LINK}'$(touch injected)`;
                const fixture = `npm() { return 0; }\nptbk() { if [ "$1" = --version ]; then echo '${VERSION}'; else printf '%s\\n' "$@" > "$PTBK_TEST_ARGS"; fi; }\n`;
                const result = spawnSync(shell, ['-c', fixture + commands(link).posix], {
                    cwd,
                    env: { ...process.env, PTBK_TEST_ARGS: args },
                    encoding: 'utf8',
                    timeout: 10_000,
                });
                expect(result.status, result.stderr).toBe(0);
                expect(readFileSync(args, 'utf8')).toContain(link);
                expect(readdirSync(cwd)).toEqual([]);
            });
        });
    }
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

describe('the copied PowerShell block, executed with inert native-command fixtures', () => {
    const executable = process.env['PTBK_TEST_PWSH'] ?? 'pwsh';
    const available =
        spawnSync(executable, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()']).status === 0;
    it.skipIf(!available).each([
        { installStatus: 0, version: VERSION, versionStatus: 0, expected: true },
        { installStatus: 42, version: VERSION, versionStatus: 0, expected: false },
        { installStatus: 0, version: '0.114.0-42', versionStatus: 0, expected: false },
        { installStatus: 0, version: VERSION, versionStatus: 1, expected: false },
    ])('guards npm status and actual CLI version: %o', ({ installStatus, version, versionStatus, expected }) => {
        const cwd = temporary();
        const args = join(temporary(), 'arguments');
        const fixture = `function npm { $global:LASTEXITCODE = ${String(installStatus)} }\nfunction ptbk { if ($args[0] -eq '--version') { $global:LASTEXITCODE = ${String(versionStatus)}; '${version}' } else { [IO.File]::WriteAllLines($env:PTBK_TEST_ARGS, [string[]]$args) } }\n`;
        const result = spawnSync(
            executable,
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', fixture + commands().powershell],
            {
                cwd,
                env: { ...process.env, PTBK_TEST_ARGS: args },
                encoding: 'utf8',
                timeout: 10_000,
            },
        );
        expect(result.status === 0, result.stderr).toBe(expected);
        expect(existsSync(args)).toBe(expected);
        expect(readdirSync(cwd)).toEqual([]);
        if (expected)
            expect(readFileSync(args, 'utf8').trim().split(/\r?\n/)).toEqual([
                'init',
                '--prepare-only',
                '--link',
                LINK,
            ]);
    });
    it.skipIf(!available)('keeps an apostrophe and PowerShell expressions in one literal URL argument', () => {
        const cwd = temporary();
        const args = join(temporary(), 'arguments');
        const link = `${LINK}'$(New-Item injected)`;
        const fixture = `function npm { $global:LASTEXITCODE = 0 }\nfunction ptbk { if ($args[0] -eq '--version') { '${VERSION}' } else { [IO.File]::WriteAllLines($env:PTBK_TEST_ARGS, [string[]]$args) } }\n`;
        const result = spawnSync(
            executable,
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', fixture + commands(link).powershell],
            { cwd, env: { ...process.env, PTBK_TEST_ARGS: args }, encoding: 'utf8', timeout: 10_000 },
        );
        expect(result.status, result.stderr).toBe(0);
        expect(readFileSync(args, 'utf8')).toContain(link);
        expect(readdirSync(cwd)).toEqual([]);
    });
    it.skipIf(!available)('stops when npm is missing even if an old last-exit code and a matching CLI remain', () => {
        const cwd = temporary();
        const args = join(temporary(), 'arguments');
        const fixture = `$global:LASTEXITCODE = 0\nfunction ptbk { if ($args[0] -eq '--version') { '${VERSION}' } else { [IO.File]::WriteAllLines($env:PTBK_TEST_ARGS, [string[]]$args) } }\n`;
        const result = spawnSync(
            executable,
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', fixture + commands().powershell],
            {
                cwd,
                env: { ...process.env, PATH: cwd, PTBK_TEST_ARGS: args },
                encoding: 'utf8',
                timeout: 10_000,
            },
        );
        expect(result.status).not.toBe(0);
        expect(existsSync(args)).toBe(false);
    });
});
