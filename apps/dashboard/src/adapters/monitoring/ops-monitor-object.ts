import { DurableObject } from 'cloudflare:workers';

import { monitorStateSchema } from '../../domain/monitoring/alert-rules';
import type { JobRun, MonitorObservation } from '../../domain/monitoring/alert-rules';
import type { MonitorStateStorage, MonitorStore } from '../../domain/monitoring/monitor-store';

const STATE_KEY = 'state';

function durableObjectStorage(storage: DurableObjectStorage): MonitorStateStorage {
    return {
        async load() {
            const value = await storage.get(STATE_KEY);
            // A state this version cannot read starts over: the next minute rebuilds it.
            const parsed = monitorStateSchema.safeParse(value);
            return parsed.success ? parsed.data : null;
        },
        async save(state) {
            await storage.put(STATE_KEY, state);
        },
    };
}

/**
 * The one monitor (I-04): alert state across monitoring runs and job failure streaks. The Worker entry subclasses it
 * to say how the service is built, as for `EngineStatusObject`.
 */
export class OpsMonitorObject extends DurableObject<Env> {
    readonly #build: (storage: MonitorStateStorage) => MonitorStore;
    #service: MonitorStore | undefined;

    constructor(ctx: DurableObjectState, env: Env, build: (storage: MonitorStateStorage) => MonitorStore) {
        super(ctx, env);
        this.#build = build;
    }

    #get(): MonitorStore {
        this.#service ??= this.#build(durableObjectStorage(this.ctx.storage));
        return this.#service;
    }

    observe(observation: MonitorObservation) {
        return this.#get().observe(observation);
    }

    recordJobRun(run: JobRun) {
        return this.#get().recordJobRun(run);
    }
}
