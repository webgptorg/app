import { describe, expect, it } from 'vitest';

import type { OperatorStatus } from '../domain/onboarding/operator-api';
import { EXIT_CODE } from './exit-codes';
import { STATUS_USAGE, StatusUsageError, parseStatusCommand, runStatusCommand, statusLines } from './status-command';

const STATUS: OperatorStatus = {
    engineId: 'k5dq4tabcdefghijklmnopqrst',
    hostname: 'k5dq4tabcdefghijklmnopqrst.engines.ptbk.test',
    fingerprint: '7KQ2-M9XD-4TRA-0VHE-PZ3N',
    version: '0.1.0',
    mode: 'tunnel',
    dashboardUrl: 'https://app.ptbk.test',
    relays: [
        { relay: 'relay-a.ptbk.test', state: 'connected' },
        { relay: 'relay-b.ptbk.test', state: 'connecting' },
    ],
    certificate: { notAfter: '2026-11-02T10:00:00Z' },
    ui: { version: '1.9.0' },
    updatePolicy: 'auto',
    ownerSetUp: false,
    heartbeat: { sentAt: '2026-10-26T10:31:02Z', answer: 'refused', status: 401, clockSkewS: -600 },
    addressGaps: [],
};

function run(status: OperatorStatus | null, json: boolean) {
    const out: string[] = [];
    const err: string[] = [];
    const exit = runStatusCommand(
        { json },
        { status: () => Promise.resolve(status), out: (line) => out.push(line), err: (line) => err.push(line) },
    );
    return { exit, out, err };
}

describe('parseStatusCommand', () => {
    it('takes nothing or --json', () => {
        expect(parseStatusCommand([])).toEqual({ json: false });
        expect(parseStatusCommand(['--json'])).toEqual({ json: true });
        for (const args of [['--yes'], ['--json', '--json']]) {
            expect(() => parseStatusCommand(args)).toThrow(new StatusUsageError());
        }
        expect(new StatusUsageError().message).toBe(STATUS_USAGE);
    });
});

describe('statusLines', () => {
    it('shows one screen with every part the operator checks', () => {
        expect(statusLines(STATUS)).toEqual([
            'Engine        k5dq4tabcdefghijklmnopqrst',
            'Address       https://k5dq4tabcdefghijklmnopqrst.engines.ptbk.test',
            'Fingerprint   7KQ2-M9XD-4TRA-0VHE-PZ3N',
            'Version       0.1.0',
            'Link          linked to https://app.ptbk.test',
            'Relays        1 of 2 connected',
            '                relay-a.ptbk.test   connected',
            '                relay-b.ptbk.test   connecting',
            'Certificate   valid until 2026-11-02 10:00 UTC',
            'UI bundle     1.9.0',
            'Updates       auto',
            'Owner         not yet: run `mock-engine setup-link`',
            "Heartbeat     last sent 2026-10-26 10:31 UTC, refused (401); clock -600 s off the platform's",
        ]);
    });

    it('says what is missing on a fresh engine', () => {
        const lines = statusLines({
            ...STATUS,
            mode: 'local',
            dashboardUrl: null,
            relays: [],
            certificate: null,
            ui: null,
            ownerSetUp: true,
            heartbeat: null,
            addressGaps: ['relay', 'certificate'],
        });
        expect(lines).toContain('Link          not linked: run `mock-engine connect --link <code>`');
        expect(lines).toContain('Certificate   none yet');
        expect(lines).toContain('UI bundle     none yet');
        expect(lines).toContain('Owner         set up');
        expect(lines).toContain('Heartbeat     none sent yet');
        expect(lines.at(-1)).toBe('Address       waiting for a relay connection and a certificate');
    });

    it('describes every heartbeat answer', () => {
        const heartbeat = (beat: NonNullable<OperatorStatus['heartbeat']>) =>
            statusLines({ ...STATUS, heartbeat: beat }).find((line) => line.startsWith('Heartbeat'));
        const sentAt = '2026-10-26T10:31:02Z';
        expect(heartbeat({ sentAt, answer: null, status: null, clockSkewS: null })).toBe(
            'Heartbeat     last sent 2026-10-26 10:31 UTC, no answer yet',
        );
        expect(heartbeat({ sentAt, answer: 'accepted', status: 204, clockSkewS: null })).toBe(
            'Heartbeat     last sent 2026-10-26 10:31 UTC, accepted',
        );
        expect(heartbeat({ sentAt, answer: 'unavailable', status: null, clockSkewS: null })).toBe(
            'Heartbeat     last sent 2026-10-26 10:31 UTC, the platform did not answer',
        );
        expect(statusLines({ ...STATUS, dashboardUrl: null }).find((line) => line.startsWith('Link'))).toBe(
            'Link          no dashboard (development)',
        );
    });
});

describe('runStatusCommand', () => {
    it('prints the lines, or one JSON object with --json', async () => {
        const human = run(STATUS, false);
        expect(await human.exit).toBe(EXIT_CODE.ok);
        expect(human.out).toEqual(statusLines(STATUS));
        const json = run(STATUS, true);
        expect(await json.exit).toBe(EXIT_CODE.ok);
        expect(json.out.map((line) => JSON.parse(line) as unknown)).toEqual([{ running: true, ...STATUS }]);
    });

    it('exits 1 with what to do when no engine answers', async () => {
        const stopped = run(null, true);
        expect(await stopped.exit).toBe(EXIT_CODE.failed);
        expect(stopped.out).toEqual(['{"running":false}']);
        expect(stopped.err).toEqual([
            'The engine is not running from this PTBK_DATA_DIR. Start it, then run status again.',
        ]);
    });
});
