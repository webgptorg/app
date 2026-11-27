import { defaultHostname } from '@ptbk/protocol';

import { createConsoleLogger } from '../adapters/console-logger';
import { createDatabase } from '../adapters/db/client';
import { createD1AlertRecipients, createD1HeartbeatEngineReader } from '../adapters/db/d1-status-store';
import { createD1UsageStore } from '../adapters/db/d1-usage-store';
import { cryptoRandom } from '../adapters/crypto-random';
import { systemClock } from '../adapters/system-clock';
import { createEngineStatusService, type EngineStatusService } from '../domain/status/engine-status-service';
import type { EngineStatusStorage } from '../domain/status/engine-status-storage';
import { createUsageRecorder } from '../domain/usage/usage-recorder';
import { parseConfig } from './config';
import { dashboardMetrics, emailSender } from './create-dashboard';
import type { DevAdapters } from './dev-adapters';

/**
 * The composition root of one engine's status object. Throws on a configuration the Worker would refuse too, so the
 * call fails (and an alarm retries) instead of running on unvalidated settings.
 */
export function createEngineStatus(env: Env, storage: EngineStatusStorage, dev: DevAdapters): EngineStatusService {
    const config = parseConfig(env);
    const metrics = dashboardMetrics(env, config, dev);
    const email = emailSender(env, config, dev, metrics);
    if (email === null) {
        throw new Error('engine status: the email binding is missing');
    }
    const db = createDatabase(env.DB);
    const logger = createConsoleLogger({ service: 'dashboard', environment: config.environment });
    const service = createEngineStatusService({
        storage,
        clock: systemClock,
        logger,
        timing: config.heartbeat,
        heartbeatEngines: createD1HeartbeatEngineReader(db),
        recipients: createD1AlertRecipients(db),
        email: email.email,
        engineHostname: (engineId) => defaultHostname(engineId, config.engineDomain),
        engineLink: (engineId) => `${config.dashboardOrigin}/engines/${engineId}`,
        usage: createUsageRecorder({ store: createD1UsageStore(db), clock: systemClock, random: cryptoRandom, logger }),
    });
    return {
        ...service,
        alarm() {
            metrics.record({ name: 'ptbk_dashboard_alarms_total', object: 'engine-status' });
            return service.alarm();
        },
    };
}
