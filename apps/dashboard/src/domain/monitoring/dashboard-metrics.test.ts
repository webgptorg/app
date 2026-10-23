import type { HeartbeatIngestOutcome } from '../status/ingest-heartbeat';
import type { RegisterOutcome } from '../registration/register-engine';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { EMAIL_OUTCOMES, HEARTBEAT_OUTCOMES, JOB_OUTCOMES, REGISTRATION_OUTCOMES } from './dashboard-metrics';

describe('dashboard metric outcomes', () => {
    it('list every outcome of the operations they count, once', () => {
        expectTypeOf<(typeof HEARTBEAT_OUTCOMES)[number]>().toEqualTypeOf<HeartbeatIngestOutcome['kind']>();
        expectTypeOf<(typeof REGISTRATION_OUTCOMES)[number]>().toEqualTypeOf<RegisterOutcome['kind']>();
        for (const list of [HEARTBEAT_OUTCOMES, REGISTRATION_OUTCOMES, EMAIL_OUTCOMES, JOB_OUTCOMES]) {
            expect(new Set<string>(list).size).toBe(list.length);
        }
    });
});
