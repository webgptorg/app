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
import { afterEach, describe, expect, it } from 'vitest';

import { renderInstallScript } from '../src/domain/registration/install-scripts';
import { installationOptions, type InstallScript } from '../src/domain/registration/installation-options';
import { TEST_ENGINE_INSTALLATION } from '../src/testing/install-fixtures';
import type { EngineInstallRelease } from '../src/shared/engine-installation';

const directories: string[] = [];
const VERSION = TEST_ENGINE_INSTALLATION.version;
const ORIGIN = 'https://app.ptbk.io';
const CODE = 'a'.repeat(26);
const LINK = `${ORIGIN}/link#${CODE}`;
// Each case spawns shells, fake package managers and an archive; well past vitest's 5 s default on a busy machine.
const SHELL_TIMEOUT = { timeout: 60_000 };

afterEach(() => {
    for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

function temporary() {
    const path = mkdtempSync(join(tmpdir(), 'ptbk-install-command-'));
    directories.push(path);
    return path;
}

function commands() {
    const option = installationOptions(TEST_ENGINE_INSTALLATION, LINK).find((option) => option.kind === 'command');
    if (option?.kind !== 'command') throw new Error('missing commands');
    return option.commands;
}

/** The script the Worker would serve, as a file the fake `curl` prints. */
function served(script: InstallScript, release: EngineInstallRelease = TEST_ENGINE_INSTALLATION) {
    const path = join(temporary(), script);
    writeFileSync(path, renderInstallScript(script, release, ORIGIN));
    return path;
}

function executable(dir: string, name: string, body: string) {
    writeFileSync(join(dir, name), '#!/bin/sh\n' + body + '\n', { mode: 0o755 });
}

/** Records every call's arguments, then answers the known URLs; `$out` is the `-o` target. */
function fakeCurl(dir: string, downloads: Readonly<Record<string, string>>) {
    const cases = Object.entries(downloads)
        .map(([url, action]) => `    '${url}') ${action} ;;`)
        .join('\n');
    executable(
        dir,
        'curl',
        `printf '%s\\n' "$@" >> "$DOWNLOADS"
out=; url=
while [ $# -gt 0 ]; do
    case "$1" in -o) out=$2; shift 2 ;; -*|[0-9]*) shift ;; *) url=$1; shift ;; esac
done
case "$url" in
${cases}
    *) exit 81 ;;
esac`,
    );
}

const fakeCli = `if [ "$1" = --version ]; then echo "$REPORTED_VERSION"; exit "$VERSION_STATUS"; fi
[ -z "\${PTBK_LINK+set}" ] || exit 90
printf '%s\\n' "$@" > "$RECORD"
if [ "$3" = --link-stdin ]; then cat >> "$RECORD"; fi
exit "$PAIR_STATUS"`;

/** Inert download, OS package manager and npm. The copied command runs the script the Worker serves. */
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
    executable(bin, 'sudo', 'echo "$*" >> "$HOME/sudo-calls"; exec "$@"');
    executable(bin, 'id', 'if [ "$1" = -un ]; then echo ana; else echo "$USER_ID"; fi');
    // logind's answer for this user; empty stands for a host without systemd, where loginctl fails.
    executable(
        bin,
        'loginctl',
        `case "$1" in
    show-user) [ -n "$LINGER" ] || exit 1; echo "$LINGER" ;;
    enable-linger) echo "$*" >> "$HOME/linger" ;;
    *) exit 82 ;;
esac`,
    );
    executable(bin, 'apt-get', '[ "$1" = update ] || { [ "$*" = "install -y git" ] && touch "$HOME/git-ready"; }');
    executable(bin, 'brew', '[ "$*" = "install git" ] && touch "$HOME/git-ready"');
    for (const tool of ['node', 'npm', 'ptbk']) executable(bin, tool, 'exit 127');
    executable(bin, 'fixture-cli', fakeCli);
    fakeCurl(bin, {
        [`${ORIGIN}/install.sh`]: '[ "$DOWNLOAD_STATUS" = 0 ] || exit "$DOWNLOAD_STATUS"; cat "$TEST_SCRIPT"',
        'https://nodejs.org/dist/latest-v24.x/SHASUMS256.txt': `echo "$DIGEST  node-v24.1.0-${stem}.tar.gz" > "$out"`,
        [`https://nodejs.org/dist/v24.1.0/node-v24.1.0-${stem}.tar.gz`]: 'cp "$ARCHIVE" "$out"',
    });
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
        USER_ID: '1000',
        LINGER: '',
        RECORD: record,
        DOWNLOADS: downloads,
        DIGEST: digest,
        ARCHIVE: archive,
        TEST_SCRIPT: served('desktop'),
        TEST_CLI: join(bin, 'fixture-cli'),
    };
    return { env, record, downloads, home, bin };
}

