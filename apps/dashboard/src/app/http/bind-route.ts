import type { Context, Hono } from 'hono';
import type { z } from 'zod';

import type { ParsedRouteInput, RouteContract, RouteErrorCode, RouteResponse } from '../../shared/api/contract';
import type { CommonProblemCode } from '../../shared/api/problem';
import { problemResponse, type ProblemStatus } from './problem';

export type RouteResult<C extends RouteContract> =
    | { readonly kind: 'ok'; readonly body: RouteResponse<C> }
    | {
          readonly kind: 'problem';
          readonly status: ProblemStatus;
          readonly code: RouteErrorCode<C> | CommonProblemCode;
      };

export type RouteHandler<C extends RouteContract> = (
    input: ParsedRouteInput<C>,
    signal: AbortSignal,
) => Promise<RouteResult<C>>;

type ParseOutcome = { readonly kind: 'ok'; readonly value: unknown } | { readonly kind: 'invalid' };

function parseWith(schema: z.ZodType | null, value: unknown): ParseOutcome {
    if (schema === null) {
        return { kind: 'ok', value: undefined };
    }
    const result = schema.safeParse(value);
    return result.success ? { kind: 'ok', value: result.data } : { kind: 'invalid' };
}

async function readJson(context: Context): Promise<ParseOutcome> {
    try {
        return { kind: 'ok', value: await context.req.json() };
    } catch {
        return { kind: 'invalid' };
    }
}

/**
 * Registers a contract on a router mounted at `mountPath`. Params, query and body are validated with the contract's
 * strict schemas before the handler runs; a mismatch is a 400 problem that does not echo the input.
 */
export function bindRoute<C extends RouteContract>(
    router: Hono,
    mountPath: string,
    contract: C,
    handler: RouteHandler<C>,
): void {
    const path = contract.path.slice(mountPath.length);
    router.on(contract.method, path, async (context) => {
        const params = parseWith(contract.params, context.req.param());
        const query = parseWith(contract.query, context.req.query());
        const rawBody: ParseOutcome =
            contract.body === null ? { kind: 'ok', value: undefined } : await readJson(context);
        const body = rawBody.kind === 'ok' ? parseWith(contract.body, rawBody.value) : rawBody;
        if (params.kind === 'invalid' || query.kind === 'invalid' || body.kind === 'invalid') {
            return problemResponse(400, 'invalid-request');
        }
        // The schemas above are the contract's own, so the parsed values have the contract's types.
        const input = { params: params.value, query: query.value, body: body.value } as ParsedRouteInput<C>;
        const result = await handler(input, context.req.raw.signal);
        switch (result.kind) {
            case 'ok':
                return context.json(result.body as unknown as object, 200);
            case 'problem':
                return problemResponse(result.status, result.code);
        }
    });
}
