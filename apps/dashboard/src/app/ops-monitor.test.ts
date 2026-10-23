import { describe, expect, it } from 'vitest';

import type { MonitorState } from '../domain/monitoring/alert-rules';
import { TEST_PLANS } from '../testing/billing-fixtures';
import { DEV_RATE_LIMIT_HMAC_KEY } from './config';
import { createOpsMonitor } from './ops-monitor';

const vars = {
    ENVIRONMENT: 'dev',
    DASHBOARD_ORIGIN: 'http://localhost:5173',
    ENGINE_DOMAIN: 'engines.ptbk.test',
    RELAYS: [{ relayId: 'relay.ptbk.test', region: 'local' }],
    INSTALL_COMMAND: 'bun run dev:link {linkCode}',
    ADAPTERS: { email: 'fake', billing: 'fake', rateLimit: 'memory' },
    EMAIL_FROM: 'no-reply@ptbk.test',
    RATE_LIMIT_HMAC_KEY: DEV_RATE_LIMIT_HMAC_KEY,
    BILLING_PLANS: TEST_PLANS,
};

function storage() {
    let state: MonitorState | null = null;
    return {
        load: () => Promise.resolve(state),
        save: (next: MonitorState) => {
            state = next;
            return Promise.resolve();
        },
    };
}

describe('createOpsMonitor', () => {
    it('uses the default thresholds without MONITORING, and the configured ones with it', async () => {
        const defaults = createOpsMonitor(vars as unknown as Env, storage());
        const failed = (at: number) => ({ job: 'relay-monitor', outcome: 'failed', at }) as const;
        expect(await defaults.recordJobRun(failed(1))).toEqual([]);
        const strict = createOpsMonitor(
            {
                ...vars,
                MONITORING: { opsEmail: 'ops@ptbk.test', thresholds: { cronFailures: 1 } },
                RELAY_METRICS_TOKENS: JSON.stringify({ 'relay.ptbk.test': `ptbk_mt_${'q'.repeat(43)}` }),
            } as unknown as Env,
            storage(),
        );
        expect(await strict.recordJobRun(failed(1))).toMatchObject([{ rule: 'cron-job-failing', state: 'firing' }]);
    });
});
