import { describe, expect, it } from 'vitest';

import type { EngineView } from '../../../shared/api/routes';
import { engineView } from '../../testing/fixtures';
import { byAttention, isRevoked, reportsLive } from './engine-order';

function withStatus(id: string, status: EngineView['status'], suspendedBy: EngineView['suspendedBy'] = null) {
    return engineView({ engineId: id.repeat(26) as EngineView['engineId'], status, suspendedBy });
}

describe('engine order', () => {
    it('puts outages first and finished engines last, keeping the API order within a status', () => {
        const engines = [
            withStatus('a', 'suspended', 'owner'),
            withStatus('b', 'online'),
            withStatus('c', 'never-seen'),
            withStatus('d', 'offline'),
            withStatus('e', 'owner-pending'),
            withStatus('f', 'online'),
            withStatus('g', 'unknown'),
        ];
        expect(byAttention(engines).map((engine) => engine.engineId.charAt(0))).toEqual([
            'd',
            'g',
            'e',
            'b',
            'f',
            'c',
            'a',
        ]);
        expect(engines[0]?.engineId.charAt(0)).toBe('a');
    });

    it('tells revoked engines and live reports apart', () => {
        expect(isRevoked(withStatus('a', 'suspended', 'owner'))).toBe(true);
        expect(isRevoked(withStatus('a', 'suspended', 'platform'))).toBe(false);
        expect(['online', 'owner-pending'].every((status) => reportsLive({ status } as EngineView))).toBe(true);
        expect(
            (['offline', 'unknown', 'never-seen', 'suspended'] as const).some((status) => reportsLive({ status })),
        ).toBe(false);
    });
});
