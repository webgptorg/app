import { describe, expect, it } from 'vitest';

import type { OperatorStatus, ResetAnswer, SetupLinkAnswer } from '../domain/onboarding/operator-api';
import { EXIT_CODE } from './exit-codes';
import type { SetupLinkDeps } from './setup-link-command';
import {
    OWNER_USAGE,
    SETUP_LINK_USAGE,
    SETUP_LINK_WAIT_MS,
    SetupLinkUsageError,
    localClockTime,
    parseOwnerCommand,
    parseSetupLinkCommand,
    runOwnerResetCommand,
    runSetupLinkCommand,
} from './setup-link-command';

const SECRET = 'Zm9vYmFyYmF6cXV4cXV1eA';
const URL_WITH_SECRET = `https://k5dq4tabcdefghijklmnopqrst.engines.ptbk.test/setup#${SECRET}`;
const CREATED: SetupLinkAnswer = { outcome: 'created', url: URL_WITH_SECRET, expiresAt: '2026-10-26T10:30:00Z' };
const STATUS = { engineId: 'k5dq4tabcdefghijklmnopqrst', hostname: 'k5dq4tabcdefghijklmnopqrst.engines.ptbk.test' };

interface World {
    readonly deps: SetupLinkDeps;
    readonly out: string[];
    readonly err: string[];
    readonly resets: () => number;
    readonly asked: string[];
}

function world(
    options: {
        readonly answers?: (SetupLinkAnswer | null)[];
        readonly terminal?: boolean;
        readonly typed?: string | null;
        readonly running?: boolean;
    } = {},
): World {
    const out: string[] = [];
    const err: string[] = [];
    const asked: string[] = [];
    const answers = [...(options.answers ?? [CREATED])];
    let nowMs = 0;
    let resets = 0;
    const running = options.running ?? true;
    const deps: SetupLinkDeps = {
        client: {
            status: () => Promise.resolve(running ? (STATUS as OperatorStatus) : null),
            setupLink: () => Promise.resolve(answers.length > 1 ? (answers.shift() ?? null) : (answers[0] ?? null)),
            resetOwner: () => {
                resets++;
                return Promise.resolve<ResetAnswer | null>(running ? { passkeys: 2, sessions: 3 } : null);
            },
        },
        out: (line) => out.push(line),
        err: (line) => err.push(line),
        terminal: options.terminal ?? true,
        sleep: (ms) => {
            nowMs += ms;
            return Promise.resolve();
        },
        nowMs: () => nowMs,
        clockTime: () => '10:30',
        ask: (prompt) => {
            asked.push(prompt);
            return Promise.resolve(options.typed === undefined ? 'k5dq4tab' : options.typed);
        },
    };
    return { deps, out, err, asked, resets: () => resets };
}

describe('parsing', () => {
    it('takes the documented flags once each', () => {
        expect(parseSetupLinkCommand([])).toEqual({ wait: true, json: false });
        expect(parseSetupLinkCommand(['--json', '--no-wait'])).toEqual({ wait: false, json: true });
        expect(() => parseSetupLinkCommand(['--json', '--json'])).toThrow(new SetupLinkUsageError(SETUP_LINK_USAGE));
        expect(() => parseSetupLinkCommand(['--print'])).toThrow(SetupLinkUsageError);
        expect(parseOwnerCommand(['--reset'])).toEqual({ yes: false, wait: true, json: false });
        expect(parseOwnerCommand(['--reset', '--yes', '--json'])).toEqual({ yes: true, wait: true, json: true });
        for (const args of [[], ['--yes'], ['--reset', '--force']]) {
            expect(() => parseOwnerCommand(args)).toThrow(new SetupLinkUsageError(OWNER_USAGE));
        }
    });
});

