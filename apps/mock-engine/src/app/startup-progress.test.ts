import { EngineId, Hostname, deriveEngineFingerprint } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { createMemoryLogger } from '../testing/memory-logger';
import { createStartupProgress } from './startup-progress';

const ENGINE_ID = EngineId.parse('k5dq4tabcdefghijklmnopqrst');
const HOSTNAME = Hostname.parse(`${ENGINE_ID}.engines.ptbk.test`);

function setup(terminal = true) {
    const logger = createMemoryLogger();
    const lines: string[] = [];
    const progress = createStartupProgress({
        logger,
        say: terminal ? (line) => lines.push(line) : null,
        engineId: ENGINE_ID,
        hostname: HOSTNAME,
    });
    return { logger, lines, progress };
}

describe('createStartupProgress', () => {
    it('narrates identity, link, relays, certificate, UI, owner and ready in the contract order', () => {
        const { logger, lines, progress } = setup();
        progress.identity();
        progress.linked(false);
        progress.relays(0, 2);
        progress.relays(1, 2);
        progress.relays(1, 2);
        progress.onboarding({ addressGaps: ['certificate'], ownerSetUp: false });
        progress.certificate('2026-11-02T10:00:00Z');
        progress.ui('1.9.0');
        progress.onboarding({ addressGaps: [], ownerSetUp: false });
        progress.onboarding({ addressGaps: [], ownerSetUp: false });
        expect(lines).toEqual([
            '✓ Engine key ready',
            `        Engine ID     ${ENGINE_ID}`,
            `        Address       https://${HOSTNAME}`,
            `        Fingerprint   ${deriveEngineFingerprint(ENGINE_ID).formatted}   (the dashboard shows the same)`,
            '✓ Linked to your Promptbook account',
            '… Connected to 0 of 2 relays',
            '✓ Connected to 1 of 2 relays',
            `✓ Certificate for ${HOSTNAME}, valid until 2026-11-02 10:00 UTC`,
            '✓ Engine UI 1.9.0 verified',
            'No owner yet. Run `mock-engine setup-link` on this host to get the setup link.',
            `Ready: https://${HOSTNAME}/`,
        ]);
        expect(logger.entries.map(({ event, fields }) => [event, fields])).toEqual([
            [
                'engine.identity',
                { engineId: ENGINE_ID, hostname: HOSTNAME, fingerprint: deriveEngineFingerprint(ENGINE_ID).formatted },
            ],
            ['relays.connected', { connected: 0, total: 2 }],
            ['relays.connected', { connected: 1, total: 2 }],
            ['owner.none', { command: 'mock-engine setup-link' }],
            ['engine.ready', { url: `https://${HOSTNAME}/` }],
        ]);
    });

    it('reports the owner again whenever it changes after ready', () => {
        const { logger, lines, progress } = setup();
        progress.onboarding({ addressGaps: [], ownerSetUp: true });
        progress.onboarding({ addressGaps: ['relay'], ownerSetUp: false });
        progress.onboarding({ addressGaps: [], ownerSetUp: true });
        expect(lines).toEqual([
            '✓ Owner set up',
            `Ready: https://${HOSTNAME}/`,
            'No owner yet. Run `mock-engine setup-link` on this host to get the setup link.',
            '✓ Owner set up',
        ]);
        expect(logger.entries.map(({ event }) => event)).toEqual([
            'owner.set-up',
            'engine.ready',
            'owner.none',
            'owner.set-up',
        ]);
    });

    it('says how to link an engine started without a link code', () => {
        const { logger, lines, progress } = setup();
        progress.notLinked();
        expect(lines).toEqual([
            '… Not linked. To reach this engine from anywhere, create an account at app.ptbk.io and run `mock-engine connect --link <code>`.',
        ]);
        expect(logger.entries).toEqual([
            { level: 'warn', event: 'engine.not-linked', fields: { command: 'mock-engine connect --link <code>' } },
        ]);
    });

    it('writes only the log stream when the engine runs as a service', () => {
        const { logger, lines, progress } = setup(false);
        progress.identity();
        progress.linked(true);
        progress.onboarding({ addressGaps: [], ownerSetUp: false });
        expect(lines).toEqual([]);
        expect(logger.entries.map(({ event }) => event)).toEqual(['engine.identity', 'owner.none', 'engine.ready']);
    });
});
