import { z } from 'zod';

/** Codes any `/api` endpoint may answer besides its own; the client treats every other code as a contract breach. */
export const COMMON_PROBLEM_CODES = [
    'invalid-request',
    'unauthorized',
    'forbidden',
    'not-found',
    'rate-limited',
    'too-large',
    'internal',
    // Authorization outcomes the SPA reacts to: run the step-up ceremony, or explain the recovery cooldown.
    'step-up-required',
    'recovery-cooldown',
] as const;
export type CommonProblemCode = (typeof COMMON_PROBLEM_CODES)[number];

/** RFC 9457 problem details with a stable machine-readable `code`; never a stack trace or an echo of the input. */
export const problemSchema = z.strictObject({
    type: z.string(),
    title: z.string(),
    status: z.number().int().min(400).max(599),
    code: z.string().regex(/^[a-z][a-z0-9-]*$/),
    detail: z.string().optional(),
    /** On 500 only: quote it to support, who find the logged error by it. */
    correlationId: z.string().max(64).optional(),
    /** On a stale heartbeat timestamp only (C-03): the dashboard's clock, so the engine can show its skew. */
    serverTime: z.string().max(64).optional(),
});
export type Problem = z.infer<typeof problemSchema>;

export const PROBLEM_CONTENT_TYPE = 'application/problem+json';
