import { z } from 'zod';

/** Every problem code with the HTTP status it is always sent with. */
export const PROBLEM_STATUS = {
    'validation-failed': 400,
    'invalid-cursor': 400,
    unauthenticated: 401,
    'step-up-required': 401,
    forbidden: 403,
    'not-found': 404,
    'agent-deleted': 409,
    'revision-conflict': 409,
    'folder-not-empty': 409,
    'name-taken': 409,
    'secret-revoked': 409,
    'last-passkey': 409,
    'reply-finished': 409,
    cancelled: 409,
    'payload-too-large': 413,
    'unsupported-media-type': 415,
    'invalid-book': 422,
    'rate-limited': 429,
    'internal-error': 500,
    'reply-failed': 502,
    unavailable: 503,
} as const satisfies Record<string, number>;

export type ProblemCode = keyof typeof PROBLEM_STATUS;
export const PROBLEM_CODES = Object.keys(PROBLEM_STATUS) as readonly ProblemCode[];
export const ProblemCode = z.enum(PROBLEM_CODES as [ProblemCode, ...ProblemCode[]]);

const PROBLEM_TYPE_BASE = 'https://ptbk.io/problems/';

/** The RFC 9457 `type` URI for a code. It identifies the problem; clients branch on `code`, never on `type`. */
export function problemType(code: ProblemCode): string {
    return `${PROBLEM_TYPE_BASE}${code}`;
}
