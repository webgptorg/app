import { Hostname } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { relayTargetOf } from './relay-target';

describe('relayTargetOf', () => {
    it('dials a listed relay on the default port at the tunnel path', () => {
        const target = relayTargetOf(Hostname.parse('relay-a.ptbk.test'));
        expect(target).toEqual({ url: 'wss://relay-a.ptbk.test/v1/tunnel', relayId: 'relay-a.ptbk.test', port: 443 });
        expect(Object.isFrozen(target)).toBe(true);
    });
});
