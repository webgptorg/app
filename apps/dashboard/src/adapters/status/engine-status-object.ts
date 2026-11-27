import { DurableObject } from 'cloudflare:workers';

import { storedEngineStatusSchema } from '../../domain/status/engine-status';
import type { RecordHeartbeatInput } from '../../domain/status/engine-status-directory';
import type { EngineStatusService } from '../../domain/status/engine-status-service';
import type { EngineStatusStorage } from '../../domain/status/engine-status-storage';

const STATUS_KEY = 'status';

function durableObjectStorage(storage: DurableObjectStorage): EngineStatusStorage {
    return {
        async load() {
            const value = await storage.get(STATUS_KEY);
            return value === undefined ? null : storedEngineStatusSchema.parse(value);
        },
        async save(status) {
            await storage.put(STATUS_KEY, status);
        },
        async setAlarm(at) {
            await storage.setAlarm(at);
        },
        async deleteAll() {
            await storage.deleteAlarm();
            await storage.deleteAll();
        },
    };
}

/**
 * One engine's status (D-05), named by its engine ID. The Worker entry subclasses it to say how the service is built,
 * since only the entry holds the dev adapters; everything else lives in the domain service.
 */
export class EngineStatusObject extends DurableObject<Env> {
    readonly #build: (storage: EngineStatusStorage) => EngineStatusService;
    #service: EngineStatusService | undefined;

    constructor(ctx: DurableObjectState, env: Env, build: (storage: EngineStatusStorage) => EngineStatusService) {
        super(ctx, env);
        this.#build = build;
    }

    // Built on first use rather than in the constructor: a configuration error then fails the call, not the object.
    #get(): EngineStatusService {
        this.#service ??= this.#build(durableObjectStorage(this.ctx.storage));
        return this.#service;
    }

    recordHeartbeat(input: RecordHeartbeatInput) {
        return this.#get().recordHeartbeat(input);
    }

    getStatus() {
        return this.#get().getStatus();
    }

    getActivity() {
        return this.#get().getActivity();
    }

    reset() {
        return this.#get().reset();
    }

    override alarm() {
        return this.#get().alarm();
    }
}
