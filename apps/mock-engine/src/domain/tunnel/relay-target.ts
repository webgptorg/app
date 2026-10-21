import type { Hostname, RelayId } from '@ptbk/protocol';
import { RelayId as RelayIdSchema, TUNNEL_PATH } from '@ptbk/protocol';

/** One relay from the engine's list. `relayId` comes from our own configuration, never from the relay. */
export interface RelayTarget {
    /** `wss://<relayId>[:port]/v1/tunnel`, normalised; safe to log (relay URLs never carry credentials). */
    readonly url: string;
    readonly relayId: RelayId;
    readonly port: number;
}

/** A relay the dashboard listed: its hostname on the default port, as the engine dials it. */
export function relayTargetOf(hostname: Hostname): RelayTarget {
    return Object.freeze({ url: `wss://${hostname}${TUNNEL_PATH}`, relayId: RelayIdSchema.parse(hostname), port: 443 });
}
