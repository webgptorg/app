import { z } from 'zod';

import { encodeBase32Lower } from './base32';
import type { Random } from './random';

export const LINK_CODE_BYTES = 16;

/**
 * 128 random bits as lowercase RFC 4648 base32 without padding: 26 characters, the last carrying 3 bits and 2 zero
 * trailing bits (so only `a e i m q u y 4` can end a code). One accepted spelling per code; no separators, because the
 * code is copied, not typed. A secret: the dashboard stores only its SHA-256 (ADR 0014).
 */
export const LinkCode = z
    .string()
    .regex(/^[a-z2-7]{25}[aeimquy4]$/)
    .brand<'LinkCode'>();
export type LinkCode = z.infer<typeof LinkCode>;

export function generateLinkCode(random: Random): LinkCode {
    return LinkCode.parse(encodeBase32Lower(random.bytes(LINK_CODE_BYTES)));
}
