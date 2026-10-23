import { describe, expect, it } from 'vitest';

import { ALERT_RULES } from './alert-rules';
import { alertRoute } from './alert-routes';

describe('alertRoute', () => {
    it('sends the abuse jobs’ alerts to the abuse inbox and everything else to ops', () => {
        expect(ALERT_RULES.filter((rule) => alertRoute(rule) === 'abuse')).toEqual([
            'ct-wildcard',
            'ct-foreign-issuer',
            'ct-unknown-hostname',
            'ct-issuance-spike',
            'public-face-mismatch',
            'abuse-feed-listed',
        ]);
        expect(alertRoute('cron-job-failing')).toBe('ops');
        expect(alertRoute('no-such-rule')).toBe('ops');
        expect(alertRoute('toString')).toBe('ops');
    });
});