describe('setup-link', () => {
    it('prints the link, its expiry and the warning on stdout, and nothing secret on stderr', async () => {
        const { deps, out, err } = world();
        expect(await runSetupLinkCommand({ wait: true, json: false }, deps)).toBe(EXIT_CODE.ok);
        expect(out).toEqual([
            'Make yourself the owner of this engine in your browser:',
            '',
            `  ${URL_WITH_SECRET}`,
            '',
            'This link makes whoever opens it the owner. It works once, until 10:30 (30 minutes).',
            'Do not paste it into chats or tickets. A new link: mock-engine setup-link',
        ]);
        expect(err.join('\n')).not.toContain(SECRET);
    });

    it('refuses to print to something that is not a terminal unless asked with --json', async () => {
        const piped = world({ terminal: false });
        expect(await runSetupLinkCommand({ wait: true, json: false }, piped.deps)).toBe(EXIT_CODE.usage);
        expect(piped.out).toEqual([]);
        expect(piped.err.join('\n')).toContain('printed only to an interactive terminal');
        const json = world({ terminal: false });
        expect(await runSetupLinkCommand({ wait: true, json: true }, json.deps)).toBe(EXIT_CODE.ok);
        expect(json.out.map((line) => JSON.parse(line) as unknown)).toEqual([CREATED]);
    });

    it('waits for the address, saying what is missing once per change', async () => {
        const missing = (gaps: ('relay' | 'certificate' | 'setup-page')[]): SetupLinkAnswer => ({
            outcome: 'not-ready',
            missing: gaps,
        });
        const { deps, out, err } = world({
            answers: [
                missing(['relay', 'certificate']),
                missing(['relay', 'certificate']),
                missing(['certificate']),
                CREATED,
            ],
        });
        expect(await runSetupLinkCommand({ wait: true, json: false }, deps)).toBe(EXIT_CODE.ok);
        expect(err).toEqual([
            '… Waiting for a relay connection and a certificate before printing the setup link',
            '… Waiting for a certificate before printing the setup link',
        ]);
        expect(out[2]).toBe(`  ${URL_WITH_SECRET}`);
    });

    it('says what is missing with --no-wait, or once the wait runs out, and exits 9', async () => {
        const notReady: SetupLinkAnswer = { outcome: 'not-ready', missing: ['setup-page'] };
        const once = world({ answers: [notReady] });
        expect(await runSetupLinkCommand({ wait: false, json: false }, once.deps)).toBe(EXIT_CODE.notReady);
        expect(once.err).toEqual([
            '✗ Not ready for the setup link yet: waiting for the setup page. `mock-engine status` shows each part.',
        ]);
        const patient = world({ answers: [notReady] });
        expect(await runSetupLinkCommand({ wait: true, json: true }, patient.deps)).toBe(EXIT_CODE.notReady);
        expect(patient.deps.nowMs()).toBeGreaterThanOrEqual(SETUP_LINK_WAIT_MS);
        expect(patient.out.map((line) => JSON.parse(line) as unknown)).toEqual([notReady]);
    });

    it('exits 8 when the engine already has an owner, and 1 when no engine answers', async () => {
        const owned = world({ answers: [{ outcome: 'owner-exists' }] });
        expect(await runSetupLinkCommand({ wait: true, json: false }, owned.deps)).toBe(EXIT_CODE.ownerExists);
        expect(owned.err[0]).toContain('`mock-engine owner --reset`');
        const stopped = world({ answers: [null] });
        expect(await runSetupLinkCommand({ wait: true, json: false }, stopped.deps)).toBe(EXIT_CODE.failed);
        expect(stopped.err[0]).toContain('The engine is not running');
    });
});

describe('owner --reset', () => {
    it('asks for the first 8 characters of the engine ID, resets, then prints a fresh link', async () => {
        const { deps, out, err, asked, resets } = world();
        expect(await runOwnerResetCommand({ yes: false, wait: true, json: false }, deps)).toBe(EXIT_CODE.ok);
        expect(asked).toEqual([
            'This removes every passkey and signs out every session. Agents and data stay. Type the first 8 characters of the engine ID to continue: ',
        ]);
        expect(resets()).toBe(1);
        expect(err).toContain('✓ Removed 2 passkeys and ended 3 sessions. Agents and data stay.');
        expect(out).toContain(`  ${URL_WITH_SECRET}`);
    });

    it('changes nothing on a wrong answer, and needs --yes without a terminal to type on', async () => {
        const wrong = world({ typed: 'k5dq4ta' });
        expect(await runOwnerResetCommand({ yes: false, wait: true, json: false }, wrong.deps)).toBe(EXIT_CODE.failed);
        expect(wrong.resets()).toBe(0);
        expect(wrong.err.at(-1)).toBe('✗ Not confirmed; nothing changed.');
        const noTty = world({ typed: null });
        expect(await runOwnerResetCommand({ yes: false, wait: true, json: true }, noTty.deps)).toBe(EXIT_CODE.usage);
        expect(noTty.resets()).toBe(0);
        const scripted = world({ terminal: false });
        expect(await runOwnerResetCommand({ yes: true, wait: true, json: true }, scripted.deps)).toBe(EXIT_CODE.ok);
        expect(scripted.asked).toEqual([]);
        expect(scripted.resets()).toBe(1);
        expect(JSON.parse(scripted.out[0] ?? '')).toEqual(CREATED);
    });

    it('refuses before resetting when the link could not be printed, or no engine answers', async () => {
        const piped = world({ terminal: false });
        expect(await runOwnerResetCommand({ yes: true, wait: true, json: false }, piped.deps)).toBe(EXIT_CODE.usage);
        expect(piped.resets()).toBe(0);
        const stopped = world({ running: false });
        expect(await runOwnerResetCommand({ yes: true, wait: true, json: false }, stopped.deps)).toBe(EXIT_CODE.failed);
        expect(stopped.resets()).toBe(0);
    });
});

describe('localClockTime', () => {
    it('reads the host clock as hours and minutes', () => {
        expect(localClockTime('2026-10-26T10:30:00Z')).toMatch(/^\d{2}:\d{2}$/);
    });
});
