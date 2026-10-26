import type { EngineId, Hostname } from '@ptbk/protocol';
import { deriveEngineFingerprint } from '@ptbk/protocol';

import type { HeartbeatStatus } from '../domain/heartbeat/heartbeat-loop';
import type { AddressGap } from '../domain/onboarding/address';
import type { OperatorStatus } from '../domain/onboarding/operator-api';
import type { Registration } from '../domain/registration/registration';
import type { RelayLink, RelayLinkState } from '../domain/tunnel/relay-link';
import type { UpdatePolicy } from '../domain/ui/update-policy';

const RELAY_STATE: Readonly<Record<RelayLinkState['kind'], OperatorStatus['relays'][number]['state']>> = {
    ready: 'connected',
    connecting: 'connecting',
    handshaking: 'connecting',
    idle: 'disconnected',
    backoff: 'disconnected',
    stopped: 'disconnected',
};

export function relayStateOf(state: RelayLinkState): OperatorStatus['relays'][number]['state'] {
    return RELAY_STATE[state.kind];
}

export interface EngineStatusInput {
    readonly engineId: EngineId;
    readonly hostname: Hostname;
    readonly version: string;
    readonly registration: Registration | null;
    /** Whether the engine runs with a dashboard at all; without one (the M1 dev mode) it dials `PTBK_RELAYS`. */
    readonly withDashboard: boolean;
    readonly links: readonly RelayLink[];
    readonly certificateNotAfter: string | null;
    readonly uiVersion: string | null;
    readonly updatePolicy: UpdatePolicy;
    readonly ownerSetUp: boolean;
    readonly heartbeat: HeartbeatStatus | null;
    readonly addressGaps: readonly AddressGap[];
}

/** One screen of what the operator may see: no key, secret, token or content, so it is safe to paste into a ticket. */
export function engineStatus(input: EngineStatusInput): OperatorStatus {
    const beat = input.heartbeat;
    return {
        engineId: input.engineId,
        hostname: input.hostname,
        fingerprint: deriveEngineFingerprint(input.engineId).formatted,
        version: input.version,
        mode: input.withDashboard && input.registration === null ? 'local' : 'tunnel',
        dashboardUrl: input.registration?.dashboardUrl ?? null,
        relays: input.links.map((link) => ({ relay: link.relay.relayId, state: relayStateOf(link.state()) })),
        certificate: input.certificateNotAfter === null ? null : { notAfter: input.certificateNotAfter },
        ui: input.uiVersion === null ? null : { version: input.uiVersion },
        updatePolicy: input.updatePolicy.kind,
        ownerSetUp: input.ownerSetUp,
        heartbeat:
            beat?.lastHeartbeat == null
                ? null
                : {
                      sentAt: beat.lastHeartbeat.sentAt,
                      answer: beat.lastAnswer?.kind ?? null,
                      status: beat.lastAnswer?.status ?? null,
                      clockSkewS: beat.clockSkew?.seconds ?? null,
                  },
        addressGaps: [...input.addressGaps],
    };
}
