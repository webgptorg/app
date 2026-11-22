import type { MockEngineConfig } from '../app/config';
import { NO_FAULTS } from '../domain/faults/fault-plan';
import { FULL_CAPABILITY_NAMES } from '../domain/state/capabilities';

/**
 * The M-04 to M-07 settings at their defaults, for tests that build a `MockEngineConfig` by hand; the simulation is
 * paused there, so nothing happens on its own during a test.
 */
export const DEFAULT_MOCK_SETTINGS: Pick<
    MockEngineConfig,
    | 'seed'
    | 'scenario'
    | 'seedEpoch'
    | 'faults'
    | 'capabilities'
    | 'simulation'
    | 'devLogin'
    | 'passkeys'
    | 'onboarding'
    | 'liveBrowser'
    | 'control'
    | 'dashboard'
    | 'stats'
    | 'ui'
> = Object.freeze({
    seed: 1,
    scenario: 'small-team',
    seedEpoch: new Date('2026-10-01T00:00:00Z'),
    faults: NO_FAULTS,
    capabilities: FULL_CAPABILITY_NAMES,
    simulation: { mode: 'paused' as const, speed: 1 },
    devLogin: false,
    passkeys: 'seeded',
    onboarding: null,
    liveBrowser: false,
    control: null,
    dashboard: null,
    stats: 'os',
    ui: null,
});
