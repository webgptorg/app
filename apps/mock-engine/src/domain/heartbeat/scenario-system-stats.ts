import type { Scenario } from '../state/scenarios';
import type { SystemStats, SystemStatsSample } from './system-stats';

const SCENARIO_STATS: Readonly<Record<Scenario, SystemStatsSample>> = Object.freeze({
    empty: Object.freeze({ diskPct: 10, ramPct: 20, cpuLoad: 'low' }),
    'small-team': Object.freeze({ diskPct: 40, ramPct: 50, cpuLoad: 'medium' }),
    'large-fleet': Object.freeze({ diskPct: 70, ramPct: 80, cpuLoad: 'high' }),
});

/**
 * `MOCK_STATS=scenario`: fixed figures per scenario instead of the host's, so e2e can assert exact values on the
 * dashboard. Read on every beat, so `/__mock/reset` to another scenario changes them too.
 */
export function createScenarioSystemStats(scenario: () => Scenario): SystemStats {
    return { sample: () => Promise.resolve(SCENARIO_STATS[scenario()]) };
}
