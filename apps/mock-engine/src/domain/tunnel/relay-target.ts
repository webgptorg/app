import type { RelayId } from '@ptbk/protocol';

/** One relay from the engine's list. `relayId` comes from our own configuration, never from the relay. */
export interface RelayTarget {
    /** `wss://<relayId>[:port]/v1/tunnel`, normalised; safe to log (relay URLs never carry credentials). */
    readonly url: string;
    readonly relayId: RelayId;
    readonly port: number;
}
