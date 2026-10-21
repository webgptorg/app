import type { MockEngineConfig } from '../app/config';
import { NO_FAULTS } from '../domain/faults/fault-plan';

/** The M-04, M-05 and M-06 settings at their defaults, for tests that build a `MockEngineConfig` by hand. */
export const DEFAULT_MOCK_SETTINGS: Pick<
    MockEngineConfig,
    'seed' | 'scenario' | 'seedEpoch' | 'faults' | 'devLogin' | 'control' | 'dashboard' | 'stats' | 'ui'
> = Object.freeze({
    seed: 1,
    scenario: 'small-team',
    seedEpoch: new Date('2026-10-01T00:00:00Z'),
    faults: NO_FAULTS,
    devLogin: false,
    control: null,
    dashboard: null,
    stats: 'os',
    ui: null,
});
