import { z } from 'zod';

import type { Random } from './ports/random';

const ID_PATTERN = /^[a-z2-7]{26}$/;
const BASE32_ALPHABET = 'abcdefghijklmnopqrstuvwxyz234567';

export const orgIdSchema = z.string().regex(ID_PATTERN).brand<'OrgId'>();
export type OrgId = z.infer<typeof orgIdSchema>;

export const userIdSchema = z.string().regex(ID_PATTERN).brand<'UserId'>();
export type UserId = z.infer<typeof userIdSchema>;

/** A `relay_tokens` row, never the token itself: what logs and `--revoke` name. */
export const relayTokenIdSchema = z.string().regex(ID_PATTERN).brand<'RelayTokenId'>();
export type RelayTokenId = z.infer<typeof relayTokenIdSchema>;

/** 128 random bits as 26 characters of lowercase RFC 4648 base32 without padding. */
function randomId(random: Random): string {
    let bits = 0;
    let value = 0;
    let out = '';
    for (const byte of random.bytes(16)) {
        value = (value << 8) | byte;
        bits += 8;
        while (bits >= 5) {
            out += BASE32_ALPHABET.charAt((value >>> (bits - 5)) & 31);
            bits -= 5;
        }
    }
    return out + BASE32_ALPHABET.charAt((value << (5 - bits)) & 31);
}

export function newOrgId(random: Random): OrgId {
    return orgIdSchema.parse(randomId(random));
}

export function newUserId(random: Random): UserId {
    return userIdSchema.parse(randomId(random));
}

export function newRelayTokenId(random: Random): RelayTokenId {
    return relayTokenIdSchema.parse(randomId(random));
}

/** An `admin_audit_log` row. */
export function newAdminAuditEntryId(random: Random): string {
    return randomId(random);
}
