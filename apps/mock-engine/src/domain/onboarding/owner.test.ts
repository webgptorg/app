import type { Member, Passkey } from '@ptbk/engine-api';
import { Member as MemberSchema, Passkey as PasskeySchema } from '@ptbk/engine-api';
import { describe, expect, it } from 'vitest';

import { addressGaps } from './address';
import { hasOwner, membersWhoCanSignIn } from './owner';

const AT = '2026-10-26T10:00:00Z';

function member(id: string, role: Member['role'], status: Member['status'] = 'active'): Member {
    return MemberSchema.parse({ id, displayName: id, role, status, createdAt: AT, lastSeenAt: null });
}

function passkey(id: string, memberId: string): Passkey {
    return PasskeySchema.parse({ id, memberId, name: 'Laptop', createdAt: AT, lastUsedAt: null, authenticator: null });
}

describe('owner state', () => {
    const owner = member('member-owner', 'owner');
    const ada = member('member-ada', 'member');
    const gone = member('member-gone', 'admin', 'disabled');

    it('counts active members with a passkey, and the owner only once it holds one', () => {
        expect(membersWhoCanSignIn({ members: [owner, ada], passkeys: [] })).toBe(0);
        expect(hasOwner({ members: [owner, ada], passkeys: [] })).toBe(false);
        const passkeys = [passkey('passkey-1', 'member-ada'), passkey('passkey-2', 'member-gone')];
        expect(membersWhoCanSignIn({ members: [owner, ada, gone], passkeys })).toBe(1);
        expect(hasOwner({ members: [owner, ada, gone], passkeys })).toBe(false);
        const withOwner = [...passkeys, passkey('passkey-3', 'member-owner'), passkey('passkey-4', 'member-owner')];
        expect(membersWhoCanSignIn({ members: [owner, ada, gone], passkeys: withOwner })).toBe(2);
        expect(hasOwner({ members: [owner, ada, gone], passkeys: withOwner })).toBe(true);
    });
});

describe('addressGaps', () => {
    it('names what the address still needs', () => {
        const served = { setupPageServed: true };
        expect(addressGaps({ relaysReady: 0, certificateValid: false, setupPageServed: false })).toEqual([
            'relay',
            'certificate',
            'setup-page',
        ]);
        expect(addressGaps({ relaysReady: 2, certificateValid: false, ...served })).toEqual(['certificate']);
        expect(addressGaps({ relaysReady: 0, certificateValid: true, ...served })).toEqual(['relay']);
        expect(addressGaps({ relaysReady: 1, certificateValid: true, ...served })).toEqual([]);
    });
});
