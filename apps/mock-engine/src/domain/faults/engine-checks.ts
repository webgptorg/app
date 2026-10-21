import type { EngineChecks } from '@ptbk/engine-api/in-memory';

import type { SeededSequence } from '../state/seed-random';
import type { FaultPlan } from './fault-plan';

/**
 * The virus scan and connection test the core asks for, faked from the fault plan: with no faults every file is clean
 * and every connection works. Each check draws from its own seeded sequence, so one never shifts the other.
 */
export function createEngineChecks(deps: {
    readonly faults: () => FaultPlan;
    readonly scans: SeededSequence;
    readonly probes: SeededSequence;
}): EngineChecks {
    return {
        scanFile: () => (deps.scans.chance(deps.faults().scanInfectedRate) ? 'infected' : 'clean'),
        probeIntegration(integration) {
            if (!deps.probes.chance(deps.faults().integrationErrorRate)) return { status: 'connected' };
            const target =
                integration.kind === 'mcp-server'
                    ? new URL(integration.config.url).hostname
                    : integration.kind === 'repository'
                      ? 'api.github.com'
                      : integration.config.provider;
            return { status: 'error', statusDetail: `Connection to ${target} timed out after 10 s.` };
        },
    };
}
