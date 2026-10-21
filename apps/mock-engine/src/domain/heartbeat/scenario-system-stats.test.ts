import { describe, expect, it } from 'vitest';

import type { Scenario } from '../state/scenarios';
import { createScenarioSystemStats } from './scenario-system-stats';

describe('createScenarioSystemStats', () => {
    it('reports fixed figures per scenario', async () => {
        expect(await createScenarioSystemStats(() => 'empty').sample()).toEqual({
            diskPct: 10,
            ramPct: 20,
            cpuLoad: 'low',
        });
        expect(await createScenarioSystemStats(() => 'small-team').sample()).toEqual({
            diskPct: 40,
            ramPct: 50,
            cpuLoad: 'medium',
        });
        expect(await createScenarioSystemStats(() => 'large-fleet').sample()).toEqual({
            diskPct: 70,
            ramPct: 80,
            cpuLoad: 'high',
        });
    });

    it('follows the current scenario on every sample', async () => {
        let scenario: Scenario = 'empty';
        const stats = createScenarioSystemStats(() => scenario);
        expect((await stats.sample()).cpuLoad).toBe('low');
        scenario = 'large-fleet';
        expect((await stats.sample()).cpuLoad).toBe('high');
    });
});
