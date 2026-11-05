import { z } from 'zod';

/** Every problem code with the HTTP status it is always sent with. */
export const PROBLEM_STATUS = {
    'validation-failed': 400,
    'invalid-cursor': 400,
    unauthenticated: 401,
    'step-up-required': 401,
    forbidden: 403,
    'not-found': 404,
    /** The engine does not advertise the capability this route belongs to. */
    'capability-not-supported': 404,
    'agent-deleted': 409,
    /** The agent is a `system` agent, defined by the engine (Expert): it cannot be changed, deleted or restored. */
    'agent-engine-owned': 409,
    'revision-conflict': 409,
    'folder-not-empty': 409,
    'name-taken': 409,
    /** The Wallet is not set up or not unlocked on the server; that is fixed there, not through the API. */
    'wallet-not-ready': 409,
    /** The Wallet request moved to another step since the client showed it. */
    'wallet-request-moved': 409,
    'last-passkey': 409,
    /** Removing or demoting the engine's last owner would leave nobody to manage it. */
    'last-owner': 409,
    'reply-finished': 409,
    /** A new thread names no agent and the engine has no usable Chatter to start it with. */
    'chatter-missing': 409,
    /** A `requestKey` already used for a different request. */
    'request-key-reused': 409,
    cancelled: 409,
    'run-finished': 409,
    'run-not-retryable': 409,
    'trigger-ended': 409,
    'file-infected': 409,
    /** The answer is to an onboarding prompt the engine has moved past; read the state again. */
    'onboarding-prompt-stale': 409,
    'payload-too-large': 413,
    'unsupported-media-type': 415,
    'invalid-book': 422,
    /** The code typed to approve an access request is not the one shown to the person asking. */
    'access-code-mismatch': 422,
    'invalid-schedule': 422,
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
