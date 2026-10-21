import { Integration } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { createSeededSequence } from '../state/seed-random';
import { createEngineChecks } from './engine-checks';
import { FaultPlan } from './fault-plan';

const base = {
    id: 'integration-1',
    agentId: null,
    name: 'X',
    status: 'connected',
    statusDetail: null,
    scopes: [],
    secretRefs: [],
    tools: [],
    lastActivityAt: null,
    createdBy: 'member-1',
    createdAt: '2026-10-01T00:00:00Z',
    updatedAt: '2026-10-01T00:00:00Z',
};

function checks(faults: Partial<FaultPlan>) {
    return createEngineChecks({
        faults: () => FaultPlan.parse(faults),
        scans: createSeededSequence(1),
        probes: createSeededSequence(2),
    });
}

describe('createEngineChecks', () => {
    it('finds every file clean and every connection working without faults', () => {
        const none = checks({});
        const file = { name: 'a.txt', contentType: 'text/plain', sizeBytes: 1, purpose: 'upload' } as const;
        expect(Array.from({ length: 50 }, () => none.scanFile(file))).toEqual(Array(50).fill('clean'));
        const mcp = Integration.parse({ ...base, kind: 'mcp-server', config: { url: 'https://mcp.example.com/' } });
        expect(none.probeIntegration(mcp)).toEqual({ status: 'connected' });
    });

    it('names what could not be reached for each kind of integration', () => {
        const failing = checks({ integrationErrorRate: 1, scanInfectedRate: 1 });
        const kinds = [
            [{ kind: 'mcp-server', config: { url: 'https://mcp.example.com/sse' } }, 'mcp.example.com'],
            [{ kind: 'repository', config: { provider: 'github', repository: 'acme/site' } }, 'api.github.com'],
            [{ kind: 'calendar', config: { provider: 'google', account: 'team@acme.example' } }, 'google'],
        ] as const;
        for (const [fields, target] of kinds) {
            expect(failing.probeIntegration(Integration.parse({ ...base, ...fields }))).toEqual({
                status: 'error',
                statusDetail: `Connection to ${target} timed out after 10 s.`,
            });
        }
        expect(failing.scanFile({ name: 'a', contentType: 'text/plain', sizeBytes: 1, purpose: 'upload' })).toBe(
            'infected',
        );
    });
});
