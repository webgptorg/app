import { EngineId, Hostname, RelayId, deriveEngineFingerprint } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import type { RelayLink, RelayLinkState } from '../domain/tunnel/relay-link';
import type { EngineStatusInput } from './engine-status';
import { engineStatus, relayStateOf } from './engine-status';

const ENGINE_ID = EngineId.parse('k5dq4tabcdefghijklmnopqrst');
const HOSTNAME = Hostname.parse(`${ENGINE_ID}.engines.ptbk.test`);

function link(relay: string, kind: RelayLinkState['kind']): RelayLink {
    const relayId = RelayId.parse(relay);
    return {
        relay: { relayId, url: `wss://${relay}/v1/tunnel`, port: 443 },
        state: () => ({ kind }) as RelayLinkState,
        start: () => undefined,
        stop: () => Promise.resolve(),
    };
}

const BASE: EngineStatusInput = {
    engineId: ENGINE_ID,
    hostname: HOSTNAME,
    version: '0.1.0',
    registration: null,
    withDashboard: true,
    links: [],
    certificateNotAfter: null,
    uiVersion: null,
    updatePolicy: { kind: 'auto' },
    ownerSetUp: false,
    heartbeat: null,
    addressGaps: ['relay', 'certificate'],
};

describe('engineStatus', () => {
    it('reports an engine waiting for connect as local', () => {
        expect(engineStatus(BASE)).toEqual({
            engineId: ENGINE_ID,
            hostname: HOSTNAME,
            fingerprint: deriveEngineFingerprint(ENGINE_ID).formatted,
            version: '0.1.0',
            mode: 'local',
            dashboardUrl: null,
            relays: [],
            certificate: null,
            ui: null,
            updatePolicy: 'auto',
            ownerSetUp: false,
            heartbeat: null,
            addressGaps: ['relay', 'certificate'],
        });
        expect(engineStatus({ ...BASE, withDashboard: false }).mode).toBe('tunnel');
    });

    it('reports a linked engine with its relays, certificate, bundle and last beat, and never the beat body', () => {
        const status = engineStatus({
            ...BASE,
            registration: {
                dashboardUrl: 'https://app.ptbk.test',
                engineId: ENGINE_ID,
                hostname: HOSTNAME,
                relays: [Hostname.parse('relay-a.ptbk.test')],
                memberKey: null,
            },
            links: [link('relay-a.ptbk.test', 'ready'), link('relay-b.ptbk.test', 'backoff')],
            certificateNotAfter: '2026-11-02T10:00:00Z',
            uiVersion: '1.9.0',
            updatePolicy: { kind: 'manual' },
            ownerSetUp: true,
            heartbeat: {
                lastHeartbeat: {
                    sentAt: '2026-10-26T10:00:00Z' as never,
                    body: '{"secretish":1}',
                    signature: 'ed25519=x',
                },
                clockSkew: { seconds: 4, measuredAt: '2026-10-26T10:00:00Z' as never },
                lastAnswer: { kind: 'accepted', status: 204 },
            },
            addressGaps: [],
        });
        expect(status).toMatchObject({
            mode: 'tunnel',
            dashboardUrl: 'https://app.ptbk.test',
            relays: [
                { relay: 'relay-a.ptbk.test', state: 'connected' },
                { relay: 'relay-b.ptbk.test', state: 'disconnected' },
            ],
            certificate: { notAfter: '2026-11-02T10:00:00Z' },
            ui: { version: '1.9.0' },
            updatePolicy: 'manual',
            heartbeat: { sentAt: '2026-10-26T10:00:00Z', answer: 'accepted', status: 204, clockSkewS: 4 },
        });
        expect(JSON.stringify(status)).not.toContain('secretish');
        expect(JSON.stringify(status)).not.toContain('ed25519=');
    });

    it('shows a beat sent but not answered yet', () => {
        const status = engineStatus({
            ...BASE,
            heartbeat: {
                lastHeartbeat: { sentAt: '2026-10-26T10:00:00Z' as never, body: '{}', signature: 'ed25519=x' },
                clockSkew: null,
                lastAnswer: null,
            },
        });
        expect(status.heartbeat).toEqual({
            sentAt: '2026-10-26T10:00:00Z',
            answer: null,
            status: null,
            clockSkewS: null,
        });
    });

    it('maps every link state', () => {
        const kinds: RelayLinkState['kind'][] = ['idle', 'connecting', 'handshaking', 'ready', 'backoff', 'stopped'];
        expect(kinds.map((kind) => relayStateOf({ kind } as RelayLinkState))).toEqual([
            'disconnected',
            'connecting',
            'connecting',
            'connected',
            'disconnected',
            'disconnected',
        ]);
    });
});
