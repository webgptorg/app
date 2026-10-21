import type { UpdateState } from '@ptbk/protocol';

/** What the heartbeat reports from the engine's own state: counts only, never names. */
export interface EngineStatsSource {
    counts(): { readonly agents: number; readonly members: number };
    updateState(): UpdateState;
}