// util-linux script(1) gives the command a real terminal; BSD script needs one already, so macOS skips these.
const terminalAvailable = process.platform === 'linux' && spawnSync('script', ['--version']).status === 0;

function inTerminal(command: string, env: NodeJS.ProcessEnv, input: string) {
    return spawnSync('script', ['-qec', command, '/dev/null'], {
        cwd: temporary(),
        env,
        encoding: 'utf8',
        input,
        timeout: 20_000,
    });
}

describe('the copied Bash/zsh installation on a computer without usable Git, Node.js or npm', SHELL_TIMEOUT, () => {
    it('is one short line that keeps the code out of argv', () => {
        expect(commands().posix).toBe(`curl -fsSL ${ORIGIN}/install.sh | PTBK_LINK=${CODE} bash`);
    });

    for (const [shell, platform] of [
        ['bash', 'Linux'],
        ['zsh', 'Darwin'],
    ] as const) {
        const available = spawnSync(shell, ['--version']).status === 0;
        it.skipIf(!available)(`installs and reuses the exact CLI on ${platform} through ${shell}`, () => {
            const { env, record, downloads, home } = localFixture(platform);
            // Unattended runs never install system packages; that approval has its own tests below.
            if (platform === 'Linux') writeFileSync(join(home, 'git-ready'), '');
            const cwd = temporary();
            for (let run = 0; run < 2; run++) {
                const result = spawnSync(shell, ['-c', commands().posix], { cwd, env, encoding: 'utf8' });
                expect(result.status, result.stderr).toBe(0);
                expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual([
                    'init',
                    '--prepare-only',
                    '--link-stdin',
                    LINK,
                ]);
                expect(readdirSync(cwd)).toEqual([]);
            }
            const requests = readFileSync(downloads, 'utf8');
            expect(requests).not.toContain(CODE);
            expect(requests.match(/https:\/\/nodejs\.org\/dist\/latest-v24\.x\/SHASUMS256/g)).toHaveLength(1);
            expect(readdirSync(join(home, '.local/share/promptbook'))).toEqual(['bin', 'cli']);
        });
    }

    it.skipIf(!terminalAvailable)(
        'preserves the native first-access flow and asks before installing Git when pasted into a terminal',
        () => {
            const { env, record, home } = localFixture();
            const result = inTerminal(commands().posix, env, 'y\n');
            expect(result.status, result.stdout + result.stderr).toBe(0);
            expect(result.stdout).toContain('Install it now? [y/N]');
            expect(readFileSync(join(home, 'sudo-calls'), 'utf8')).toBe('apt-get update\napt-get install -y git\n');
            expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual(['init', '--prepare-only', '--link', LINK]);
        },
    );

    it.skipIf(!terminalAvailable)('asks to keep the project running across reboots when pasted into a terminal', () => {
        const { env, record, home } = localFixture();
        writeFileSync(join(home, 'git-ready'), '');
        const result = inTerminal(commands().posix, { ...env, LINGER: 'no' }, 'y\n');
        expect(result.status, result.stdout + result.stderr).toBe(0);
        expect(result.stdout).toContain('starts again after a reboot');
        expect(readFileSync(join(home, 'sudo-calls'), 'utf8')).toBe('loginctl enable-linger ana\n');
        expect(readFileSync(join(home, 'linger'), 'utf8')).toBe('enable-linger ana\n');
        expect(existsSync(record)).toBe(true);
    });

    it.each([
        { LINGER: 'no', USER_ID: '1000', asked: true },
        { LINGER: 'yes', USER_ID: '1000', asked: false },
        { LINGER: '', USER_ID: '1000', asked: false },
        { LINGER: 'no', USER_ID: '0', asked: false },
    ])('never enables linger unattended and still pairs: %o', ({ asked, ...overrides }) => {
        const { env, record, home } = localFixture();
        writeFileSync(join(home, 'git-ready'), '');
        const result = spawnSync('bash', ['-c', commands().posix], {
            cwd: temporary(),
            env: { ...env, ...overrides },
            encoding: 'utf8',
        });
        expect(result.status, result.stderr).toBe(0);
        expect(result.stderr.includes('Linger not enabled')).toBe(asked);
        expect(existsSync(join(home, 'sudo-calls'))).toBe(false);
        expect(existsSync(join(home, 'linger'))).toBe(false);
        expect(existsSync(record)).toBe(true);
    });

    it('never reuses a ptbk on PATH outside its own prefix, even with the right version', () => {
        const { env, record, home, bin } = localFixture();
        writeFileSync(join(home, 'git-ready'), '');
        executable(bin, 'ptbk', `if [ "$1" = --version ]; then echo ${VERSION}; else touch "$HOME/foreign"; fi`);
        const result = spawnSync('bash', ['-c', commands().posix], { cwd: temporary(), env, encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        expect(existsSync(join(home, 'foreign'))).toBe(false);
        expect(existsSync(join(home, `.local/share/promptbook/cli/${VERSION}/bin/ptbk`))).toBe(true);
        expect(readFileSync(record, 'utf8').trim().split('\n')).toEqual([
            'init',
            '--prepare-only',
            '--link-stdin',
            LINK,
        ]);
    });

    it('stops before sudo when nobody at a terminal approves the system package', () => {
        const { env, record, home } = localFixture();
        const result = spawnSync('bash', ['-c', commands().posix], { cwd: temporary(), env, encoding: 'utf8' });
        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('Install Git yourself');
        expect(existsSync(join(home, 'sudo-calls'))).toBe(false);
        expect(existsSync(record)).toBe(false);
    });

    it.each(['', 'not-a-code', LINK, `${CODE}'$(touch injected)`])(
        'refuses PTBK_LINK=%j before touching the computer',
        (value) => {
            const { env, record, home, downloads } = localFixture();
            const cwd = temporary();
            const result = spawnSync('bash', ['-c', `curl -fsSL ${ORIGIN}/install.sh | bash`], {
                cwd,
                env: { ...env, PTBK_LINK: value },
                encoding: 'utf8',
            });
            expect(result.status).not.toBe(0);
            expect(result.stderr).toContain('Set PTBK_LINK to the pairing code');
            expect(readFileSync(downloads, 'utf8').trim().split('\n')).toEqual(['-fsSL', `${ORIGIN}/install.sh`]);
            expect(readdirSync(home)).toEqual([]);
            expect(readdirSync(cwd)).toEqual([]);
            expect(existsSync(record)).toBe(false);
        },
    );

    it('runs nothing from a download cut short', () => {
        const { env, record, home, downloads } = localFixture();
        writeFileSync(join(home, 'git-ready'), '');
        const script = readFileSync(env.TEST_SCRIPT, 'utf8');
        const truncated = join(temporary(), 'truncated');
        // Every cut before the final call leaves at most function definitions behind.
        for (let end = 0; end < script.lastIndexOf('\nmain'); end += 97) {
            writeFileSync(truncated, script.slice(0, end));
            spawnSync('bash', ['-c', commands().posix], { cwd: temporary(), env: { ...env, TEST_SCRIPT: truncated } });
            expect(readFileSync(downloads, 'utf8').trim().split('\n').at(-1), String(end)).toBe(`${ORIGIN}/install.sh`);
        }
        expect(readdirSync(home)).toEqual(['git-ready']);
        expect(existsSync(record)).toBe(false);
    });

    it.each([
        { DOWNLOAD_STATUS: '22' },
        { DIGEST: '0'.repeat(64) },
        { INSTALL_STATUS: '1' },
        { REPORTED_VERSION: '0.114.0-42' },
        { VERSION_STATUS: '1' },
    ])('stops before pairing when installation or verification fails: %o', (overrides) => {
        const { env, record, home } = localFixture();
        writeFileSync(join(home, 'git-ready'), '');
        const result = spawnSync('bash', ['-c', `set -o pipefail; ${commands().posix}`], {
            cwd: temporary(),
            env: { ...env, ...overrides },
        });
        expect(result.status).not.toBe(0);
        expect(existsSync(record)).toBe(false);
    });
});

describe('the copied Ubuntu bootstrap, with an inert downloaded script', SHELL_TIMEOUT, () => {
    it.each([
        { valid: true, uid: 0 },
        { valid: false, uid: 0 },
        { valid: true, uid: 1000 },
        { valid: false, uid: 1000 },
    ])('checks downloaded bytes before sudo and passes the link on stdin (case: %o)', ({ valid, uid }) => {
        const cwd = temporary();
        const bin = temporary();
        const bootstrap = join(cwd, 'bootstrap');
        const args = join(cwd, 'arguments');
        const downloads = join(cwd, 'requests');
        const sudoCalls = join(cwd, 'sudo');
        const body =
            '#!/usr/bin/env bash\n[ -z "${PTBK_LINK+set}" ] || exit 90\nIFS= read -r link\nprintf "%s\\n" "$link" "$@" > "$PTBK_TEST_ARGS"\n';
        writeFileSync(bootstrap, body);
        const checksum = createHash('sha256').update(body).digest('hex');
        const release = { ...TEST_ENGINE_INSTALLATION, bootstrapSha256: valid ? checksum : '0'.repeat(64) };
        fakeCurl(bin, {
            [`${ORIGIN}/install-server.sh`]: 'cat "$PTBK_TEST_SCRIPT"',
            [`https://raw.githubusercontent.com/webgptorg/promptbook/${release.bootstrapRevision}/deploy/ubuntu/install.sh`]:
                'cp "$PTBK_TEST_BOOTSTRAP" "$out"',
        });
        executable(bin, 'id', `echo ${String(uid)}`);
        executable(
            bin,
            'sudo',
            uid === 0 ? 'exit 97' : 'echo "$*" >> "$PTBK_TEST_SUDO"; [ "$1" = -v ] && exit 0; exec "$@"',
        );
        const result = spawnSync('bash', ['-c', `set -o pipefail; ${commands().ubuntu}`], {
            cwd,
            env: {
                ...process.env,
                PATH: `${bin}:${process.env['PATH'] ?? ''}`,
                DOWNLOADS: downloads,
                PTBK_TEST_SCRIPT: served('server', release),
                PTBK_TEST_BOOTSTRAP: bootstrap,
                PTBK_TEST_ARGS: args,
                PTBK_TEST_SUDO: sudoCalls,
                TMPDIR: cwd,
            },
            encoding: 'utf8',
        });
        expect(result.status === 0, result.stderr).toBe(valid);
        expect(existsSync(args)).toBe(valid);
        expect(existsSync(sudoCalls)).toBe(valid && uid !== 0);
        if (!valid) expect(result.stderr).toContain('checksum mismatch');
        if (valid)
            expect(readFileSync(args, 'utf8').split('\n')).toEqual([
                LINK,
                '--version',
                VERSION,
                '--prepare-only',
                '--link-stdin',
                '',
            ]);
        expect(readFileSync(downloads, 'utf8')).not.toContain(CODE);
        expect(readdirSync(cwd).filter((file) => file.startsWith('tmp.'))).toEqual([]);
    });
});
