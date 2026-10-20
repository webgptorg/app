import type { MockEngineConfig } from '../app/config';
import { NO_FAULTS } from '../domain/faults/fault-plan';

/** The M-04 settings at their defaults, for tests that build a `MockEngineConfig` by hand. */
export const DEFAULT_MOCK_SETTINGS: Pick<
    MockEngineConfig,
    'seed' | 'scenario' | 'seedEpoch' | 'faults' | 'devLogin' | 'control'
> = Object.freeze({
    seed: 1,
    scenario: 'small-team',
    seedEpoch: new Date('2026-10-01T00:00:00Z'),
    faults: NO_FAULTS,
    devLogin: false,
    control: null,
});
