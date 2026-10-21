import { Hostname } from '@ptbk/protocol';
import { describe, expect, it } from 'vitest';

import { secret } from '../secret';
import { createAcmeChallenges } from './acme-challenges';

const HOST = Hostname.parse('a.engine.test');
const credentials = (label: string) => ({ certificateChainPem: label, privateKeyPem: secret(label) });

describe('ACME challenges', () => {
    it('holds a challenge until its registration is removed', () => {
        const challenges = createAcmeChallenges();
        const first = credentials('first');
        const remove = challenges.register(HOST, first);
        expect(challenges.lookup(HOST)).toBe(first);
        expect(challenges.lookup(Hostname.parse('b.engine.test'))).toBeUndefined();
        remove();
        expect(challenges.lookup(HOST)).toBeUndefined();
    });

    it('lets a stale removal leave a newer registration for the same name alone', () => {
        const challenges = createAcmeChallenges();
        const removeFirst = challenges.register(HOST, credentials('first'));
        const second = credentials('second');
        challenges.register(HOST, second);
        removeFirst();
        expect(challenges.lookup(HOST)).toBe(second);
    });
});
