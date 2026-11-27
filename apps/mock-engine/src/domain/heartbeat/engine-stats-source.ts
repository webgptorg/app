import type { SetupState, UpdateState } from '@ptbk/protocol';

/** What the heartbeat reports from the engine's own state: counts only, never names. */
export interface EngineStatsSource {
    counts(): { readonly agents: number; readonly members: number };
    updateState(): UpdateState;
    /** Whether the engine's browser setup (`onboarding@1`) is finished; `null` without one, so the beat leaves it out. */
    setup(): SetupState | null;
}
