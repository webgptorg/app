import { z } from 'zod';

import { Timestamp } from './ids';

export const PROBLEM_DETAILS_MAX_BYTES = 8192;

const shape = {
    type: z.string().min(1).max(2048),
    title: z.string().min(1).max(256),
    status: z.int().min(400).max(599),
    detail: z.string().max(4096).optional(),
    code: z
        .string()
        .max(64)
        .regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),
    /** Only on a stale heartbeat timestamp: the dashboard's clock, so the engine can show its skew. */
    serverTime: Timestamp.optional(),
};

/**
 * RFC 9457 problem details for dashboard API errors, as the dashboard sends them. Same shape as engine-api's (C-04),
 * defined again because `engine-api` and `protocol` never import each other. `code` is a stable token, open so that
 * every dashboard route can add its own; the registration codes are `REGISTRATION_ERROR_CODE`.
 */
export const ProblemDetails = z.strictObject(shape);
export type ProblemDetails = z.infer<typeof ProblemDetails>;

/** What the engine parses a dashboard problem with: known members validated, unknown ones stripped (ADR 0010 §3). */
export const TolerantProblemDetails = z.object(shape);

/**
 * Registration failures. `invalid-link-code` covers a bad, expired and used code alike, so the dashboard is no oracle.
 * `engine-exists` (409): the engine ID derived from the key belongs to another organisation. `engine-suspended` (403):
 * the engine is suspended or owner-revoked.
 */
export const REGISTRATION_ERROR_CODE = Object.freeze({
    invalidLinkCode: 'invalid-link-code',
    engineExists: 'engine-exists',
    engineSuspended: 'engine-suspended',
    engineLimit: 'engine-limit',
    badSignature: 'bad-signature',
} as const);

export type RegistrationErrorCode = (typeof REGISTRATION_ERROR_CODE)[keyof typeof REGISTRATION_ERROR_CODE];
