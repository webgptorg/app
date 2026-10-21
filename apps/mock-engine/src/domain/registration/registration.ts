import type { EngineId, Hostname } from '@ptbk/protocol';

/** The engine's identity as the dashboard confirmed it, and where it registered. */
export interface Registration {
    /** The dashboard's origin, `https://…`; heartbeats go there too. */
    readonly dashboardUrl: string;
    readonly engineId: EngineId;
    /** `<engineId>.<engine domain>`. */
    readonly hostname: Hostname;
    /** The relays to dial, 1 to `MAX_RELAYS`. */
    readonly relays: readonly Hostname[];
}

export interface RegistrationStore {
    /** Null when the engine has never registered. */
    load(): Promise<Registration | null>;
    save(registration: Registration): Promise<void>;
}
