import { describe, expect, it } from 'vitest';

import { relayIdsFor, relaysOverride } from './tunnel-relay';

describe('relaysOverride', () => {
    it('lists every relay as wss://<relay hostname>:<port>, without a path', () => {
        const relayIds = relayIdsFor(2);
        expect(relaysOverride({ relayIds, port: 4443 })).toBe(
            `wss://${relayIds[0] ?? ''}:4443,wss://${relayIds[1] ?? ''}:4443`,
        );
    });
});
